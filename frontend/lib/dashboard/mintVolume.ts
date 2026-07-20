import { parseEventLogs, type Address, type PublicClient } from "viem";
import { positionManagerAbi, uniswapV3PoolAbi } from "../contracts";
import { ethPriceFromTick } from "../priceMath";
import { estimatePositionAmounts } from "../keeper/swapMath";
import { fetchNewLogs } from "../incrementalLogScan";
import { withRetry, mapWithConcurrency } from "../concurrency";
import type { ChainDef } from "../chains";

// A full 300-way burst against a free public RPC (forno.celo.org) is exactly
// the kind of load that trips a rate limit — bound it like getLogsChunked.ts
// does, and retry each mint's read independently instead of silently
// dropping it (the previous behavior: any single failed historical read —
// common under a burst that size — just vanished from "Volumen", making the
// chart understate real activity with no indication anything was wrong).
const CONCURRENCY = 6;

export interface MintVolumeEvent {
  timestamp: number; // seconds
  usd: number;
}

type PositionTuple = readonly [
  bigint,
  Address,
  Address,
  Address,
  number,
  number,
  number,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
];

// Resolved events per chain, keyed by tokenId — see incrementalLogScan.ts's
// own docstring for why this lives at module scope. Once a mint's USD value
// is resolved it never changes (it's a historical, block-pinned read), so
// caching by tokenId (not re-resolving on every call) is exactly correct,
// not just an optimization.
const resolvedMintsCache = new Map<number, Map<string, MintVolumeEvent>>();

/**
 * "Volumen movido por el agente" — the USD value of every position built on
 * `chain`, one entry per initPosition()/rebalance() across ALL of
 * `vaultAddresses` (each mints a fresh position). Extracted from
 * VolumeChart.tsx (originally admin-only, one vault list at a time) so the
 * protocol dashboard can reuse the exact same historical-value
 * reconstruction instead of re-deriving it. Reads the resulting position's
 * liquidity AND the pool's tick AS OF THAT EVENT'S OWN BLOCK (not now — a
 * position rebalanced again since would read back as empty otherwise).
 * Needs an RPC that still has that historical state; any block it can't
 * serve is skipped rather than failing the whole result.
 *
 * Only NEW mints (since this function's own last call for this chain) get
 * the expensive per-mint historical reads — already-resolved mints are
 * served straight from resolvedMintsCache.
 */
export async function fetchMintVolumeEvents(
  publicClient: PublicClient,
  chain: ChainDef,
  vaultAddresses: readonly Address[],
): Promise<MintVolumeEvent[]> {
  if (vaultAddresses.length === 0) return [];

  const rawLogs = await fetchNewLogs(`mintVolume:${chain.id}`, publicClient, {
    address: vaultAddresses,
    fromBlock: chain.factoryDeployBlock,
  });

  const parsed = parseEventLogs({ abi: chain.vaultAbi, logs: rawLogs });
  let mints: { tokenId: bigint; blockNumber: bigint }[] = [];
  for (const log of parsed) {
    if (log.blockNumber === null) continue;
    if (log.eventName === "PositionInitialized") {
      mints.push({ tokenId: (log.args as { tokenId: bigint }).tokenId, blockNumber: log.blockNumber });
    } else if (log.eventName === "Rebalanced") {
      mints.push({ tokenId: (log.args as { newTokenId: bigint }).newTokenId, blockNumber: log.blockNumber });
    }
  }

  // Each mint needs 2 historical reads + 1 block fetch — a vault list with a
  // long rebalance history (a single active vault can rack up hundreds) would
  // otherwise turn this into thousands of sequential-ish RPC calls against a
  // public, rate-limited RPC. Cap to the most recent MAX_MINTS: the chart
  // this feeds never shows more than 14 points anyway (see bucket.ts's
  // MAX_BUCKET_POINTS), so older history beyond this cap wouldn't render.
  const MAX_MINTS = 300;
  if (mints.length > MAX_MINTS) {
    mints = mints.sort((a, b) => (a.blockNumber > b.blockNumber ? -1 : 1)).slice(0, MAX_MINTS);
  }

  let cache = resolvedMintsCache.get(chain.id);
  if (!cache) {
    cache = new Map();
    resolvedMintsCache.set(chain.id, cache);
  }

  await mapWithConcurrency(mints, CONCURRENCY, async ({ tokenId, blockNumber }): Promise<void> => {
    try {
      const event = await withRetry(async () => {
        const [position, slot0, block] = await Promise.all([
          publicClient.readContract({
            address: chain.positionManager,
            abi: positionManagerAbi,
            functionName: "positions",
            args: [tokenId],
            blockNumber,
          }) as Promise<PositionTuple>,
          publicClient.readContract({
            address: chain.pool,
            abi: uniswapV3PoolAbi,
            functionName: "slot0",
            blockNumber,
          }) as Promise<readonly [bigint, number, number, number, number, number, boolean]>,
          publicClient.getBlock({ blockNumber }),
        ]);
        const [, , , , , tickLower, tickUpper, liquidity] = position;
        const currentTick = Number(slot0[1]);
        const ethPrice = ethPriceFromTick(currentTick, chain.stableIsToken0);
        const { amount0Raw, amount1Raw } = estimatePositionAmounts({ liquidity, currentTick, tickLower, tickUpper });
        const stableRaw = chain.stableIsToken0 ? amount0Raw : amount1Raw;
        const volatileRaw = chain.stableIsToken0 ? amount1Raw : amount0Raw;
        const usd = stableRaw * 1e-6 + volatileRaw * 1e-18 * ethPrice;
        return { timestamp: Number(block.timestamp), usd };
      });
      cache!.set(tokenId.toString(), event);
    } catch {
      // RPC couldn't serve this historical block even after retrying — skip,
      // don't fail the whole scan. Not cached, so a later call retries it.
    }
  });

  return [...cache.values()];
}
