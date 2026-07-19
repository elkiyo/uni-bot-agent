import type { Log, PublicClient } from "viem";
import { withRetry, mapWithConcurrency } from "./concurrency";

const MAX_BLOCK_RANGE = 5_000n;
// forno.celo.org's free public RPC has no SLA — a scan covering months of
// history needs 50+ sequential chunk requests, and at that volume a
// transient rate-limit/timeout on ANY single chunk is common enough to
// observe in practice. Retrying only the failed chunk (not restarting the
// whole scan) and running a bounded number of chunks concurrently (not
// fully sequential) both reduce how often that happens and how long a scan
// takes when it doesn't.
const CONCURRENCY = 6;
// forno.celo.org confirmed flaky in a way plain retry-on-error can't catch:
// 5 IDENTICAL eth_getLogs requests for the same exact block range came back
// 2, 2, 0, 2, 2 logs (2026-07-18) — a "successful" empty response, not a
// thrown error, is what made the dashboard's Celo numbers intermittently
// read as confirmed zeros despite real vaults/fees/rebalances existing. An
// empty chunk gets re-verified up to this many extra times before it's
// trusted — a false empty only ever OMITS real logs, so re-querying can
// only correct an undercount, never introduce a fake one.
const EMPTY_RESULT_REVERIFY_ATTEMPTS = 4;

async function getLogsChunkResilient(
  publicClient: PublicClient,
  address: readonly `0x${string}`[],
  fromBlock: bigint,
  toBlock: bigint,
): Promise<Log[]> {
  const fetchOnce = () =>
    withRetry(() => publicClient.getLogs({ address: address as `0x${string}`[], fromBlock, toBlock }));
  let result = await fetchOnce();
  for (let i = 0; result.length === 0 && i < EMPTY_RESULT_REVERIFY_ATTEMPTS; i++) {
    result = await fetchOnce();
  }
  return result;
}

export async function getLogsChunked(
  publicClient: PublicClient,
  params: { address: `0x${string}`; fromBlock: bigint; toBlock: bigint | "latest" },
): Promise<Log[]> {
  return getLogsChunkedMulti(publicClient, { ...params, address: [params.address] });
}

/**
 * Same chunking as getLogsChunked, but scans a whole vault list's events in
 * ONE pass (`eth_getLogs` accepts an address array) instead of one full
 * from-genesis-to-latest scan per vault. Matters once there are more than a
 * couple of vaults: the dashboard aggregates every event from every vault on
 * a chain, and scanning each vault's full history separately would multiply
 * the chunk count by the vault count for no reason — every vault on a chain
 * shares the same fromBlock (factoryDeployBlock) anyway.
 *
 * Chunks are fetched CONCURRENCY-at-a-time (not fully sequential, not fully
 * parallel — a full burst risks tripping the same free RPC's rate limit it's
 * trying to be resilient against); each chunk retries independently on
 * failure AND re-verifies a suspiciously empty result (see
 * getLogsChunkResilient), so one bad chunk doesn't waste every chunk already
 * fetched and a flaky empty doesn't silently pass as real data.
 */
export async function getLogsChunkedMulti(
  publicClient: PublicClient,
  params: { address: readonly `0x${string}`[]; fromBlock: bigint; toBlock: bigint | "latest" },
): Promise<Log[]> {
  if (params.address.length === 0) return [];
  const latest = params.toBlock === "latest" ? await publicClient.getBlockNumber() : params.toBlock;

  const ranges: { from: bigint; to: bigint }[] = [];
  for (let from = params.fromBlock; from <= latest; ) {
    const to = from + MAX_BLOCK_RANGE - 1n > latest ? latest : from + MAX_BLOCK_RANGE - 1n;
    ranges.push({ from, to });
    from = to + 1n;
  }

  const results = await mapWithConcurrency(ranges, CONCURRENCY, ({ from, to }) =>
    getLogsChunkResilient(publicClient, params.address, from, to),
  );
  return results.flat();
}
