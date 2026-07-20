"use client";

import { useVaultEventLogs } from "./useVaultEventLogs";
import type { ChainDef } from "./chains";

export interface VaultFeesSummary {
  totalUsdt: bigint; // stable-leg fees paid to owner (LpFeesPaidToOwner + FeesCollected)
  totalWeth: bigint; // volatile-leg fees paid to owner
  payoutCount: number;
}

/**
 * Sums every LpFeesPaidToOwner (paid out during a keeper rebalance) and
 * FeesCollected (owner's manual collectFees() claim) event a vault has ever
 * emitted, derived from useVaultEventLogs's shared event fetch (see that
 * file for why this used to run its own independent full-history scan and
 * no longer does). Both events already report the NET amount the owner
 * actually received (performanceFeeBps is deducted before either fires —
 * see RangeVault.sol's _splitPerformanceFee), so this sum is exactly what
 * landed in the owner's wallet, not the gross Uniswap fee. Only vaults built
 * from the post-2026-07 RangeVault implementation emit these events at all
 * (older clones mixed fees into principal), so vaults predating that deploy
 * always resolve to zero here — that's accurate, not a bug.
 */
export function useVaultFeesSummary(address: `0x${string}` | undefined, chain: ChainDef) {
  const { data: logs, ...rest } = useVaultEventLogs(address, chain);

  const summary: VaultFeesSummary | undefined = logs
    ? (() => {
        let totalUsdt = 0n;
        let totalWeth = 0n;
        let payoutCount = 0;
        for (const log of logs) {
          if (log.eventName !== "LpFeesPaidToOwner" && log.eventName !== "FeesCollected") continue;
          const args = log.args as { amount0?: bigint; amount1?: bigint };
          // amount0/amount1 are Uniswap's real token0/token1 — route to
          // stable/volatile based on this chain's actual order.
          totalUsdt += (chain.stableIsToken0 ? args.amount0 : args.amount1) ?? 0n;
          totalWeth += (chain.stableIsToken0 ? args.amount1 : args.amount0) ?? 0n;
          payoutCount += 1;
        }
        return { totalUsdt, totalWeth, payoutCount };
      })()
    : undefined;

  return { ...rest, data: summary };
}
