"use client";

import type { Abi } from "viem";
import { useVaultEventLogs } from "./useVaultEventLogs";
import type { ChainDef } from "./chains";

export interface VaultFeesSummary {
  totalUsdt: bigint; // stable-leg fees paid to owner (LpFeesPaidToOwner + FeesCollected)
  totalWeth: bigint; // volatile-leg fees paid to owner
  payoutCount: number;
  // Compound-only (RangeVaultArbCompound's FeesReinjected — absent from the
  // standard ABI, so this is always 0/0 for a standard vault, correctly).
  // Already USD-denominated stable-raw units (the contract's own
  // _toStableUsd at the moment of reinjection), unlike totalUsdt/totalWeth
  // above which are raw per-leg token amounts — kept as its own field
  // rather than split into two legs since there's nothing meaningful to
  // split (the contract only ever reports the combined USD figure).
  reinjectedUsdRaw: bigint;
  reinjectionCount: number;
}

/**
 * Sums every LpFeesPaidToOwner (paid out during a keeper rebalance),
 * FeesCollected (owner's manual collectFees() claim), and FeesReinjected
 * (compound-only — reinjected into the position instead of paid out) event a
 * vault has ever emitted, derived from useVaultEventLogs's shared event
 * fetch (see that file for why this used to run its own independent
 * full-history scan and no longer does). The first two already report the
 * NET amount the owner actually received (performanceFeeBps is deducted
 * before any of the three fires — see RangeVault.sol's _splitPerformanceFee),
 * so totalUsdt/totalWeth is exactly what landed in the owner's wallet, not
 * the gross Uniswap fee. Only vaults built from the post-2026-07 RangeVault
 * implementation emit these events at all (older clones mixed fees into
 * principal), so vaults predating that deploy always resolve to zero here —
 * that's accurate, not a bug.
 */
export function useVaultFeesSummary(address: `0x${string}` | undefined, chain: ChainDef, abi: Abi = chain.vaultAbi) {
  const { data: logs, ...rest } = useVaultEventLogs(address, chain, abi);

  const summary: VaultFeesSummary | undefined = logs
    ? (() => {
        let totalUsdt = 0n;
        let totalWeth = 0n;
        let payoutCount = 0;
        let reinjectedUsdRaw = 0n;
        let reinjectionCount = 0;
        for (const log of logs) {
          if (log.eventName === "LpFeesPaidToOwner" || log.eventName === "FeesCollected") {
            const args = log.args as { amount0?: bigint; amount1?: bigint };
            // amount0/amount1 are Uniswap's real token0/token1 — route to
            // stable/volatile based on this chain's actual order.
            totalUsdt += (chain.stableIsToken0 ? args.amount0 : args.amount1) ?? 0n;
            totalWeth += (chain.stableIsToken0 ? args.amount1 : args.amount0) ?? 0n;
            payoutCount += 1;
          } else if (log.eventName === "FeesReinjected") {
            const args = log.args as { netFeeUsd?: bigint };
            if ((args.netFeeUsd ?? 0n) > 0n) {
              reinjectedUsdRaw += args.netFeeUsd ?? 0n;
              reinjectionCount += 1;
            }
          }
        }
        return { totalUsdt, totalWeth, payoutCount, reinjectedUsdRaw, reinjectionCount };
      })()
    : undefined;

  return { ...rest, data: summary };
}
