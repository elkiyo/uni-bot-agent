import { parseEventLogs, type Log, type PublicClient } from "viem";
import { fetchNewLogs } from "../incrementalLogScan";
import type { ChainDef } from "../chains";

export interface VaultCreationRecord {
  address: `0x${string}`;
  owner: `0x${string}`;
  pool: `0x${string}`;
  token0: `0x${string}`;
  token1: `0x${string}`;
  fee: number;
  createdAt: number; // unix seconds
  txHash: `0x${string}` | null;
}

// Accumulated result per chain — see incrementalLogScan.ts's own docstring
// for why this lives at module scope instead of being recomputed from
// scratch on every call.
const directoryCache = new Map<number, VaultCreationRecord[]>();

/**
 * Every vault ever created on `chain`, regardless of owner — the factory's
 * own VaultCreated event, unfiltered (unlike useVaultCreationTimes.ts, which
 * filters to a single owner for "my vaults" pages). This is the protocol
 * dashboard's vault directory: one chunked scan per chain, not one call per
 * vault, since VaultCreated already carries pool/token0/token1/fee — the
 * exact fields needed for the "por tipo de pool" breakdown — so no extra
 * per-vault read is needed just to classify a vault's pool.
 *
 * Only NEW VaultCreated events (since this function's own last call for
 * this chain) get processed — see fetchNewLogs — so a repeated call only
 * pays for a block-timestamp lookup on vaults created since the last one.
 */
export async function fetchAllVaultCreations(
  publicClient: PublicClient,
  chain: ChainDef,
): Promise<VaultCreationRecord[]> {
  if (!chain.factoryAddress) return directoryCache.get(chain.id) ?? [];

  const freshLogs = await fetchNewLogs(`directory:${chain.id}`, publicClient, {
    address: [chain.factoryAddress],
    fromBlock: chain.factoryDeployBlock,
  });
  const freshEvents = parseEventLogs({ abi: chain.factoryAbi, logs: freshLogs as Log[] }).filter(
    (l) => l.eventName === "VaultCreated",
  );

  if (freshEvents.length > 0) {
    const uniqueBlocks = [...new Set(freshEvents.map((l) => l.blockNumber))].filter(
      (bn): bn is bigint => bn !== null,
    );
    const blocks = await Promise.all(uniqueBlocks.map((bn) => publicClient.getBlock({ blockNumber: bn })));
    const blockTimestamps = new Map(uniqueBlocks.map((bn, i) => [bn, Number(blocks[i].timestamp)]));

    const freshRecords: VaultCreationRecord[] = freshEvents.map((l) => {
      const a = l.args as {
        owner: `0x${string}`;
        vault: `0x${string}`;
        pool: `0x${string}`;
        token0: `0x${string}`;
        token1: `0x${string}`;
        fee: number;
      };
      return {
        address: a.vault,
        owner: a.owner,
        pool: a.pool,
        token0: a.token0,
        token1: a.token1,
        fee: a.fee,
        createdAt: l.blockNumber !== null ? (blockTimestamps.get(l.blockNumber) ?? 0) : 0,
        txHash: l.transactionHash,
      };
    });
    directoryCache.set(chain.id, [...(directoryCache.get(chain.id) ?? []), ...freshRecords]);
  } else if (!directoryCache.has(chain.id)) {
    directoryCache.set(chain.id, []);
  }

  return directoryCache.get(chain.id) ?? [];
}
