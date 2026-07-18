import type { Log, PublicClient } from "viem";

const MAX_BLOCK_RANGE = 5_000n;

/**
 * forno.celo.org caps a single eth_getLogs call at 5000 blocks ("query
 * exceeds range" otherwise). A plain `publicClient.getLogs({ fromBlock:
 * FACTORY_DEPLOY_BLOCK, toBlock: "latest" })` works right after a fresh
 * deploy (small range) and then starts silently failing a few hours later
 * once more than 5000 blocks have passed (~7h at Celo's ~5s block time) —
 * confirmed live 2026-07-14 (ActivityFeed/useVaultFeesSummary/PositionHistory
 * all went blank for a vault created earlier that same day). Chunk instead,
 * same approach as lib/keeper/discovery.ts's server-side scan.
 */
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
 */
export async function getLogsChunkedMulti(
  publicClient: PublicClient,
  params: { address: readonly `0x${string}`[]; fromBlock: bigint; toBlock: bigint | "latest" },
): Promise<Log[]> {
  if (params.address.length === 0) return [];
  const latest = params.toBlock === "latest" ? await publicClient.getBlockNumber() : params.toBlock;
  const logs: Log[] = [];
  let from = params.fromBlock;
  while (from <= latest) {
    const to = from + MAX_BLOCK_RANGE - 1n > latest ? latest : from + MAX_BLOCK_RANGE - 1n;
    const chunk = await publicClient.getLogs({ address: params.address as `0x${string}`[], fromBlock: from, toBlock: to });
    logs.push(...chunk);
    from = to + 1n;
  }
  return logs;
}
