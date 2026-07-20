import type { Address, Log, PublicClient } from "viem";
import { getLogsChunkedMulti } from "./getLogsChunked";

interface ScanCursor {
  addresses: Set<string>;
  lastScannedBlock: bigint;
}

// Module-level (not component state) so it survives navigating away from and
// back to a page — only a full reload resets it, same as any other in-memory
// cache. Keyed by an arbitrary caller-chosen string (one per chain + dataset
// pair in practice — see vaultDirectory.ts/mintVolume.ts/useProtocolMetrics.ts).
const cursors = new Map<string, ScanCursor>();

/**
 * Returns only the logs that are NEW since the last call with this exact
 * cacheKey — not the full accumulated history — so callers can fold just the
 * delta into their own accumulated result instead of redoing work (a
 * timestamp lookup, a historical position/pool read, ...) for data that
 * hasn't changed. This is the dominant cost driver for the dashboard's RPC
 * usage: without it, every 30-60s refetch re-scanned the ENTIRE history from
 * each chain's factoryDeployBlock, an amount of work that only grows as the
 * chain (and its own factoryDeployBlock-to-latest range) grows over time.
 *
 * A brand-new address (not seen under this key before) gets its full history
 * back from `fromBlock`, since there's nothing to diff it against yet — e.g.
 * a vault created since the last scan. An address already tracked only gets
 * blocks after the last scan for THIS key.
 *
 * In-memory only, not persisted across a full page reload — that's fine,
 * since a fresh load is expected to pay for one real full scan, same as
 * before this existed; only the recurring refetches on top of that get
 * cheaper, and they get cheaper by more the longer the page stays open.
 */
export async function fetchNewLogs(
  cacheKey: string,
  publicClient: PublicClient,
  params: { address: readonly Address[]; fromBlock: bigint },
): Promise<Log[]> {
  if (params.address.length === 0) return [];

  let cursor = cursors.get(cacheKey);
  if (!cursor) {
    cursor = { addresses: new Set(), lastScannedBlock: params.fromBlock - 1n };
    cursors.set(cacheKey, cursor);
  }

  const latest = await publicClient.getBlockNumber();
  const newAddresses = params.address.filter((a) => !cursor!.addresses.has(a.toLowerCase()));
  const knownAddresses = params.address.filter((a) => cursor!.addresses.has(a.toLowerCase()));

  const tasks: Promise<Log[]>[] = [];
  if (newAddresses.length > 0) {
    tasks.push(
      getLogsChunkedMulti(publicClient, { address: newAddresses, fromBlock: params.fromBlock, toBlock: latest }),
    );
  }
  if (knownAddresses.length > 0 && cursor.lastScannedBlock < latest) {
    tasks.push(
      getLogsChunkedMulti(publicClient, {
        address: knownAddresses,
        fromBlock: cursor.lastScannedBlock + 1n,
        toBlock: latest,
      }),
    );
  }

  const fresh = tasks.length > 0 ? (await Promise.all(tasks)).flat() : [];
  for (const a of params.address) cursor.addresses.add(a.toLowerCase());
  cursor.lastScannedBlock = latest;
  return fresh;
}
