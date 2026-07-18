import { parseEventLogs, type Address, type PublicClient } from "viem";
import { positionManagerAbi, uniswapV3PoolAbi } from "../contracts";
import { ethPriceFromTick } from "../priceMath";
import { estimatePositionAmounts } from "../keeper/swapMath";
import { getLogsChunkedMulti } from "../getLogsChunked";
import type { ChainDef } from "../chains";

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
 */
export async function fetchMintVolumeEvents(
  publicClient: PublicClient,
  chain: ChainDef,
  vaultAddresses: readonly Address[],
): Promise<MintVolumeEvent[]> {
  if (vaultAddresses.length === 0) return [];

  const rawLogs = await getLogsChunkedMulti(publicClient, {
    address: vaultAddresses,
    fromBlock: chain.factoryDeployBlock,
    toBlock: "latest",
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

  const results = await Promise.all(
    mints.map(async ({ tokenId, blockNumber }): Promise<MintVolumeEvent | null> => {
      try {
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
      } catch {
        return null; // RPC couldn't serve this historical block — skip, don't fail the whole scan
      }
    }),
  );

  return results.filter((e): e is MintVolumeEvent => e !== null);
}
