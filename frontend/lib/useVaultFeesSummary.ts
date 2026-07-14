"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { parseEventLogs, type Log } from "viem";
import { rangeVaultAbi } from "./contracts";
import { FACTORY_DEPLOY_BLOCK } from "./addresses";
import { getLogsChunked } from "./getLogsChunked";

export interface VaultFeesSummary {
  totalUsdt: bigint; // token0 fees paid to owner (LpFeesPaidToOwner.amount0)
  totalWeth: bigint; // token1 fees paid to owner (LpFeesPaidToOwner.amount1)
  payoutCount: number;
}

/**
 * Sums every LpFeesPaidToOwner event a vault has ever emitted, straight from
 * chain logs — same no-backend pattern as ActivityFeed.tsx. Only vaults built
 * from the post-2026-07 RangeVault implementation emit this event at all
 * (older clones mixed fees into principal), so vaults predating that deploy
 * always resolve to zero here — that's accurate, not a bug.
 */
export function useVaultFeesSummary(address: `0x${string}` | undefined) {
  const publicClient = usePublicClient();

  return useQuery({
    queryKey: ["vault-fees-summary", address],
    enabled: Boolean(publicClient && address),
    refetchInterval: 15_000,
    queryFn: async (): Promise<VaultFeesSummary> => {
      if (!publicClient || !address) return { totalUsdt: 0n, totalWeth: 0n, payoutCount: 0 };
      const rawLogs = await getLogsChunked(publicClient, { address, fromBlock: FACTORY_DEPLOY_BLOCK, toBlock: "latest" });
      const logs = parseEventLogs({ abi: rangeVaultAbi, logs: rawLogs as Log[] }).filter(
        (l) => l.eventName === "LpFeesPaidToOwner",
      );

      let totalUsdt = 0n;
      let totalWeth = 0n;
      for (const log of logs) {
        const args = log.args as { amount0?: bigint; amount1?: bigint };
        totalUsdt += args.amount0 ?? 0n;
        totalWeth += args.amount1 ?? 0n;
      }
      return { totalUsdt, totalWeth, payoutCount: logs.length };
    },
  });
}
