import "server-only";
import { parseEventLogs, type Address } from "viem";
import { supabase } from "../keeper/supabaseClient";
import { getChainRuntime, type ChainRuntime } from "../keeper/wallet";
import { deployedChains } from "../chains";
import { getLogsChunkedMulti } from "../getLogsChunked";
import { withRetry, mapWithConcurrency } from "../concurrency";
import { positionManagerAbi, uniswapV3PoolAbi } from "../contracts";
import { ethPriceFromTick } from "../priceMath";
import { estimatePositionAmounts } from "../keeper/swapMath";
import { serializeArgs } from "../eventArgsCodec";

const SCAN_CONCURRENCY = 6;
// Bounded so a chain with a large mint backlog (first run after this
// feature ships, or a long gap while the indexer was broken) can't blow out
// a single tick's runtime — same reasoning as mintVolume.ts's old MAX_MINTS
// cap. Whatever doesn't fit gets picked up on the next tick; a mint's USD
// value is a historical, block-pinned read that never changes once
// resolved, so there's no correctness cost to spreading the backfill
// across several ticks, only a cosmetic delay before it shows up.
const MINT_BACKFILL_BATCH = 80;
// Caps how much of a chain's history one indexer run advances through —
// same reasoning as MINT_BACKFILL_BATCH, but for the raw eth_getLogs scans
// themselves. Confirmed necessary in production (2026-07-24): a cold-start
// backlog spanning the factory's whole lifetime (the common case right
// after this feature ships) blew the tick route's 200s maxDuration —
// getLogsChunked's own "re-verify empty chunks" resilience against
// forno.celo.org's flakiness means a mostly-empty backlog costs up to 5x
// the request count its chunk count alone would suggest. The checkpoint
// (indexer_state) advances by exactly this much each run regardless of how
// many logs were actually found, so a large backlog just takes several
// ticks to fully catch up — each individual tick stays fast and safe, and
// once caught up to near-realtime this cap is never actually hit. Started
// at 150k blocks/run, confirmed safe in production (2026-07-24, no
// timeouts, ~490-450k blocks of real chunk activity resolved within a
// couple ticks) — raised to 500k for a faster cold-start catch-up (Celo
// ~755k blocks, Arbitrum ~2.33M backlog measured the same day): 100 chunks
// of 5000 at concurrency 6 is 17 sequential batches, worst case (every
// chunk empty, full 5x re-verify retries) still well under a minute,
// leaving wide headroom under the 200s ceiling for the rest of the tick.
const MAX_SCAN_BLOCKS = 500_000n;

async function getIndexerState(key: string): Promise<bigint> {
  const { data, error } = await supabase().from("indexer_state").select("value").eq("key", key).maybeSingle();
  if (error) throw error;
  return data ? BigInt(data.value as string) : 0n;
}

async function setIndexerState(key: string, value: bigint): Promise<void> {
  const { error } = await supabase().from("indexer_state").upsert({ key, value: value.toString() });
  if (error) throw error;
}

interface VaultCreatedArgs {
  owner: Address;
  vault: Address;
  pool: Address;
  token0: Address;
  token1: Address;
  fee: number;
}

async function indexVaultDirectory(chain: ChainRuntime, factoryAddress: Address): Promise<void> {
  const key = `directory:${chain.id}`;
  const latest = await chain.publicClient.getBlockNumber();
  let fromBlock = await getIndexerState(key);
  if (fromBlock === 0n) fromBlock = chain.factoryDeployBlock;
  if (fromBlock > latest) return;
  const toBlock = fromBlock + MAX_SCAN_BLOCKS - 1n > latest ? latest : fromBlock + MAX_SCAN_BLOCKS - 1n;

  const rawLogs = await getLogsChunkedMulti(chain.publicClient, {
    address: [factoryAddress],
    fromBlock,
    toBlock,
  });
  const logs = parseEventLogs({ abi: chain.factoryAbi, logs: rawLogs }).filter(
    (l) => l.eventName === "VaultCreated",
  );

  if (logs.length > 0) {
    const uniqueBlocks = [...new Set(logs.map((l) => l.blockNumber))].filter((bn): bn is bigint => bn !== null);
    const blocks = await mapWithConcurrency(uniqueBlocks, SCAN_CONCURRENCY, (bn) =>
      chain.publicClient.getBlock({ blockNumber: bn }),
    );
    const timestampByBlock = new Map(uniqueBlocks.map((bn, i) => [bn, Number(blocks[i].timestamp)]));

    const rows = logs.map((l) => {
      const a = l.args as unknown as VaultCreatedArgs;
      const blockNumber = l.blockNumber ?? 0n;
      return {
        chain_id: chain.id,
        address: a.vault.toLowerCase(),
        owner: a.owner,
        pool: a.pool,
        token0: a.token0,
        token1: a.token1,
        fee: a.fee,
        created_at_block: blockNumber.toString(),
        created_at: new Date((timestampByBlock.get(blockNumber) ?? 0) * 1000).toISOString(),
        tx_hash: l.transactionHash,
      };
    });
    const { error } = await supabase().from("indexed_vaults").upsert(rows, { onConflict: "chain_id,address" });
    if (error) throw error;
  }
  await setIndexerState(key, toBlock);
}

function cheapUsdValue(
  eventName: string,
  args: Record<string, unknown>,
  chain: ChainRuntime,
  ethPrice: number,
): number | null {
  const toUsd = (stableRaw: unknown, volatileRaw: unknown) =>
    Number((stableRaw as bigint) ?? 0n) * 1e-6 + Number((volatileRaw as bigint) ?? 0n) * 1e-18 * ethPrice;

  if (eventName === "LpFeesPaidToOwner" || eventName === "FeesCollected" || eventName === "PerformanceFeeCollected") {
    const stableRaw = chain.stableIsToken0 ? args.amount0 : args.amount1;
    const volatileRaw = chain.stableIsToken0 ? args.amount1 : args.amount0;
    return toUsd(stableRaw, volatileRaw);
  }
  if (eventName === "KeeperGasReimbursed") {
    return Number((args.amountUsd as bigint) ?? 0n) * 1e-6;
  }
  if (eventName === "Deposited") {
    const total =
      ((args.investableAmount as bigint) ?? 0n) +
      ((args.reserveAmount as bigint) ?? 0n) +
      ((args.gasReserveAmount as bigint) ?? 0n);
    return Number(total) * 1e-6;
  }
  return null; // PositionInitialized/Rebalanced need a historical read — see backfillMintUsd. Everything else has no natural USD value.
}

async function currentEthPrice(chain: ChainRuntime): Promise<number> {
  const slot0 = (await chain.publicClient.readContract({
    address: chain.pool,
    abi: uniswapV3PoolAbi,
    functionName: "slot0",
  })) as readonly [bigint, number, ...unknown[]];
  return ethPriceFromTick(slot0[1], chain.stableIsToken0);
}

async function indexVaultEvents(chain: ChainRuntime): Promise<void> {
  const key = `events:${chain.id}`;
  const { data: vaultRows, error: vaultErr } = await supabase()
    .from("indexed_vaults")
    .select("address")
    .eq("chain_id", chain.id);
  if (vaultErr) throw vaultErr;
  const addresses = ((vaultRows ?? []) as { address: string }[]).map((v) => v.address as Address);
  if (addresses.length === 0) return;

  const latest = await chain.publicClient.getBlockNumber();
  let fromBlock = await getIndexerState(key);
  if (fromBlock === 0n) fromBlock = chain.factoryDeployBlock;
  if (fromBlock > latest) return;
  const toBlock = fromBlock + MAX_SCAN_BLOCKS - 1n > latest ? latest : fromBlock + MAX_SCAN_BLOCKS - 1n;

  const rawLogs = await getLogsChunkedMulti(chain.publicClient, { address: addresses, fromBlock, toBlock });
  if (rawLogs.length === 0) {
    await setIndexerState(key, toBlock);
    return;
  }

  const parsed = parseEventLogs({ abi: chain.vaultAbi, logs: rawLogs }).filter(
    (l) => l.blockNumber !== null && l.transactionHash !== null && l.logIndex !== null,
  );
  if (parsed.length === 0) {
    await setIndexerState(key, toBlock);
    return;
  }

  const uniqueBlocks = [...new Set(parsed.map((l) => l.blockNumber as bigint))];
  const blocks = await mapWithConcurrency(uniqueBlocks, SCAN_CONCURRENCY, (bn) =>
    chain.publicClient.getBlock({ blockNumber: bn }),
  );
  const timestampByBlock = new Map(uniqueBlocks.map((bn, i) => [bn, Number(blocks[i].timestamp)]));
  const ethPrice = await currentEthPrice(chain);

  const rows = parsed.map((l) => {
    const args = l.args as Record<string, unknown>;
    const blockNumber = l.blockNumber as bigint;
    return {
      chain_id: chain.id,
      address: (l.address as string).toLowerCase(),
      event_name: l.eventName,
      args: serializeArgs(args),
      block_number: blockNumber.toString(),
      log_index: l.logIndex as number,
      tx_hash: l.transactionHash as string,
      block_timestamp: new Date((timestampByBlock.get(blockNumber) ?? 0) * 1000).toISOString(),
      usd_value: cheapUsdValue(l.eventName, args, chain, ethPrice),
    };
  });

  // Postgres/PostgREST have a practical per-request row cap — batch the upsert.
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase()
      .from("indexed_events")
      .upsert(rows.slice(i, i + 500), { onConflict: "chain_id,tx_hash,log_index" });
    if (error) throw error;
  }
  await setIndexerState(key, toBlock);
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

async function computeMintUsd(
  chain: ChainRuntime,
  pool: Address,
  tokenId: bigint,
  blockNumber: bigint,
): Promise<number | null> {
  try {
    return await withRetry(async () => {
      const [position, slot0] = await Promise.all([
        chain.publicClient.readContract({
          address: chain.positionManager,
          abi: positionManagerAbi,
          functionName: "positions",
          args: [tokenId],
          blockNumber,
        }) as Promise<PositionTuple>,
        chain.publicClient.readContract({
          address: pool,
          abi: uniswapV3PoolAbi,
          functionName: "slot0",
          blockNumber,
        }) as Promise<readonly [bigint, number, ...unknown[]]>,
      ]);
      const [, , , , , tickLower, tickUpper, liquidity] = position;
      const currentTick = slot0[1];
      const ethPrice = ethPriceFromTick(currentTick, chain.stableIsToken0);
      const { amount0Raw, amount1Raw } = estimatePositionAmounts({ liquidity, currentTick, tickLower, tickUpper });
      const stableRaw = chain.stableIsToken0 ? amount0Raw : amount1Raw;
      const volatileRaw = chain.stableIsToken0 ? amount1Raw : amount0Raw;
      return stableRaw * 1e-6 + volatileRaw * 1e-18 * ethPrice;
    });
  } catch {
    return null; // RPC couldn't serve this historical block even after retrying — leave null, retried next tick.
  }
}

/**
 * Resolves the USD value of a bounded batch of still-unpriced mint events
 * (PositionInitialized/Rebalanced) — the one kind of event whose value needs
 * an expensive historical position+pool read instead of a cheap current-price
 * conversion. Uses each vault's OWN pool (not chain.pool, the chain's
 * default) — a vault on a non-default fee-tier pool would otherwise get
 * silently mispriced against the wrong pool's tick, same class of bug fixed
 * in monitor.ts's out-of-range check.
 */
async function backfillMintUsd(chain: ChainRuntime): Promise<void> {
  const { data, error } = await supabase()
    .from("indexed_events")
    .select("id,address,event_name,args,block_number")
    .eq("chain_id", chain.id)
    .in("event_name", ["PositionInitialized", "Rebalanced"])
    .is("usd_value", null)
    .limit(MINT_BACKFILL_BATCH);
  if (error) throw error;
  const rows = (data ?? []) as {
    id: number;
    address: string;
    event_name: string;
    args: Record<string, unknown>;
    block_number: string;
  }[];
  if (rows.length === 0) return;

  const { data: vaultRows, error: vaultErr } = await supabase()
    .from("indexed_vaults")
    .select("address,pool")
    .eq("chain_id", chain.id);
  if (vaultErr) throw vaultErr;
  const poolByAddress = new Map(
    ((vaultRows ?? []) as { address: string; pool: string }[]).map((v) => [v.address.toLowerCase(), v.pool as Address]),
  );

  await mapWithConcurrency(rows, SCAN_CONCURRENCY, async (row) => {
    const pool = poolByAddress.get(row.address.toLowerCase());
    if (!pool) return;
    const tokenIdRaw = row.event_name === "PositionInitialized" ? row.args.tokenId : row.args.newTokenId;
    if (tokenIdRaw === undefined || tokenIdRaw === null) return;
    const usd = await computeMintUsd(chain, pool, BigInt(tokenIdRaw as string), BigInt(row.block_number));
    if (usd === null) return;
    const { error: updateErr } = await supabase().from("indexed_events").update({ usd_value: usd }).eq("id", row.id);
    if (updateErr) throw updateErr;
  });
}

/**
 * Refreshes the dashboard read-cache for every deployed chain — vault
 * directory, raw event history, and the mint-value backfill, in that order
 * (each later step depends on the one before it having run at least once).
 * Called from app/api/cron/tick/route.ts right after runTick(), so it rides
 * the same 5-minute schedule with no extra ops setup. Wrapped per-chain so
 * one chain's failure doesn't block another's, and the caller wraps this
 * whole call so an indexer bug can never fail the actual trading tick.
 */
export async function runIndexer(): Promise<void> {
  for (const chainDef of deployedChains()) {
    const chain = getChainRuntime(chainDef);
    try {
      await indexVaultDirectory(chain, chainDef.factoryAddress);
      await indexVaultEvents(chain);
      await backfillMintUsd(chain);
    } catch (err) {
      console.error(`indexer failed for chain ${chain.name}:`, err);
    }
  }
}
