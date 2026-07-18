import { parseEventLogs, type Log, type PublicClient } from "viem";
import { getLogsChunked } from "../getLogsChunked";
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

/**
 * Every vault ever created on `chain`, regardless of owner — the factory's
 * own VaultCreated event, unfiltered (unlike useVaultCreationTimes.ts, which
 * filters to a single owner for "my vaults" pages). This is the protocol
 * dashboard's vault directory: one chunked scan per chain, not one call per
 * vault, since VaultCreated already carries pool/token0/token1/fee — the
 * exact fields needed for the "por tipo de pool" breakdown — so no extra
 * per-vault read is needed just to classify a vault's pool.
 */
export async function fetchAllVaultCreations(
  publicClient: PublicClient,
  chain: ChainDef,
): Promise<VaultCreationRecord[]> {
  if (!chain.factoryAddress) return [];

  const rawLogs = await getLogsChunked(publicClient, {
    address: chain.factoryAddress,
    fromBlock: chain.factoryDeployBlock,
    toBlock: "latest",
  });
  const logs = parseEventLogs({ abi: chain.factoryAbi, logs: rawLogs as Log[] }).filter(
    (l) => l.eventName === "VaultCreated",
  );
  if (logs.length === 0) return [];

  const uniqueBlocks = [...new Set(logs.map((l) => l.blockNumber))].filter((bn): bn is bigint => bn !== null);
  const blocks = await Promise.all(uniqueBlocks.map((bn) => publicClient.getBlock({ blockNumber: bn })));
  const blockTimestamps = new Map(uniqueBlocks.map((bn, i) => [bn, Number(blocks[i].timestamp)]));

  return logs.map((l) => {
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
}
