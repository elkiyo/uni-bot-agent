"use client";

import { useQuery } from "@tanstack/react-query";
import type { ChainDef } from "./chains";
import { deserializeArgs } from "./eventArgsCodec";

export interface VaultEventLog {
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  transactionHash: `0x${string}`;
  logIndex: number;
  /** Unix seconds — precomputed by the indexer, so consumers never need
   * their own extra publicClient.getBlock round-trip just for a timestamp. */
  blockTimestamp: number;
  /** Pre-resolved USD value for events the indexer knows how to price (see
   * indexer.ts's cheapUsdValue/backfillMintUsd) — null for event types with
   * no natural USD value, and briefly null for a just-indexed mint event
   * (PositionInitialized/Rebalanced) until the next backfill pass. */
  usdValue: number | null;
}

interface ApiEventRow {
  event_name: string;
  args: Record<string, unknown>;
  block_number: string;
  log_index: number;
  tx_hash: string;
  block_timestamp: string;
  usd_value: string | number | null;
}

/**
 * Single shared fetch of a vault's ENTIRE event history. ActivityFeed,
 * PositionHistory, useVaultFeesSummary, and useVaultDepositSummary all need
 * this same underlying data (just filtered/derived differently) — same
 * queryKey means React Query dedupes concurrent callers into one request.
 *
 * Used to run its own full-history eth_getLogs scan straight from the
 * browser; now reads from the indexer's Postgres cache via a single fast
 * API call instead — see lib/dashboard/indexer.ts and
 * app/api/dashboard/events. That cache only refreshes once per keeper tick
 * (~5 min), so polling faster than that would just re-fetch identical rows;
 * 30s keeps the page feeling live without doing that.
 */
export function useVaultEventLogs(address: `0x${string}` | undefined, chain: ChainDef) {
  return useQuery({
    queryKey: ["vault-event-logs", chain.id, address],
    enabled: Boolean(address),
    refetchInterval: 30_000,
    queryFn: async (): Promise<VaultEventLog[]> => {
      if (!address) return [];
      const res = await fetch(`/api/dashboard/events?chain=${chain.id}&address=${address}`);
      if (!res.ok) throw new Error(`vault events fetch failed: ${res.status}`);
      const rows = (await res.json()) as ApiEventRow[];

      return rows.map((r) => ({
        eventName: r.event_name,
        args: deserializeArgs(chain.vaultAbi, r.event_name, r.args),
        blockNumber: BigInt(r.block_number),
        transactionHash: r.tx_hash as `0x${string}`,
        logIndex: r.log_index,
        blockTimestamp: Math.floor(new Date(r.block_timestamp).getTime() / 1000),
        usdValue: r.usd_value === null ? null : Number(r.usd_value),
      }));
    },
  });
}
