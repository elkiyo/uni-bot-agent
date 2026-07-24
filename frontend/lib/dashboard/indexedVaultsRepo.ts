import "server-only";
import { supabase } from "../keeper/supabaseClient";
import type { VaultCreationRecord } from "./vaultDirectory";

interface VaultRow {
  address: string;
  owner: string;
  pool: string;
  token0: string;
  token1: string;
  fee: number;
  created_at: string;
  tx_hash: string | null;
}

/**
 * Server-side read of the indexer's vault directory cache — shared by
 * app/api/dashboard/vaults (the public API the browser calls) and any other
 * server-only module that needs the same data without a wasteful
 * self-HTTP-call (see lib/referrals/volume.ts, which used to call this
 * chain's RPC directly via the now-removed publicClient-based
 * fetchAllVaultCreations).
 */
export async function getIndexedVaults(chainId: number): Promise<VaultCreationRecord[]> {
  const { data, error } = await supabase().from("indexed_vaults").select("*").eq("chain_id", chainId);
  if (error) throw error;
  return ((data ?? []) as VaultRow[]).map((r) => ({
    address: r.address as `0x${string}`,
    owner: r.owner as `0x${string}`,
    pool: r.pool as `0x${string}`,
    token0: r.token0 as `0x${string}`,
    token1: r.token1 as `0x${string}`,
    fee: r.fee,
    createdAt: Math.floor(new Date(r.created_at).getTime() / 1000),
    txHash: (r.tx_hash as `0x${string}` | null) ?? null,
  }));
}
