"use client";

import { useQuery } from "@tanstack/react-query";
import type { ChainDef } from "./chains";
import type { VaultCreationRecord } from "./dashboard/vaultDirectory";

export type VaultCreationTimes = Record<string, number>; // lowercased vault address -> unix seconds

/**
 * Maps every vault this owner has ever created on `chain` to its creation
 * timestamp — used to sort vaults by creation date across chains, where
 * block numbers alone aren't comparable (different chains, different block
 * times). Used to run its own full-history eth_getLogs scan of the
 * factory's VaultCreated events straight from the browser (filtered to this
 * owner client-side — the scan itself covered every vault regardless of
 * owner); now reads the indexer-cached directory (see
 * lib/dashboard/indexer.ts) the rest of the Vault/Dashboard pages already
 * use, filtering that instead.
 */
export async function fetchVaultCreationTimes(chain: ChainDef, owner: `0x${string}`): Promise<VaultCreationTimes> {
  if (!chain.factoryAddress) return {};

  const res = await fetch(`/api/dashboard/vaults?chain=${chain.id}`);
  if (!res.ok) throw new Error(`dashboard vaults fetch failed: ${res.status}`);
  const rows = (await res.json()) as VaultCreationRecord[];

  const ownerLower = owner.toLowerCase();
  const result: VaultCreationTimes = {};
  for (const r of rows) {
    if (r.owner.toLowerCase() === ownerLower) result[r.address.toLowerCase()] = r.createdAt;
  }
  return result;
}

export function useVaultCreationTimes(chain: ChainDef, owner: `0x${string}` | undefined) {
  return useQuery({
    queryKey: ["vault-creation-times", chain.id, owner],
    enabled: Boolean(owner && chain.factoryAddress),
    staleTime: 5 * 60_000, // a vault's creation time never changes once minted
    queryFn: () => {
      if (!owner) return {};
      return fetchVaultCreationTimes(chain, owner);
    },
  });
}
