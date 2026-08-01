import "server-only";
import { supabase } from "./supabaseClient";

// "compound" is Arbitrum-only (RangeVaultArbCompound.sol/VaultFactoryArbCompound.sol —
// see chains.ts's ChainDef docstring on compoundFactoryAddress). Which factory a
// vault was cloned from is fixed forever at creation — no in-place upgrade path —
// so this is stamped once by discovery.ts and never changes after that.
export type VaultKindRecord = "standard" | "compound";

export interface VaultRecord {
  address: string;
  owner: string;
  uniLabApiKey?: string;
  positionInitialized: boolean;
  createdAtBlock: string; // stored as text, bigint doesn't survive JSON/Postgres numeric round-trip cleanly
  // Keeper's own bookkeeping of whether it reinjected on the last rebalance —
  // the contract no longer tracks this (see autorange.md), the keeper decides E1
  // freely each cycle. Purely informational, not a guarantee.
  reinjectionActive: boolean;
  kind: VaultKindRecord;
  // Timestamp of when the keeper first found gasReserveBalance insufficient
  // for an action it was about to take, or undefined if currently healthy
  // (or never checked) — see schema.sql's own docstring on this column.
  gasReserveEmptySince?: string;
  // This vault's own pair — read once, live, at discovery time (or lazily by
  // pairInfo.ts's resolveVaultPair() for a legacy row that predates these
  // columns) and cached here forever, since a vault's pair never changes
  // after creation. Undefined together (never partially) for a legacy row
  // that hasn't been lazily backfilled yet — see pairInfo.ts.
  stableToken?: string;
  volatileToken?: string;
  stableIsToken0?: boolean;
  stableDecimals?: number;
  volatileDecimals?: number;
}

interface VaultRow {
  address: string;
  owner: string;
  uni_lab_api_key: string | null;
  position_initialized: boolean;
  created_at_block: string;
  reinjection_active: boolean;
  kind: string | null;
  gas_reserve_empty_since: string | null;
  stable_token: string | null;
  volatile_token: string | null;
  stable_is_token0: boolean | null;
  stable_decimals: number | null;
  volatile_decimals: number | null;
}

function fromRow(row: VaultRow): VaultRecord {
  return {
    address: row.address,
    owner: row.owner,
    uniLabApiKey: row.uni_lab_api_key ?? undefined,
    positionInitialized: row.position_initialized,
    createdAtBlock: row.created_at_block,
    reinjectionActive: row.reinjection_active,
    kind: row.kind === "compound" ? "compound" : "standard",
    gasReserveEmptySince: row.gas_reserve_empty_since ?? undefined,
    stableToken: row.stable_token ?? undefined,
    volatileToken: row.volatile_token ?? undefined,
    stableIsToken0: row.stable_is_token0 ?? undefined,
    stableDecimals: row.stable_decimals ?? undefined,
    volatileDecimals: row.volatile_decimals ?? undefined,
  };
}

/**
 * Supabase (Postgres)-backed state for the keeper: which vaults exist, their
 * uni-lab.xyz api_key (one per vault — see autorange.md, agent_wallet = vault
 * address because the vault itself sends the USDT payment), and how far
 * event discovery has scanned. Schema: lib/keeper/schema.sql. Scoped to a
 * single chain per instance — keeper_vaults' primary key is (chain_id,
 * address) since the same vault address could in principle exist on two
 * different chains (each has its own factory/deployer nonce), and
 * keeper_state's lastProcessedBlock is namespaced per chain in the key
 * itself rather than a separate column, since it's already a generic
 * key/value table.
 */
export class Store {
  constructor(private readonly chainId: number) {}

  // Per-kind key ("standard" | "compound") — a chain with two factories
  // (Arbitrum, see chains.ts's compoundFactoryAddress) scans each
  // independently. A single shared checkpoint would risk one factory's scan
  // silently advancing the other's — e.g. if the standard-factory scan runs
  // first and succeeds, then the compound-factory scan fails, a shared
  // checkpoint already sitting past the compound factory's real events for
  // that window would permanently skip them next tick, never discovering
  // that vault. `kind` defaults to "standard" so every pre-existing call
  // site (all of them single-factory chains until now) keeps working
  // unchanged.
  private lastProcessedBlockKey(kind: "standard" | "compound" = "standard"): string {
    return kind === "compound" ? `lastProcessedBlock:${this.chainId}:compound` : `lastProcessedBlock:${this.chainId}`;
  }

  async getLastProcessedBlock(kind: "standard" | "compound" = "standard"): Promise<bigint> {
    const { data, error } = await supabase()
      .from("keeper_state")
      .select("value")
      .eq("key", this.lastProcessedBlockKey(kind))
      .maybeSingle();
    if (error) throw error;
    return data ? BigInt(data.value as string) : 0n;
  }

  async setLastProcessedBlock(block: bigint, kind: "standard" | "compound" = "standard"): Promise<void> {
    const { error } = await supabase()
      .from("keeper_state")
      .upsert({ key: this.lastProcessedBlockKey(kind), value: block.toString() });
    if (error) throw error;
  }

  async getVault(address: string): Promise<VaultRecord | undefined> {
    const { data, error } = await supabase()
      .from("keeper_vaults")
      .select("*")
      .eq("chain_id", this.chainId)
      .eq("address", address.toLowerCase())
      .maybeSingle();
    if (error) throw error;
    return data ? fromRow(data as VaultRow) : undefined;
  }

  async listVaults(): Promise<VaultRecord[]> {
    const { data, error } = await supabase().from("keeper_vaults").select("*").eq("chain_id", this.chainId);
    if (error) throw error;
    return ((data as VaultRow[]) ?? []).map(fromRow);
  }

  /**
   * Marks/clears the moment this vault's gasReserveBalance was first found
   * insufficient for an action the keeper was about to take as operator —
   * see hasEnoughOperatorGas() in rebalancer.ts, the only caller. Read-then-
   * write (not a single upsert) because "first" needs a coalesce: setting
   * `depleted=true` twice in a row must NOT push the timestamp forward each
   * tick, only the very first detection matters for "how long has this been
   * broken" — same reasoning as the SQL coalesce() this would otherwise need.
   */
  async setGasReserveDepleted(address: string, depleted: boolean): Promise<void> {
    const lower = address.toLowerCase();
    if (depleted) {
      const { data, error: readError } = await supabase()
        .from("keeper_vaults")
        .select("gas_reserve_empty_since")
        .eq("chain_id", this.chainId)
        .eq("address", lower)
        .maybeSingle();
      if (readError) throw readError;
      if (data?.gas_reserve_empty_since) return; // already marked, don't move the timestamp
      const { error } = await supabase()
        .from("keeper_vaults")
        .update({ gas_reserve_empty_since: new Date().toISOString() })
        .eq("chain_id", this.chainId)
        .eq("address", lower);
      if (error) throw error;
    } else {
      const { error } = await supabase()
        .from("keeper_vaults")
        .update({ gas_reserve_empty_since: null })
        .eq("chain_id", this.chainId)
        .eq("address", lower)
        .not("gas_reserve_empty_since", "is", null);
      if (error) throw error;
    }
  }

  async upsertVault(record: VaultRecord): Promise<void> {
    const { error } = await supabase()
      .from("keeper_vaults")
      .upsert({
        chain_id: this.chainId,
        address: record.address.toLowerCase(),
        owner: record.owner,
        uni_lab_api_key: record.uniLabApiKey ?? null,
        position_initialized: record.positionInitialized,
        created_at_block: record.createdAtBlock,
        kind: record.kind,
        ...(record.stableToken !== undefined ? { stable_token: record.stableToken } : {}),
        ...(record.volatileToken !== undefined ? { volatile_token: record.volatileToken } : {}),
        ...(record.stableIsToken0 !== undefined ? { stable_is_token0: record.stableIsToken0 } : {}),
        ...(record.stableDecimals !== undefined ? { stable_decimals: record.stableDecimals } : {}),
        ...(record.volatileDecimals !== undefined ? { volatile_decimals: record.volatileDecimals } : {}),
        updated_at: new Date().toISOString(),
      });
    if (error) throw error;
  }

  /**
   * Lazily backfills a single vault's pair columns — the only writer for a
   * legacy row that predates them (every vault discovered before this
   * shipped). Deliberately its own narrow UPDATE rather than routing through
   * upsertVault: that method's caller always has a full VaultRecord already
   * loaded, but pairInfo.ts's resolveVaultPair() is called from many spots
   * that only have the address, and re-fetching+re-upserting the whole row
   * just to add 5 columns would risk silently overwriting a concurrent
   * update to some other field made in between the read and this write.
   */
  async setVaultPairInfo(
    address: string,
    pair: { stableToken: string; volatileToken: string; stableIsToken0: boolean; stableDecimals: number; volatileDecimals: number },
  ): Promise<void> {
    const { error } = await supabase()
      .from("keeper_vaults")
      .update({
        stable_token: pair.stableToken,
        volatile_token: pair.volatileToken,
        stable_is_token0: pair.stableIsToken0,
        stable_decimals: pair.stableDecimals,
        volatile_decimals: pair.volatileDecimals,
      })
      .eq("chain_id", this.chainId)
      .eq("address", address.toLowerCase());
    if (error) throw error;
  }
}

/**
 * Prevents two overlapping tick() runs from racing on the operator wallet's
 * nonce — see SCALING.md "no correr dos keepers con la misma wallet a la
 * vez". Needed now that ticks are triggered externally (GitHub Actions)
 * rather than by a single in-process scheduler: a slow tick (RPC lag, a
 * pending tx confirmation) could still be running when the next 5-minute
 * trigger fires. Implemented as an atomic conditional UPDATE in Postgres
 * (acquire_tick_lock / release_tick_lock, see schema.sql). One global lock
 * for the whole platform, not per-chain — a single runTick() invocation
 * processes every configured chain sequentially within one lock/unlock, so
 * there's never a real race between chains to guard against, and a
 * per-chain lock would just add schema complexity for no benefit.
 */
export async function acquireTickLock(ttlSeconds: number): Promise<boolean> {
  const { data, error } = await supabase().rpc("acquire_tick_lock", { ttl_seconds: ttlSeconds });
  if (error) throw error;
  return data === true;
}

export async function releaseTickLock(): Promise<void> {
  const { error } = await supabase().rpc("release_tick_lock");
  if (error) throw error;
}

// Fixed key, not chain-namespaced like lastProcessedBlock above — x402
// payment always settles via Celo regardless of which chain's vault
// triggered the cycle (see unilab.ts's own docstring), so "is x402 broken
// right now" is a single global fact, not a per-chain one.
const X402_CIRCUIT_BREAKER_KEY = "x402CircuitBreakerUntil";

/**
 * Circuit breaker added 2026-08-01 during uni-lab.xyz's x402 outage: once
 * rebalancer.ts sees 3+ x402 failures within a 5-minute window (via
 * logger.ts#recentX402FailureCount), it trips this for 10 minutes so every
 * rebalance in that window skips straight to the direct-payment fallback
 * instead of eating x402's own ~10s timeout first (see unilab.ts's
 * X402_TIMEOUT_MS docstring for why that dead time matters — with dozens of
 * vaults out of range at once, it roughly halves how many the cron's
 * sequential per-vault loop can get through before its 200s budget runs
 * out). Stored in keeper_state (not in-memory) since each cron invocation
 * is a fresh serverless function — plain epoch-ms in `value`, `null` (row
 * absent) means never tripped / breaker not active.
 */
export async function getX402CircuitBreakerUntil(): Promise<number | null> {
  const { data, error } = await supabase()
    .from("keeper_state")
    .select("value")
    .eq("key", X402_CIRCUIT_BREAKER_KEY)
    .maybeSingle();
  if (error) throw error;
  return data ? Number(data.value) : null;
}

export async function setX402CircuitBreakerUntil(untilMs: number): Promise<void> {
  const { error } = await supabase()
    .from("keeper_state")
    .upsert({ key: X402_CIRCUIT_BREAKER_KEY, value: String(untilMs) });
  if (error) throw error;
}
