import "server-only";
import type { Abi, Address } from "viem";
import type { ChainRuntime } from "./wallet";
import { vaultContract, uniswapV3PoolAbi, positionManagerAbi } from "./serverContracts";
import { erc20Abi } from "../contracts";
import { ethPriceFromTick } from "../priceMath";
import { estimatePositionValueUsd } from "./swapMath";
import { uncollectedFeesRaw } from "../positionMath";
import { resolveVaultPair, applyVaultPair } from "./pairInfo";
import type { Store, VaultRecord } from "./store";

// "compound" is Arbitrum-only (RangeVaultArbCompound.sol) — see chains.ts's
// ChainDef docstring on compoundVaultAbi. A "standard" vault (the default)
// never has autoCompoundFees/feeClaimThresholdBps/etc. on its ABI at all.
export type VaultKind = "standard" | "compound";

export type VaultAction =
  | { kind: "none" }
  | { kind: "init"; reason: string }
  // overdueSec = seconds since this vault's own lastRebalanceTimestamp —
  // used to prioritize tick.ts's sequential Phase 2 queue (see that file's
  // own docstring) so the most-neglected vault gets processed first instead
  // of always losing out to whichever vault happens to sort earlier.
  | { kind: "rebalance"; reason: "out-of-range-top" | "out-of-range-bottom" | "periodic"; overdueSec: number }
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

  const [
    ,
    ,
    ,
    ,
    ,
    tickLower,
    tickUpper,
    liquidity,
    feeGrowthInside0LastX128,
    feeGrowthInside1LastX128,
    tokensOwed0,
    tokensOwed1,
  ] = positions;
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
  const overdueSec = Number(now - lastRebalanceTimestamp);
  if (ethPriceNow > priceCeiling) {
    return { kind: "rebalance", reason: "out-of-range-top", overdueSec };
  }
  if (ethPriceNow < priceFloor) {
    return { kind: "rebalance", reason: "out-of-range-bottom", overdueSec };
  }

  // Still in range — only now is a periodic recenter (untouched floor, live
  // ceiling) actually valid input for uni-lab.xyz.
  const periodicDue = periodicInterval > 0n && now >= lastRebalanceTimestamp + periodicInterval;
  if (periodicDue) return { kind: "rebalance", reason: "periodic", overdueSec };

  // Compound-only: scheduled/threshold fee auto-claim. Both knobs
  // (feeClaimThresholdBps/feeClaimIntervalSeconds) are off-chain-only —
  // stored on the vault, never enforced by the contract itself (same pattern
  // as recenterMarginBps) — so this is the single place that actually
  // decides "due". Only relevant when autoCompoundFees is on: if it's off,
  // there's nothing to schedule, fees just accumulate for the next
  // rebalance's default payout, same as a plain RangeVaultArb vault.
  if (vaultKind === "compound") {
    // Live feeGrowth reads — only needed here (threshold-based claim check),
    // so gated behind vaultKind === "compound" rather than fetched
    // unconditionally for every vault every tick. See checkFeeClaimDue's own
    // docstring for why tokensOwed0/1 alone (already in `positions` above)
    // isn't enough: it only updates on a mint/burn/collect "poke", which
    // never happens on its own for a vault sitting happily in range with
    // periodicRebalanceInterval/feeClaimIntervalSeconds both at 0 — the
    // threshold check would otherwise stay blind to real, growing fees
    // forever instead of "eventually self-correcting" as originally assumed.
    const [feeGrowthGlobal0X128, feeGrowthGlobal1X128, tickLowerData, tickUpperData] = (await Promise.all([
      chain.publicClient.readContract({ address: vaultPool, abi: uniswapV3PoolAbi, functionName: "feeGrowthGlobal0X128" }),
      chain.publicClient.readContract({ address: vaultPool, abi: uniswapV3PoolAbi, functionName: "feeGrowthGlobal1X128" }),
      chain.publicClient.readContract({ address: vaultPool, abi: uniswapV3PoolAbi, functionName: "ticks", args: [tickLower] }),
      chain.publicClient.readContract({ address: vaultPool, abi: uniswapV3PoolAbi, functionName: "ticks", args: [tickUpper] }),
    ])) as [bigint, bigint, readonly bigint[], readonly bigint[]];

    const { fees0Raw, fees1Raw } = uncollectedFeesRaw({
      liquidity,
      tokensOwed0,
      tokensOwed1,
      feeGrowthInside0LastX128,
      feeGrowthInside1LastX128,
      feeGrowthGlobal0X128,
      feeGrowthGlobal1X128,
      tickLowerOutside0X128: tickLowerData[2],
      tickLowerOutside1X128: tickLowerData[3],
      tickUpperOutside0X128: tickUpperData[2],
      tickUpperOutside1X128: tickUpperData[3],
      currentTick,
      tickLower,
      tickUpper,
    });

    const claimDue = await checkFeeClaimDue(vault, {
      liquidity,
      // Live-computed (see above), not the position's own possibly-frozen
      // tokensOwed0/1 — real accrued fees regardless of when this position
      // was last "poked".
      tokensOwed0: BigInt(Math.max(0, Math.floor(fees0Raw))),
      tokensOwed1: BigInt(Math.max(0, Math.floor(fees1Raw))),
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
 * accrued-but-uncollected fees against the position's CURRENT value, per the
 * confirmed design (% of position value, not an absolute amount).
 *
 * tokensOwed0/tokensOwed1 here are the caller's LIVE-computed values
 * (uncollectedFeesRaw, same feeGrowthGlobal/feeGrowthOutside formula
 * PositionNFT.tsx's own "unclaimed fees" figure already uses) — NOT the
 * position's raw on-chain tokensOwed0/1 fields, which only update on a
 * mint/burn/collect "poke". This used to read the raw fields directly and
 * assumed the resulting staleness would "self-correct on the next cycle
 * that pokes the position" — true for a vault that regularly rebalances,
 * but confirmed WRONG in production 2026-07-29 for a vault sitting happily
 * in range with periodicRebalanceInterval and feeClaimIntervalSeconds both
 * at 0 (i.e. threshold-only): nothing ever pokes it, so the raw tokensOwed
 * stayed frozen at ~0 from the initial mint forever, permanently blind to
 * real fees that had already grown past the configured threshold (0.42%)
 * per the frontend's own live estimate. Fixed by having the caller compute
 * real values first — costs 3 extra RPC reads (feeGrowthGlobal0/1X128,
 * ticks(tickLower), ticks(tickUpper)) per compound vault per tick, gated
 * behind vaultKind === "compound" so a standard vault never pays for it.
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
