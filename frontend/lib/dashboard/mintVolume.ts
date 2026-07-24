import type { Address } from "viem";
import type { ChainDef } from "../chains";

export interface MintVolumeEvent {
  timestamp: number; // seconds
  usd: number;
}

interface ApiEventRow {
  address: string;
  event_name: string;
  block_timestamp: string;
  usd_value: string | number | null;
}

/**
 * "Volumen movido por el agente" — the USD value of every position built on
 * `chain` across `vaultAddresses`, one entry per initPosition()/rebalance()
 * (each mints a fresh position). Used to reconstruct this from the browser
 * with one historical position+pool read per past mint (a real position
 * value at a real past block, not derivable from a live read); that
 * reconstruction now happens ONCE, server-side, the moment the indexer
 * first sees each mint (see lib/dashboard/indexer.ts's backfillMintUsd) —
 * this just reads the already-resolved usd_value back out of the same
 * events cache useVaultEventLogs/useProtocolMetrics use.
 */
export async function fetchMintVolumeEvents(
  chain: ChainDef,
  vaultAddresses: readonly Address[],
): Promise<MintVolumeEvent[]> {
  if (vaultAddresses.length === 0) return [];

  const res = await fetch(`/api/dashboard/events?chain=${chain.id}`);
  if (!res.ok) throw new Error(`mint volume events fetch failed: ${res.status}`);
  const rows = (await res.json()) as ApiEventRow[];

  const wanted = new Set(vaultAddresses.map((a) => a.toLowerCase()));
  const events: MintVolumeEvent[] = [];
  for (const r of rows) {
    if (r.event_name !== "PositionInitialized" && r.event_name !== "Rebalanced") continue;
    if (!wanted.has(r.address.toLowerCase())) continue;
    if (r.usd_value === null) continue; // not backfilled yet — shows up once the indexer resolves it, next tick or two
    events.push({ timestamp: Math.floor(new Date(r.block_timestamp).getTime() / 1000), usd: Number(r.usd_value) });
  }
  return events;
}
