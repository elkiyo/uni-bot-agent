import "server-only";
import { parseEventLogs, type Address } from "viem";
import { supabase } from "../keeper/supabaseClient";
import { getChainRuntime, type ChainRuntime } from "../keeper/wallet";
import { deployedChains } from "../chains";
import { getLogsChunkedMulti } from "../getLogsChunked";
import { withRetry, mapWithConcurrency } from "../concurrency";
import { uniswapV3PoolAbi, erc20Abi } from "../contracts";
import { ethPriceFromTick } from "../priceMath";
import { serializeArgs } from "../eventArgsCodec";

/** A single indexed vault's own pair, exactly like lib/keeper/pairInfo.ts's
 * VaultPairInfo — kept as a separate (structurally identical) type since this
 * module reads it from indexed_vaults, a completely different table than the
 * keeper's own keeper_vaults, and the two subsystems are deliberately never
 * coupled (see schema.sql's own note on why indexed_vaults/indexed_events are
 * kept separate from the keeper's trading-critical bookkeeping). */
interface IndexedVaultPair {
  pool: Address;
  stableIsToken0: boolean;
  stableDecimals: number;
  volatileDecimals: number;
}

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

async function indexVaultDirectory(
  chain: ChainRuntime,
  factoryAddress: Address,
  kind: "standard" | "compound" = "standard",
  factoryAbi: ChainRuntime["factoryAbi"] = chain.factoryAbi,
): Promise<void> {
  // Per-kind checkpoint/state key — same reasoning as the keeper's own
  // discovery.ts: a chain with two factories scans each independently, so a
  // slow/late-deployed compound factory never gets its fromBlock accidentally
  // advanced past real events by the OTHER factory's scan finishing first.
  const key = kind === "compound" ? `directory:${chain.id}:compound` : `directory:${chain.id}`;
  const latest = await chain.publicClient.getBlockNumber();
  let fromBlock = await getIndexerState(key);
  if (fromBlock === 0n) {
    fromBlock = kind === "compound" ? (chain.compoundFactoryDeployBlock ?? chain.factoryDeployBlock) : chain.factoryDeployBlock;
  }
  if (fromBlock > latest) return;
  const toBlock = fromBlock + MAX_SCAN_BLOCKS - 1n > latest ? latest : fromBlock + MAX_SCAN_BLOCKS - 1n;

  const rawLogs = await getLogsChunkedMulti(chain.publicClient, {
    address: [factoryAddress],
    fromBlock,
    toBlock,
  });
  const logs = parseEventLogs({ abi: factoryAbi, logs: rawLogs }).filter(
    (l) => l.eventName === "VaultCreated",
  );

  if (logs.length > 0) {
    const uniqueBlocks = [...new Set(logs.map((l) => l.blockNumber))].filter((bn): bn is bigint => bn !== null);
    const blocks = await mapWithConcurrency(uniqueBlocks, SCAN_CONCURRENCY, (bn) =>
      chain.publicClient.getBlock({ blockNumber: bn }),
    );
    const timestampByBlock = new Map(uniqueBlocks.map((bn, i) => [bn, Number(blocks[i].timestamp)]));

    // Resolved once per new vault here (stableIsToken0()/decimals() — NOT
    // derivable from token0/token1 alone, see schema.sql's own note on these
    // columns) and cached in indexed_vaults forever, same one-time-read
    // pattern as lib/keeper/pairInfo.ts on the keeper side. Best-effort: a
    // vault whose read fails here just gets picked up by
    // backfillVaultPairInfo() below on a later tick instead of failing the
    // whole directory scan.
    const pairByVault = new Map<string, IndexedVaultPair>();
    await mapWithConcurrency(logs, SCAN_CONCURRENCY, async (l) => {
      const a = l.args as unknown as VaultCreatedArgs;
      try {
        const pair = await readIndexedVaultPair(chain, a.vault);
        pairByVault.set(a.vault.toLowerCase(), pair);
      } catch (err) {
        console.error(`Failed to resolve pair info for vault ${a.vault}, will backfill lazily:`, err);
      }
    });

    const rows = logs.map((l) => {
      const a = l.args as unknown as VaultCreatedArgs;
      const blockNumber = l.blockNumber ?? 0n;
      const pair = pairByVault.get(a.vault.toLowerCase());
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
        stable_is_token0: pair?.stableIsToken0 ?? null,
        stable_decimals: pair?.stableDecimals ?? null,
        volatile_decimals: pair?.volatileDecimals ?? null,
        kind,
      };
    });
    const { error } = await supabase().from("indexed_vaults").upsert(rows, { onConflict: "chain_id,address" });
    if (error) throw error;
  }
  await setIndexerState(key, toBlock);
}

// Minimal fragment shared with lib/keeper/pairInfo.ts's own resolution —
// stableIsToken0() exists on the Arbitrum vault family (standard and
// compound alike) but NOT on Celo's original RangeVault.sol, which hardcodes
// token0 as the stable leg by construction (see pairInfo.ts's own fix for
// the identical bug on the keeper side, confirmed live 2026-07-27). This
// narrow, hand-written fragment works for either ABI that DOES have it,
// without needing to import the full ABI just for one function.
const stableIsToken0Abi = [
  { type: "function", name: "stableIsToken0", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
] as const;

/** Reads a vault's own pair directly — pool from indexed_vaults isn't
 * available yet at indexVaultDirectory's call site (that row doesn't exist
 * until AFTER this resolves), so this takes pool explicitly rather than
 * looking it up. */
async function readIndexedVaultPair(chain: ChainRuntime, vaultAddress: Address, pool?: Address): Promise<IndexedVaultPair> {
  // .catch() (not a static check against chain.vaultAbi) because an
  // EIP-1167 clone's real behavior comes from whatever implementation it was
  // pointed at when created — an Arbitrum vault cloned before this getter
  // was added to the implementation genuinely reverts on this call too, even
  // though today's ABI lists it (confirmed live 2026-07-27, vault
  // 0xcb7b1964...e00c22). Falls back to this chain's own known default
  // rather than hardcoding `true`, since that default differs per chain.
  const [stableIsToken0, token0, token1, resolvedPool] = await Promise.all([
    chain.publicClient
      .readContract({ address: vaultAddress, abi: stableIsToken0Abi, functionName: "stableIsToken0" })
      .catch(() => chain.stableIsToken0),
    chain.publicClient.readContract({ address: vaultAddress, abi: chain.vaultAbi, functionName: "token0" }) as Promise<Address>,
    chain.publicClient.readContract({ address: vaultAddress, abi: chain.vaultAbi, functionName: "token1" }) as Promise<Address>,
    pool
      ? Promise.resolve(pool)
      : (chain.publicClient.readContract({ address: vaultAddress, abi: chain.vaultAbi, functionName: "pool" }) as Promise<Address>),
  ]);
  const stableToken = stableIsToken0 ? token0 : token1;
  const volatileToken = stableIsToken0 ? token1 : token0;
  const [stableDecimals, volatileDecimals] = await Promise.all([
    chain.publicClient.readContract({ address: stableToken, abi: erc20Abi, functionName: "decimals" }) as Promise<number>,
    chain.publicClient.readContract({ address: volatileToken, abi: erc20Abi, functionName: "decimals" }) as Promise<number>,
  ]);
  return { pool: resolvedPool, stableIsToken0, stableDecimals, volatileDecimals };
}

/** Self-heals any indexed_vaults row left with a null pair (a legacy row
 * from before these columns existed, or one whose resolution failed at
 * directory-scan time) — same "lazy backfill" pattern as
 * lib/keeper/pairInfo.ts's resolveVaultPair, just batched across every
 * pending row at once instead of one-at-a-time on demand, since this table
 * has no per-request caller waiting on the result. */
async function backfillVaultPairInfo(chain: ChainRuntime): Promise<void> {
  const { data, error } = await supabase()
    .from("indexed_vaults")
    .select("address,pool")
    .eq("chain_id", chain.id)
    .is("stable_is_token0", null);
  if (error) throw error;
  const rows = (data ?? []) as { address: string; pool: string }[];
  if (rows.length === 0) return;

  await mapWithConcurrency(rows, SCAN_CONCURRENCY, async (row) => {
    try {
      const pair = await readIndexedVaultPair(chain, row.address as Address, row.pool as Address);
      const { error: updateErr } = await supabase()
        .from("indexed_vaults")
        .update({
          stable_is_token0: pair.stableIsToken0,
          stable_decimals: pair.stableDecimals,
          volatile_decimals: pair.volatileDecimals,
        })
        .eq("chain_id", chain.id)
        .eq("address", row.address);
      if (updateErr) throw updateErr;
    } catch (err) {
      console.error(`Failed to backfill pair info for indexed vault ${row.address}, will retry next tick:`, err);
    }
  });
}

function cheapUsdValue(eventName: string, args: Record<string, unknown>, pair: IndexedVaultPair, ethPrice: number): number | null {
  const toUsd = (stableRaw: unknown, volatileRaw: unknown) =>
    Number((stableRaw as bigint) ?? 0n) * 10 ** -pair.stableDecimals +
    Number((volatileRaw as bigint) ?? 0n) * 10 ** -pair.volatileDecimals * ethPrice;

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
    const stableRaw = pair.stableIsToken0 ? args.amount0 : args.amount1;
    const volatileRaw = pair.stableIsToken0 ? args.amount1 : args.amount0;
    return toUsd(stableRaw, volatileRaw);
  }
  if (eventName === "KeeperGasReimbursed") {
    return Number((args.amountUsd as bigint) ?? 0n) * 10 ** -pair.stableDecimals;
  }
  // Compound-only — already converted to stable-raw units by the contract
  // itself (_toStableUsd) at the exact moment of reinjection, used as-is.
  if (eventName === "FeesReinjected") {
    return Number((args.netFeeUsd as bigint) ?? 0n) * 10 ** -pair.stableDecimals;
  }
  if (eventName === "Deposited") {
    const total =
      ((args.investableAmount as bigint) ?? 0n) +
      ((args.reserveAmount as bigint) ?? 0n) +
      ((args.gasReserveAmount as bigint) ?? 0n);
    return Number(total) * 10 ** -pair.stableDecimals;
  }
  return null; // Rebalanced needs the pool's own Mint event — see backfillMintUsd. Everything else has no natural USD value.
}

async function ethPriceForPair(chain: ChainRuntime, pair: IndexedVaultPair): Promise<number> {
  const slot0 = (await chain.publicClient.readContract({
    address: pair.pool,
    abi: uniswapV3PoolAbi,
    functionName: "slot0",
  })) as readonly [bigint, number, ...unknown[]];
  return ethPriceFromTick(slot0[1], pair.stableIsToken0, pair.stableDecimals, pair.volatileDecimals);
}

async function indexVaultEvents(chain: ChainRuntime): Promise<void> {
  const key = `events:${chain.id}`;
  const vaultRows = await fetchAllRows<{
    address: string;
    pool: string;
    stable_is_token0: boolean | null;
    stable_decimals: number | null;
    volatile_decimals: number | null;
    kind: string | null;
  }>((from, to) =>
    supabase()
      .from("indexed_vaults")
      .select("address,pool,stable_is_token0,stable_decimals,volatile_decimals,kind")
      .eq("chain_id", chain.id)
      .range(from, to),
  );
  const addresses = vaultRows.map((v) => v.address as Address);
  if (addresses.length === 0) return;

  // Which ABI each vault's own logs need to be decoded with — compound-only
  // events (FeesReinjected, etc.) don't exist on the standard ABI at all, so
  // decoding EVERY vault's logs with a single shared ABI would silently drop
  // them. Kept per-vault rather than one shared parse call for the opposite
  // reason too: several events (Deposited, Rebalanced, ...) have IDENTICAL
  // signatures on both ABIs, so decoding a standard vault's logs with the
  // compound ABI as well would double-count them.
  const kindByVault = new Map<string, "standard" | "compound">(
    vaultRows.map((v) => [v.address.toLowerCase(), v.kind === "compound" ? "compound" : "standard"]),
  );

  // Per-vault pair — a row whose pair hasn't been resolved yet (null, see
  // backfillVaultPairInfo) falls back to the CHAIN's own default pair rather
  // than skipping pricing entirely: every vault predating multi-pair really
  // is on that default pair, so this is a correct value, not a guess, for
  // every vault that exists today; only matters as a genuine approximation
  // once a non-default-pair vault's row hasn't been backfilled yet, a narrow
  // window (one indexer tick) this same call also actively closes.
  const pairByVault = new Map<string, IndexedVaultPair>(
    vaultRows.map((v) => [
      v.address.toLowerCase(),
      {
        pool: v.pool as Address,
        stableIsToken0: v.stable_is_token0 ?? chain.stableIsToken0,
        stableDecimals: v.stable_decimals ?? chain.stableDecimals,
        volatileDecimals: v.volatile_decimals ?? chain.volatileDecimals,
      },
    ]),
  );

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

  const standardLogs = rawLogs.filter((l) => kindByVault.get(l.address.toLowerCase()) !== "compound");
  const compoundLogs = rawLogs.filter((l) => kindByVault.get(l.address.toLowerCase()) === "compound");
  const parsed = [
    ...parseEventLogs({ abi: chain.vaultAbi, logs: standardLogs }),
    ...(chain.compoundVaultAbi && compoundLogs.length > 0
      ? parseEventLogs({ abi: chain.compoundVaultAbi, logs: compoundLogs })
      : []),
  ].filter((l) => l.blockNumber !== null && l.transactionHash !== null && l.logIndex !== null);
  if (parsed.length === 0) {
    await setIndexerState(key, toBlock);
    return;
  }

  const uniqueBlocks = [...new Set(parsed.map((l) => l.blockNumber as bigint))];
  const blocks = await mapWithConcurrency(uniqueBlocks, SCAN_CONCURRENCY, (bn) =>
    chain.publicClient.getBlock({ blockNumber: bn }),
  );
  const timestampByBlock = new Map(uniqueBlocks.map((bn, i) => [bn, Number(blocks[i].timestamp)]));

  // One live price PER POOL, not per vault — several vaults on the same
  // pair/pool (the common case) share a single quote instead of each paying
  // for its own redundant slot0() read.
  const uniquePools = [...new Set([...pairByVault.values()].map((p) => p.pool))];
  const priceByPool = new Map<Address, number>(
    await mapWithConcurrency(uniquePools, SCAN_CONCURRENCY, async (pool) => {
      const pair = [...pairByVault.values()].find((p) => p.pool === pool)!;
      return [pool, await ethPriceForPair(chain, pair)] as const;
    }),
  );

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
    const address = (l.address as string).toLowerCase();
    const pair = pairByVault.get(address);
    const ethPrice = pair ? priceByPool.get(pair.pool) : undefined;
    return {
      chain_id: chain.id,
      address,
      event_name: l.eventName,
      args: serializeArgs(args),
      block_number: blockNumber.toString(),
      log_index: l.logIndex as number,
      tx_hash: l.transactionHash as string,
      block_timestamp: new Date((timestampByBlock.get(blockNumber) ?? 0) * 1000).toISOString(),
      usd_value: pair && ethPrice !== undefined ? cheapUsdValue(l.eventName, args, pair, ethPrice) : null,
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
 *
 *   Matched by tx_hash ALONE, not also by the Mint event's own `owner` —
 *   confirmed directly on-chain 2026-07-25 (vault 0x53b70e6a...,
 *   tx 0x9fb85430...) that a pool's Mint event always reports `owner` as
 *   the NonfungiblePositionManager CONTRACT address, never the vault that
 *   actually requested the mint (the position manager holds the pool-level
 *   liquidity on every user's behalf; per-owner accounting only exists at
 *   the NFT/tokenId level, not in the pool's own event). Filtering on that
 *   owner field made every match silently fail, leaving this whole path
 *   dead code in practice — and a handful of Rebalanced rows already
 *   carried a WRONG usd_value from the eth_call approach this replaced
 *   (garbage from reading a nearly-pruned block rather than cleanly
 *   erroring), which is why every Rebalanced row's usd_value was reset to
 *   null in Supabase before this fix shipped, so they all get correctly
 *   recomputed from here instead of keeping stale bad numbers. A single
 *   rebalance transaction only ever contains one relevant pool mint, so
 *   tx_hash alone is already an exact, unambiguous match.
 */
async function backfillMintUsd(chain: ChainRuntime): Promise<void> {
  const vaultRows = await fetchAllRows<{
    address: string;
    pool: string;
    stable_is_token0: boolean | null;
    stable_decimals: number | null;
    volatile_decimals: number | null;
  }>((from, to) =>
    supabase()
      .from("indexed_vaults")
      .select("address,pool,stable_is_token0,stable_decimals,volatile_decimals")
      .eq("chain_id", chain.id)
      .range(from, to),
  );
  // Same "fall back to the chain default for a not-yet-backfilled row"
  // reasoning as indexVaultEvents above.
  const pairByAddress = new Map<string, IndexedVaultPair>(
    vaultRows.map((v) => [
      v.address.toLowerCase(),
      {
        pool: v.pool as Address,
        stableIsToken0: v.stable_is_token0 ?? chain.stableIsToken0,
        stableDecimals: v.stable_decimals ?? chain.stableDecimals,
        volatileDecimals: v.volatile_decimals ?? chain.volatileDecimals,
      },
    ]),
  );
  const priceCache = new Map<Address, number>();
  async function priceForPool(pair: IndexedVaultPair): Promise<number> {
    const cached = priceCache.get(pair.pool);
    if (cached !== undefined) return cached;
    const price = await ethPriceForPair(chain, pair);
    priceCache.set(pair.pool, price);
    return price;
  }

  const initRows = await fetchAllRows<{ id: number; address: string; args: Record<string, unknown> }>((from, to) =>
    supabase()
      .from("indexed_events")
      .select("id,address,args")
      .eq("chain_id", chain.id)
      .eq("event_name", "PositionInitialized")
      .is("usd_value", null)
      .range(from, to),
  );
  for (const row of initRows) {
    const pair = pairByAddress.get(row.address.toLowerCase());
    if (!pair) continue; // this vault's own row hasn't indexed yet — retried next tick
    const ethPrice = await priceForPool(pair);
    const usd = cheapUsdValue("PositionInitialized", row.args, pair, ethPrice);
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

  await mapWithConcurrency(rebalRows, SCAN_CONCURRENCY, async (row) => {
    const pair = pairByAddress.get(row.address.toLowerCase());
    if (!pair) return;
    const blockNumber = BigInt(row.block_number);

    let mintLogs;
    try {
      mintLogs = await withRetry(() =>
        chain.publicClient.getContractEvents({
          address: pair.pool,
          abi: uniswapV3PoolAbi,
          eventName: "Mint",
          fromBlock: blockNumber,
          toBlock: blockNumber,
        }),
      );
    } catch {
      return; // transient RPC error — retried next tick
    }

    const match = mintLogs.find((l) => l.transactionHash?.toLowerCase() === row.tx_hash.toLowerCase());
    if (!match) return; // no pool Mint found in this exact block for this tx — leave null, shouldn't normally happen

    const args = match.args as { amount0: bigint; amount1: bigint };
    const stableRaw = pair.stableIsToken0 ? args.amount0 : args.amount1;
    const volatileRaw = pair.stableIsToken0 ? args.amount1 : args.amount0;
    const ethPrice = await priceForPool(pair);
    const usd = Number(stableRaw) * 10 ** -pair.stableDecimals + Number(volatileRaw) * 10 ** -pair.volatileDecimals * ethPrice;

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
      // Second factory, compound-interest vaults — Arbitrum only today (see
      // chains.ts's ChainDef docstring on compoundFactoryAddress). Undefined
      // on every other chain, so this whole block is a no-op there. Same
      // pattern as the keeper's own tick.ts.
      if (chainDef.compoundFactoryAddress && chainDef.compoundFactoryAbi) {
        await indexVaultDirectory(chain, chainDef.compoundFactoryAddress, "compound", chainDef.compoundFactoryAbi);
      }
      await backfillVaultPairInfo(chain);
      await indexVaultEvents(chain);
      await backfillMintUsd(chain);
    } catch (err) {
      console.error(`indexer failed for chain ${chain.name}:`, err);
    }
  }
}
