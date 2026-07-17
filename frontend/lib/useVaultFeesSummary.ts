"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { parseEventLogs, type Log } from "viem";
import { getLogsChunked } from "./getLogsChunked";
import type { ChainDef } from "./chains";

export interface VaultFeesSummary {
  totalUsdt: bigint; // stable-leg fees paid to owner (LpFeesPaidToOwner + FeesCollected)
  totalWeth: bigint; // volatile-leg fees paid to owner
  payoutCount: number;
}

/**
 * Sums every LpFeesPaidToOwner (paid out during a keeper rebalance) and
 * FeesCollected (owner's manual collectFees() claim) event a vault has ever
 * emitted, straight from chain logs — same no-backend pattern as
 * ActivityFeed.tsx. Both events already report the NET amount the owner
 * actually received (performanceFeeBps is deducted before either fires —
 * see RangeVault.sol's _splitPerformanceFee), so this sum is exactly what
 * landed in the owner's wallet, not the gross Uniswap fee. Only vaults built
 * from the post-2026-07 RangeVault implementation emit these events at all
 * (older clones mixed fees into principal), so vaults predating that deploy
 * always resolve to zero here — that's accurate, not a bug.
 */
export function useVaultFeesSummary(address: `0x${string}` | undefined, chain: ChainDef) {
  const publicClient = usePublicClient({ chainId: chain.id });

  return useQuery({
    queryKey: ["vault-fees-summary", chain.id, address],
    enabled: Boolean(publicClient && address),
    refetchInterval: 15_000,
    queryFn: async (): Promise<VaultFeesSummary> => {
      if (!publicClient || !address) return { totalUsdt: 0n, totalWeth: 0n, payoutCount: 0 };
      const rawLogs = await getLogsChunked(publicClient, {
        address,
        fromBlock: chain.factoryDeployBlock,
        toBlock: "latest",
      });
      const logs = parseEventLogs({ abi: chain.vaultAbi, logs: rawLogs as Log[] }).filter(
        (l) => l.eventName === "LpFeesPaidToOwner" || l.eventName === "FeesCollected",
      );

      let totalUsdt = 0n;
      let totalWeth = 0n;
      for (const log of logs) {
        const args = log.args as { amount0?: bigint; amount1?: bigint };
        // amount0/amount1 are Uniswap's real token0/token1 — route to
        // stable/volatile based on this chain's actual order.
        totalUsdt += (chain.stableIsToken0 ? args.amount0 : args.amount1) ?? 0n;
        totalWeth += (chain.stableIsToken0 ? args.amount1 : args.amount0) ?? 0n;
      }
      return { totalUsdt, totalWeth, payoutCount: logs.length };
    },
  });
}
