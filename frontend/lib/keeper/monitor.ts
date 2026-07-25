import "server-only";
import type { Abi, Address } from "viem";
import type { ChainRuntime } from "./wallet";
import { vaultContract, uniswapV3PoolAbi, positionManagerAbi } from "./serverContracts";
import { erc20Abi } from "../contracts";
import { ethPriceFromTick } from "../priceMath";
import { estimatePositionValueUsd } from "./swapMath";
import { resolveVaultPair, applyVaultPair } from "./pairInfo";
import type { Store, VaultRecord } from "./store";

// "compound" is Arbitrum-only (RangeVaultArbCompound.sol) — see chains.ts's
// ChainDef docstring on compoundVaultAbi. A "standard" vault (the default)
// never has autoCompoundFees/feeClaimThresholdBps/etc. on its ABI at all.
export type VaultKind = "standard" | "compound";

export type VaultAction =
  | { kind: "none" }
  | { kind: "init"; reason: string }
  | { kind: "rebalance"; reason: "out-of-range-top" | "out-of-range-bottom" | "periodic" }
  | { kind: "claimFees" }
  | { kind: "sweep" };

// Not worth a transaction below this — matches DUST_SWEEP_MIN_USD in
// rebalancer.ts (kept as a separate constant since monitor.ts is the
// free-read-only side of this check, rebalancer.ts is the one that acts).
const DUST_SWEEP_MIN_USD = 1;

/**
 * Free, read-only check of whether a vault needs attention right now. Mirrors
 * autorange.md "Reglas de rebalanceo": out-of-range or periodic trigger the paid
 * uni-lab.xyz call + rebalance; a cost gate against dust-sized positions and the
 * on-chain cooldown/maxRebalances guardrails are enforced again by the contract
 * itself, this is just the off-chain pre-check so we don't waste a paid API call
 * on a doomed transaction.
 */
export async function checkVault(chain: ChainRuntime, record: VaultRecord, store: Store): Promise<VaultAction> {
  const vaultAddress = record.address as Address;
  const vaultKind: VaultKind = record.kind;
  const abi = vaultKind === "compound" ? (chain.compoundVaultAbi as Abi) : chain.vaultAbi;
  chain = applyVaultPair(chain, await resolveVaultPair(chain, vaultAddress, abi, store, record));
  const vault = vaultContract(chain, vaultAddress, abi);

  const [targetConfigured, positionTokenId, rebalanceCount, maxRebalances, lastRebalanceTimestamp, minInterval, periodicInterval] =
    await Promise.all([
      vault.read.targetConfigured() as Promise<boolean>,
      vault.read.positionTokenId() as Promise<bigint>,
      vault.read.rebalanceCount() as Promise<bigint>,
      vault.read.maxRebalances() as Promise<bigint>,
      vault.read.lastRebalanceTimestamp() as Promise<bigint>,
      vault.read.minRebalanceInterval() as Promise<bigint>,
      vault.read.periodicRebalanceInterval() as Promise<bigint>,
    ]);

  if (!targetConfigured) return { kind: "none" };

  if (positionTokenId === 0n) {
    // A configured-but-unfunded vault (owner hasn't deposited yet, or the
    // deposit tx failed) can't mint — attempting init would just revert at
    // gas estimation every cycle. Wait until it's funded. Unlike rebalance(),
    // initPosition() doesn't call uni-lab at all anymore (see autorange.md — the
    // response was never used even when the call succeeded), so usdtBudget
    // isn't a precondition here; it only matters once the vault starts
    // rebalancing.
    const investableUsdt = (await vault.read.investableUsdt()) as bigint;
    if (investableUsdt === 0n) return { kind: "none" };
    return { kind: "init", reason: "target configured, no position yet" };
  }

  if (rebalanceCount >= maxRebalances) return { kind: "none" };

  const now = BigInt(Math.floor(Date.now() / 1000));
  const cooldownPassed = now >= lastRebalanceTimestamp + minInterval;
  if (!cooldownPassed) return { kind: "none" };

  // Out-of-range must be checked BEFORE periodic, not after — periodic used
  // to short-circuit first, so a vault that fell out of range on the same
  // cycle periodic also happened to be due got misclassified as "periodic"
  // forever. rebalancer.ts's periodic path deliberately reuses the
  // EXISTING position's floor as D1 (see runRebalanceViaUniLab's docstring:
  // "D1 stays exactly what the EXISTING position's floor already is"), but
  // once price has actually broken below that floor, D1 sits ABOVE the live
  // price C1 — a degenerate combination uni-lab.xyz's docs list as a real
  // cause of its 500 ("input combination doesn't produce a valid rebalance
  // range"). With periodicInterval short enough to keep re-triggering
  // before the next check, that 500 repeats forever instead of ever
  // reaching the out-of-range-bottom path below, which sends a fresh D1.
  // Confirmed live 2026-07-22 (vault 0xB7801f08...F30, Arbitrum): stuck
  // retrying the same stale D1=1950.86 against C1≈1930 every 5 minutes for
  // over an hour straight, all 500s, its range never moving.
  const [posManager, vaultPool] = (await Promise.all([
    vault.read.positionManager(),
    vault.read.pool(),
  ])) as [Address, Address];
  const positions = (await chain.publicClient.readContract({
    address: posManager,
    abi: positionManagerAbi,
    functionName: "positions",
    args: [positionTokenId],
  })) as readonly [bigint, Address, Address, Address, number, number, number, bigint, bigint, bigint, bigint, bigint];

  const [, , , , , tickLower, tickUpper, liquidity, , , tokensOwed0, tokensOwed1] = positions;
  // The vault's own pool — NOT necessarily chain.pool, the chain's "default"
  // pool. createVault() lets the owner pick any fee-tier pool for the pair;
  // a vault on a different one had its out-of-range check (and, before this
  // fix, every rebalance/tickSpacing computation in rebalancer.ts) silently
  // reading the WRONG pool's price. Confirmed live 2026-07-19: a real
  // Arbitrum vault (0x5cD98eC8...4A5dEcb) sits on the 0.30% pool while
  // chain.pool is the 0.05% one.
  const [, currentTick] = (await chain.publicClient.readContract({
    address: vaultPool,
    abi: uniswapV3PoolAbi,
    functionName: "slot0",
  })) as readonly [bigint, number, number, number, number, number, boolean];

  // Whether a HIGHER tick means a LOWER or HIGHER USD price depends on which
  // real token0/token1 slot the stablecoin landed in (stableIsToken0 — see
  // rebalancer.ts's own note on this), so comparing raw ticks directly would
  // need a direction branch. Comparing real USD prices instead sidesteps
  // that entirely — self-consistent regardless of chain. The two
  // out-of-range directions need different rebuild rules (rebalancer.ts's
  // Case 2 vs Case 3), so they're reported separately instead of collapsed
  // into one "out-of-range" reason.
  const ethPriceNow = ethPriceFromTick(currentTick, chain.stableIsToken0, chain.stableDecimals, chain.volatileDecimals);
  const priceAtTickLower = ethPriceFromTick(tickLower, chain.stableIsToken0, chain.stableDecimals, chain.volatileDecimals);
  const priceAtTickUpper = ethPriceFromTick(tickUpper, chain.stableIsToken0, chain.stableDecimals, chain.volatileDecimals);
  const priceFloor = Math.min(priceAtTickLower, priceAtTickUpper);
  const priceCeiling = Math.max(priceAtTickLower, priceAtTickUpper);
  if (ethPriceNow > priceCeiling) {
    return { kind: "rebalance", reason: "out-of-range-top" };
  }
  if (ethPriceNow < priceFloor) {
    return { kind: "rebalance", reason: "out-of-range-bottom" };
  }

  // Still in range — only now is a periodic recenter (untouched floor, live
  // ceiling) actually valid input for uni-lab.xyz.
  const periodicDue = periodicInterval > 0n && now >= lastRebalanceTimestamp + periodicInterval;
  if (periodicDue) return { kind: "rebalance", reason: "periodic" };

  // Compound-only: scheduled/threshold fee auto-claim. Both knobs
  // (feeClaimThresholdBps/feeClaimIntervalSeconds) are off-chain-only —
  // stored on the vault, never enforced by the contract itself (same pattern
  // as recenterMarginBps) — so this is the single place that actually
  // decides "due". Only relevant when autoCompoundFees is on: if it's off,
  // there's nothing to schedule, fees just accumulate for the next
  // rebalance's default payout, same as a plain RangeVaultArb vault.
  if (vaultKind === "compound") {
    const claimDue = await checkFeeClaimDue(vault, {
      liquidity,
      tokensOwed0,
      tokensOwed1,
      currentTick,
      tickLower,
      tickUpper,
      ethPriceNow,
      stableIsToken0: chain.stableIsToken0,
      stableDecimals: chain.stableDecimals,
      volatileDecimals: chain.volatileDecimals,
      now,
    });
    if (claimDue) return { kind: "claimFees" };
  }

  // In range and nothing else to do this cycle — but check for stranded
  // dust before giving up. Ideally sweepIdleDust() runs right after the mint
  // that created it (see rebalancer.ts's own inline calls), but that can be
  // missed (confirmed in production 2026-07-16, vault
  // 0x0Bf394B3...5dEBCE5b8: the serverless function's own tick likely ran
  // out of time right after initPosition(), before the sweep could fire —
  // $191 of WETH sat stranded with zero USDT to pair it with for over 5
  // minutes with no retry). Checking again independently every tick means a
  // missed sweep gets caught on the very next cycle instead of sitting idle
  // indefinitely.
  const [idleUsdt, idleWeth] = await Promise.all([
    vault.read.investableUsdt() as Promise<bigint>,
    chain.publicClient.readContract({
      address: chain.volatileToken,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [vaultAddress],
    }) as Promise<bigint>,
  ]);
  const idleUsdValue = Number(idleUsdt) * 10 ** -chain.stableDecimals + Number(idleWeth) * 10 ** -chain.volatileDecimals * ethPriceNow;
  if (idleUsdValue >= DUST_SWEEP_MIN_USD) return { kind: "sweep" };

  return { kind: "none" };
}

/**
 * Compound-only due-check for the scheduled/threshold fee auto-claim. No
 * on-chain enforcement exists for either knob (see checkVault's own comment
 * at the call site) — this is the entire decision. Threshold is measured as
 * accrued-but-uncollected fees (Uniswap's own `tokensOwed0`/`tokensOwed1` on
 * the position, already fetched by the caller — no extra RPC round-trip)
 * against the position's CURRENT value, per the confirmed design (% of
 * position value, not an absolute amount). `tokensOwed0/1` undercounts fees
 * accrued since the position's last "poke" (any mint/burn/collect touching
 * it) — the standard, well-understood Uniswap V3 caveat, self-correcting on
 * the next cycle that pokes the position (a rebalance, another claim) —
 * acceptable imprecision for a threshold trigger, same tolerance swapMath.ts
 * already accepts for its own sizing.
 */
async function checkFeeClaimDue(
  vault: ReturnType<typeof vaultContract>,
  params: {
    liquidity: bigint;
    tokensOwed0: bigint;
    tokensOwed1: bigint;
    currentTick: number;
    tickLower: number;
    tickUpper: number;
    ethPriceNow: number;
    stableIsToken0: boolean;
    stableDecimals: number;
    volatileDecimals: number;
    now: bigint;
  },
): Promise<boolean> {
  const [autoCompoundFees, feeClaimThresholdBps, feeClaimIntervalSeconds, lastFeeClaimTimestamp] = await Promise.all([
    vault.read.autoCompoundFees() as Promise<boolean>,
    // .catch fallback: a vault could in principle be read before
    // configureTarget() ever ran (feeClaimThresholdBps/feeClaimIntervalSeconds
    // default to 0 either way, same effect as the fallback), kept for the
    // same defensive-consistency reason recenterMarginBps's own read uses one.
    (vault.read.feeClaimThresholdBps() as Promise<bigint>).catch(() => 0n),
    (vault.read.feeClaimIntervalSeconds() as Promise<bigint>).catch(() => 0n),
    vault.read.lastFeeClaimTimestamp() as Promise<bigint>,
  ]);

  if (!autoCompoundFees) return false;

  const intervalDue = feeClaimIntervalSeconds > 0n && params.now >= lastFeeClaimTimestamp + feeClaimIntervalSeconds;
  if (intervalDue) return true;

  if (feeClaimThresholdBps === 0n) return false;
  if (params.liquidity === 0n) return false;

  const positionValueUsd = estimatePositionValueUsd({
    liquidity: params.liquidity,
    currentTick: params.currentTick,
    tickLower: params.tickLower,
    tickUpper: params.tickUpper,
    ethPriceUsd: params.ethPriceNow,
    stableIsToken0: params.stableIsToken0,
    stableDecimals: params.stableDecimals,
    volatileDecimals: params.volatileDecimals,
  });
  if (positionValueUsd <= 0) return false;

  const accruedStableRaw = params.stableIsToken0 ? params.tokensOwed0 : params.tokensOwed1;
  const accruedVolatileRaw = params.stableIsToken0 ? params.tokensOwed1 : params.tokensOwed0;
  const accruedValueUsd =
    Number(accruedStableRaw) * 10 ** -params.stableDecimals + Number(accruedVolatileRaw) * 10 ** -params.volatileDecimals * params.ethPriceNow;

  const accruedBps = (accruedValueUsd / positionValueUsd) * 10_000;
  return accruedBps >= Number(feeClaimThresholdBps);
}
