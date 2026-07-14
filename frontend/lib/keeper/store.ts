import "server-only";
import { supabase } from "./supabaseClient";

export interface VaultRecord {
  address: string;
  owner: string;
  uniLabApiKey?: string;
  positionInitialized: boolean;
  createdAtBlock: string; // stored as text, bigint doesn't survive JSON/Postgres numeric round-trip cleanly
}

interface VaultRow {
  address: string;
  owner: string;
  uni_lab_api_key: string | null;
  position_initialized: boolean;
  created_at_block: string;
}

function fromRow(row: VaultRow): VaultRecord {
  return {
    address: row.address,
    owner: row.owner,
    uniLabApiKey: row.uni_lab_api_key ?? undefined,
    positionInitialized: row.position_initialized,
    createdAtBlock: row.created_at_block,
  };
}

/**
 * Supabase (Postgres)-backed state for the keeper: which vaults exist, their
 * uni-lab.xyz api_key (one per vault — see PLAN.md, agent_wallet = vault
 * address because the vault itself sends the USDT payment), and how far
 * event discovery has scanned. Schema: lib/keeper/schema.sql. Replaced the
 * original JSON-file-backed store (see SCALING.md) when the keeper moved off
 * a single Mac onto Vercel — serverless functions have no persistent local
 * disk across invocations.
 */
export class Store {
  async getLastProcessedBlock(): Promise<bigint> {
    const { data, error } = await supabase()
      .from("keeper_state")
      .select("value")
      .eq("key", "lastProcessedBlock")
      .maybeSingle();
    if (error) throw error;
    return data ? BigInt(data.value as string) : 0n;
  }

  async setLastProcessedBlock(block: bigint): Promise<void> {
    const { error } = await supabase()
      .from("keeper_state")
      .upsert({ key: "lastProcessedBlock", value: block.toString() });
    if (error) throw error;
  }

  async getVault(address: string): Promise<VaultRecord | undefined> {
    const { data, error } = await supabase()
      .from("keeper_vaults")
      .select("*")
      .eq("address", address.toLowerCase())
      .maybeSingle();
    if (error) throw error;
    return data ? fromRow(data as VaultRow) : undefined;
  }

  async listVaults(): Promise<VaultRecord[]> {
    const { data, error } = await supabase().from("keeper_vaults").select("*");
    if (error) throw error;
    return ((data as VaultRow[]) ?? []).map(fromRow);
  }

  async upsertVault(record: VaultRecord): Promise<void> {
    const { error } = await supabase()
      .from("keeper_vaults")
      .upsert({
        address: record.address.toLowerCase(),
        owner: record.owner,
        uni_lab_api_key: record.uniLabApiKey ?? null,
        position_initialized: record.positionInitialized,
        created_at_block: record.createdAtBlock,
        updated_at: new Date().toISOString(),
      });
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
 * (acquire_tick_lock / release_tick_lock, see schema.sql).
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
