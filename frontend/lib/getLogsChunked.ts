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
  const latest = params.toBlock === "latest" ? await publicClient.getBlockNumber() : params.toBlock;
  const logs: Log[] = [];
  let from = params.fromBlock;
  while (from <= latest) {
    const to = from + MAX_BLOCK_RANGE - 1n > latest ? latest : from + MAX_BLOCK_RANGE - 1n;
    const chunk = await publicClient.getLogs({ address: params.address, fromBlock: from, toBlock: to });
    logs.push(...chunk);
    from = to + 1n;
  }
  return logs;
}
