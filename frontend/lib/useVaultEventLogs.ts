"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { parseEventLogs, type Log } from "viem";
import { fetchNewLogs } from "./incrementalLogScan";
import type { ChainDef } from "./chains";

// Accumulated raw logs per vault — module scope, same reasoning as
// incrementalLogScan.ts/dashboard's caches: survives remounts (e.g.
// navigating away from and back to a vault), only a full reload resets it.
const rawLogCache = new Map<string, Log[]>();

/**
 * Single shared incremental fetch of a vault's ENTIRE event history.
 * ActivityFeed, PositionHistory, useVaultFeesSummary, and
 * useVaultDepositSummary all need this same underlying data (just filtered/
 * derived differently) — before this existed, each of those ran its own
 * independent full-history getLogsChunked scan, so a single vault page
 * mount fired 4 redundant scans of the identical block range at once,
 * competing for the same RPC's rate limit. They now all read from THIS
 * query (same queryKey → React Query dedupes concurrent callers into one
 * request) instead.
 *
 * Only genuinely NEW logs get fetched on a refetch — see
 * incrementalLogScan.ts — so repeat polls (this refetches every 10s, the
 * fastest of the 4 original intervals) cost roughly nothing once warm.
 */
export function useVaultEventLogs(address: `0x${string}` | undefined, chain: ChainDef) {
  const publicClient = usePublicClient({ chainId: chain.id });

  return useQuery({
    queryKey: ["vault-event-logs", chain.id, address],
    enabled: Boolean(publicClient && address),
    refetchInterval: 10_000,
    queryFn: async () => {
      if (!publicClient || !address) return [];
      const cacheKey = `${chain.id}:${address}`;
      const freshLogs = await fetchNewLogs(`vaultEvents:${cacheKey}`, publicClient, {
        address: [address],
        fromBlock: chain.factoryDeployBlock,
      });
      const merged = freshLogs.length > 0 ? [...(rawLogCache.get(cacheKey) ?? []), ...freshLogs] : (rawLogCache.get(cacheKey) ?? []);
      rawLogCache.set(cacheKey, merged);
      return parseEventLogs({ abi: chain.vaultAbi, logs: merged });
    },
  });
}
