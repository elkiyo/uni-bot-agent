"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { parseEventLogs } from "viem";
import { getLogsChunked } from "./getLogsChunked";
import type { ChainDef } from "./chains";

/**
 * The vault's own creation timestamp, read off the factory's VaultCreated
 * event for this specific address — same chunked-scan-then-filter shape as
 * useVaultCreationTimes.ts's per-owner version (used on /vaults), just
 * filtered to one vault instead of every vault a given owner has created.
 */
export function useVaultCreatedAt(address: `0x${string}` | undefined, chain: ChainDef) {
  const publicClient = usePublicClient({ chainId: chain.id });

  return useQuery({
    queryKey: ["vault-created-at", chain.id, address],
    enabled: Boolean(publicClient && address && chain.factoryAddress),
    staleTime: Infinity, // a vault's creation time never changes
    queryFn: async () => {
      if (!publicClient || !address || !chain.factoryAddress) return null;
      const rawLogs = await getLogsChunked(publicClient, {
        address: chain.factoryAddress,
        fromBlock: chain.factoryDeployBlock,
        toBlock: "latest",
      });
      const addressLower = address.toLowerCase();
      const [log] = parseEventLogs({ abi: chain.factoryAbi, logs: rawLogs, eventName: "VaultCreated" }).filter(
        (l) => (l.args as { vault?: string }).vault?.toLowerCase() === addressLower,
      );
      if (!log || log.blockNumber === null) return null;
      const block = await publicClient.getBlock({ blockNumber: log.blockNumber });
      return Number(block.timestamp);
    },
  });
}
