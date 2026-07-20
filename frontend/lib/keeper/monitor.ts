import "server-only";
import type { Address } from "viem";
import type { ChainRuntime } from "./wallet";
import { vaultContract, uniswapV3PoolAbi, positionManagerAbi } from "./serverContracts";
import { erc20Abi } from "../contracts";
import { ethPriceFromTick } from "../priceMath";

export type VaultAction =
  | { kind: "none" }
  | { kind: "init"; reason: string }
  | { kind: "rebalance"; reason: "out-of-range-top" | "out-of-range-bottom" | "periodic" }
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
export async function checkVault(chain: ChainRuntime, vaultAddress: Address): Promise<VaultAction> {
  const vault = vaultContract(chain, vaultAddress);

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

  const periodicDue = periodicInterval > 0n && now >= lastRebalanceTimestamp + periodicInterval;
  if (periodicDue) return { kind: "rebalance", reason: "periodic" };

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

  const [, , , , , tickLower, tickUpper] = positions;
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
  const ethPriceNow = ethPriceFromTick(currentTick, chain.stableIsToken0);
  const priceAtTickLower = ethPriceFromTick(tickLower, chain.stableIsToken0);
  const priceAtTickUpper = ethPriceFromTick(tickUpper, chain.stableIsToken0);
  const priceFloor = Math.min(priceAtTickLower, priceAtTickUpper);
  const priceCeiling = Math.max(priceAtTickLower, priceAtTickUpper);
  if (ethPriceNow > priceCeiling) {
    return { kind: "rebalance", reason: "out-of-range-top" };
  }
  if (ethPriceNow < priceFloor) {
    return { kind: "rebalance", reason: "out-of-range-bottom" };
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
  const idleUsdValue = Number(idleUsdt) * 1e-6 + Number(idleWeth) * 1e-18 * ethPriceNow;
  if (idleUsdValue >= DUST_SWEEP_MIN_USD) return { kind: "sweep" };

  return { kind: "none" };
}
