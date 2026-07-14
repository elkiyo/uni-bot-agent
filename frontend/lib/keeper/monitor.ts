import "server-only";
import type { Address } from "viem";
import { publicClient } from "./wallet";
import { vaultContract, uniswapV3PoolAbi, positionManagerAbi } from "./serverContracts";
import { POOL } from "../addresses";

export type VaultAction =
  | { kind: "none" }
  | { kind: "init"; reason: string }
  | { kind: "rebalance"; reason: "out-of-range-top" | "out-of-range-bottom" | "periodic" };

/**
 * Free, read-only check of whether a vault needs attention right now. Mirrors
 * PLAN.md "Reglas de rebalanceo": out-of-range or periodic trigger the paid
 * uni-lab.xyz call + rebalance; a cost gate against dust-sized positions and the
 * on-chain cooldown/maxRebalances guardrails are enforced again by the contract
 * itself, this is just the off-chain pre-check so we don't waste a paid API call
 * on a doomed transaction.
 */
export async function checkVault(vaultAddress: Address): Promise<VaultAction> {
  const vault = vaultContract(vaultAddress);

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
    // initPosition() doesn't call uni-lab at all anymore (see PLAN.md — the
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

  const posManager = (await vault.read.positionManager()) as Address;
  const positions = (await publicClient.readContract({
    address: posManager,
    abi: positionManagerAbi,
    functionName: "positions",
    args: [positionTokenId],
  })) as readonly [bigint, Address, Address, Address, number, number, number, bigint, bigint, bigint, bigint, bigint];

  const [, , , , , tickLower, tickUpper] = positions;
  const [, currentTick] = (await publicClient.readContract({
    address: POOL,
    abi: uniswapV3PoolAbi,
    functionName: "slot0",
  })) as readonly [bigint, number, number, number, number, number, boolean];

  // In this pool a HIGHER tick means a LOWER USD price (token1/token0
  // inversion — see rebalancer.ts's own note on this), so `tickLower` (the
  // numerically smaller tick) is actually the USD-price CEILING and
  // `tickUpper` is the USD-price FLOOR. The two out-of-range directions need
  // different rebuild rules (rebalancer.ts's Case 2 vs Case 3), so they're
  // reported separately instead of collapsed into one "out-of-range" reason.
  if (currentTick < tickLower) {
    return { kind: "rebalance", reason: "out-of-range-top" }; // price broke above the ceiling
  }
  if (currentTick > tickUpper) {
    return { kind: "rebalance", reason: "out-of-range-bottom" }; // price broke below the floor
  }

  return { kind: "none" };
}
