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
 * Every vault ever created on `chain`, regardless of owner — the protocol
 * dashboard's vault directory. Used to run a full chunked eth_getLogs scan
 * per chain straight from the browser (one per visitor, on every cold
 * load); now served from the indexer's Postgres cache via a single fast API
 * call instead — see lib/dashboard/indexer.ts and app/api/dashboard/vaults
 * (which already returns this exact shape, via lib/dashboard/
 * indexedVaultsRepo.ts's own row→record conversion). The caller's own React
 * Query (staleTime/refetchInterval) handles caching repeat calls now, so
 * this no longer needs its own module-scope cache the way the RPC-scanning
 * version did.
 */
export async function fetchAllVaultCreations(chain: ChainDef): Promise<VaultCreationRecord[]> {
  if (!chain.factoryAddress) return [];

  const res = await fetch(`/api/dashboard/vaults?chain=${chain.id}`);
  if (!res.ok) throw new Error(`dashboard vaults fetch failed: ${res.status}`);
  return (await res.json()) as VaultCreationRecord[];
}
