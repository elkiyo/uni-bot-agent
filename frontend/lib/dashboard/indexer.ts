import "server-only";
import { parseEventLogs, type Address } from "viem";
import { supabase } from "../keeper/supabaseClient";
import { getChainRuntime, type ChainRuntime } from "../keeper/wallet";
import { deployedChains } from "../chains";
import { getLogsChunkedMulti } from "../getLogsChunked";
import { withRetry, mapWithConcurrency } from "../concurrency";
import { uniswapV3PoolAbi } from "../contracts";
import { ethPriceFromTick } from "../priceMath";
import { serializeArgs } from "../eventArgsCodec";

const SCAN_CONCURRENCY = 6;
// PostgREST caps a single response at this many rows (db-max-rows) —
// confirmed hit in production 2026-07-25 (see app/api/dashboard/events/
// route.ts's own note). Every query below that lists ALL known vault
// addresses is paginated through this, since silently seeing only the
// first 1000 would mean any vault created after that point stops getting
// its events scanned/priced at all, with no error.
const PAGE_SIZE = 1000;

async function fetchAllRows<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const all: T[] = [];
  for (let page = 0; ; page++) {
    const { data, error } = await build(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    if (error) throw error;
    all.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return all;
}
// Bounds only the Rebalanced/pool-Mint-matching half of backfillMintUsd now
// (PositionInitialized is zero-RPC and unbounded — see that function) — a
// large mint backlog can't blow out a single tick's runtime. Whatever
// doesn't fit gets picked up on the next tick; a mint's USD value is a
// block-pinned fact that never changes once resolved, so there's no
// correctness cost to spreading this across several ticks, only a cosmetic
// delay. History: 80 -> 400 (2026-07-24) once the raw event scan started
// surfacing real mint backlogs (700+ Rebalanced events on Arbitrum alone);
// 400 combined with MAX_SCAN_BLOCKS=1M then caused 3 real /api/cron/tick
// timeouts the same day back when this ran an eth_call-based historical
// read per mint. That approach was replaced entirely (see
// backfillMintUsd's docstring — it could never have worked past ~100
// blocks deep on a public RPC anyway) with a single-block eth_getLogs
// lookup per mint, which is both cheaper AND actually correct. Left at 150
// for now since the timeout was only just fixed — safe to raise again once
// this cheaper path proves itself over a few real ticks.
const MINT_BACKFILL_BATCH = 150;
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
// Raised to 1M (2026-07-24) to finish the cold-start catch-up faster, then
// pulled back the same day after real production timeouts (see
// MINT_BACKFILL_BATCH's own note — the two together, not either alone, is
// what blew the budget). By the time this was reverted the raw scan itself
// had already caught up to near-realtime on both chains (confirmed: within
// ~730 blocks of Arbitrum's chain head), so the large cap isn't needed for
// that part anymore anyway — back to 300k, comfortably proven safe at 500k
// before, with headroom under it this time.
const MAX_SCAN_BLOCKS = 300_000n;

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

  if (
    eventName === "LpFeesPaidToOwner" ||
    eventName === "FeesCollected" ||
    eventName === "PerformanceFeeCollected" ||
    // PositionInitialized carries its own amount0/amount1 directly (unlike
    // Rebalanced — see RangeVaultArb.sol's event, and backfillMintUsd for
    // how Rebalanced gets priced instead) — same token0/token1 -> stable/
    // volatile routing as the fee events above, no RPC needed at all.
    eventName === "PositionInitialized"
  ) {
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
  return null; // Rebalanced needs the pool's own Mint event — see backfillMintUsd. Everything else has no natural USD value.
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
  const vaultRows = await fetchAllRows<{ address: string }>((from, to) =>
    supabase().from("indexed_vaults").select("address").eq("chain_id", chain.id).range(from, to),
  );
  const addresses = vaultRows.map((v) => v.address as Address);
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
    // viem's parseEventLogs returns `args: undefined` (not `{}`) for a
    // zero-parameter event (e.g. a bare marker event) — confirmed in
    // production 2026-07-24: JSON.stringify(undefined) returns the actual
    // JS value `undefined`, not a string, so the JSON.parse round-trip in
    // serializeArgs threw "\"undefined\" is not valid JSON" on the very
    // first such event this multi-address scan encountered, crashing the
    // whole indexer run (both chains, every tick) the moment the wider
    // MAX_SCAN_BLOCKS range reached one.
    const args = (l.args ?? {}) as Record<string, unknown>;
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

/**
 * Resolves usd_value for still-unpriced mint events (PositionInitialized/
 * Rebalanced) — split two ways:
 *
 * - PositionInitialized already carries its own amount0/amount1 (see
 *   cheapUsdValue) — this just re-runs that same cheap conversion against
 *   the row's own already-stored args. Zero RPC calls, not batched/capped
 *   (cheap enough to clear the whole backlog in one pass).
 *
 * - Rebalanced does NOT carry amount0/amount1 on its own event (see
 *   RangeVaultArb.sol) — the mint's real amounts are read from the
 *   underlying Uniswap pool's own `Mint` event in the SAME transaction
 *   instead, via a single-block eth_getLogs call. This replaced an
 *   eth_call-based positions()/slot0() read at that historical block
 *   (2026-07-25): confirmed in production that a public RPC only retains
 *   state ~100 blocks deep, so that approach could NEVER have resolved
 *   anything past the freshest few mints, no matter how many ticks ran —
 *   eth_getLogs has no such depth limit, confirmed working across this
 *   platform's entire history. Uses each vault's OWN pool (not chain.pool,
 *   the default) — a vault on a non-default fee-tier pool would otherwise
 *   get silently mispriced, same class of bug fixed in monitor.ts's
 *   out-of-range check.
 */
async function backfillMintUsd(chain: ChainRuntime): Promise<void> {
  const ethPrice = await currentEthPrice(chain);

  const initRows = await fetchAllRows<{ id: number; args: Record<string, unknown> }>((from, to) =>
    supabase()
      .from("indexed_events")
      .select("id,args")
      .eq("chain_id", chain.id)
      .eq("event_name", "PositionInitialized")
      .is("usd_value", null)
      .range(from, to),
  );
  for (const row of initRows) {
    const usd = cheapUsdValue("PositionInitialized", row.args, chain, ethPrice);
    if (usd === null) continue;
     
    const { error } = await supabase().from("indexed_events").update({ usd_value: usd }).eq("id", row.id);
    if (error) throw error;
  }

  const { data, error: rebalErr } = await supabase()
    .from("indexed_events")
    .select("id,address,block_number,tx_hash")
    .eq("chain_id", chain.id)
    .eq("event_name", "Rebalanced")
    .is("usd_value", null)
    .limit(MINT_BACKFILL_BATCH);
  if (rebalErr) throw rebalErr;
  const rebalRows = (data ?? []) as { id: number; address: string; block_number: string; tx_hash: string }[];
  if (rebalRows.length === 0) return;

  const vaultRows = await fetchAllRows<{ address: string; pool: string }>((from, to) =>
    supabase().from("indexed_vaults").select("address,pool").eq("chain_id", chain.id).range(from, to),
  );
  const poolByAddress = new Map(vaultRows.map((v) => [v.address.toLowerCase(), v.pool as Address]));

  await mapWithConcurrency(rebalRows, SCAN_CONCURRENCY, async (row) => {
    const pool = poolByAddress.get(row.address.toLowerCase());
    if (!pool) return;
    const blockNumber = BigInt(row.block_number);

    let mintLogs;
    try {
      mintLogs = await withRetry(() =>
        chain.publicClient.getContractEvents({
          address: pool,
          abi: uniswapV3PoolAbi,
          eventName: "Mint",
          fromBlock: blockNumber,
          toBlock: blockNumber,
        }),
      );
    } catch {
      return; // transient RPC error — retried next tick
    }

    const match = mintLogs.find((l) => {
      const args = l.args as { owner?: Address } | undefined;
      return l.transactionHash?.toLowerCase() === row.tx_hash.toLowerCase() && args?.owner?.toLowerCase() === row.address.toLowerCase();
    });
    if (!match) return; // no matching pool Mint in this exact block for this vault — leave null, shouldn't normally happen

    const args = match.args as { amount0: bigint; amount1: bigint };
    const stableRaw = chain.stableIsToken0 ? args.amount0 : args.amount1;
    const volatileRaw = chain.stableIsToken0 ? args.amount1 : args.amount0;
    const usd = Number(stableRaw) * 1e-6 + Number(volatileRaw) * 1e-18 * ethPrice;

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
