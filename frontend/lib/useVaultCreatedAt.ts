"use client";

import { useQuery } from "@tanstack/react-query";
import type { ChainDef } from "./chains";
import type { VaultCreationRecord } from "./dashboard/vaultDirectory";

/**
 * The vault's own creation timestamp — read off the factory's VaultCreated
 * event for this specific address. Used to run its own full-history
 * eth_getLogs scan straight from the browser; now reads the indexer-cached
 * directory (see lib/dashboard/indexer.ts) the rest of the Vault/Dashboard
 * pages already use, and just looks up this one address in it.
 */
export function useVaultCreatedAt(address: `0x${string}` | undefined, chain: ChainDef) {
  return useQuery({
    queryKey: ["vault-created-at", chain.id, address],
    enabled: Boolean(address && chain.factoryAddress),
    staleTime: Infinity, // a vault's creation time never changes
    queryFn: async () => {
      if (!address) return null;
      const res = await fetch(`/api/dashboard/vaults?chain=${chain.id}`);
      if (!res.ok) throw new Error(`dashboard vaults fetch failed: ${res.status}`);
      const rows = (await res.json()) as VaultCreationRecord[];
      const addressLower = address.toLowerCase();
      const record = rows.find((r) => r.address.toLowerCase() === addressLower);
      return record?.createdAt ?? null;
    },
  });
}
