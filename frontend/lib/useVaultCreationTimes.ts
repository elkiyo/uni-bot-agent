"use client";

import { useQuery } from "@tanstack/react-query";
import { getPublicClient } from "wagmi/actions";
import { parseEventLogs, type Log, type PublicClient } from "viem";
import { getLogsChunked } from "./getLogsChunked";
import { wagmiConfig } from "./wagmi";
import type { ChainDef } from "./chains";

export type VaultCreationTimes = Record<string, number>; // lowercased vault address -> unix seconds

// wagmiConfig's own chain union — getPublicClient only accepts one of these,
// but ChainDef.id (from viem's generic Chain type) is a plain `number`.
export type ConfiguredChainId = (typeof wagmiConfig)["chains"][number]["id"];

/**
 * Maps every vault this owner has ever created on `chain` to its creation
 * timestamp, in ONE chunked log scan of the factory's own VaultCreated
 * events (owner is indexed, so this is a single fetch regardless of how many
 * vaults the owner has — not one event-log query per vault). Block
 * timestamps are only fetched for the small, deduplicated set of blocks
 * actually involved. Used to sort vaults by creation date across chains,
 * where block numbers alone aren't comparable (different chains, different
 * block times). Takes a plain PublicClient (not a hook) so it can be called
 * from either a single-chain hook or a multi-chain useQueries loop.
 */
export async function fetchVaultCreationTimes(
  publicClient: PublicClient,
  chain: ChainDef,
  owner: `0x${string}`,
): Promise<VaultCreationTimes> {
  if (!chain.factoryAddress) return {};

  const rawLogs = await getLogsChunked(publicClient, {
    address: chain.factoryAddress,
    fromBlock: chain.factoryDeployBlock,
    toBlock: "latest",
  });
  const ownerLower = owner.toLowerCase();
  const logs = parseEventLogs({ abi: chain.factoryAbi, logs: rawLogs as Log[] }).filter((l) => {
    if (l.eventName !== "VaultCreated") return false;
    const args = l.args as { owner?: string };
    return args.owner?.toLowerCase() === ownerLower;
  });
  if (logs.length === 0) return {};

  const uniqueBlocks = [...new Set(logs.map((l) => l.blockNumber))].filter((bn): bn is bigint => bn !== null);
  const blocks = await Promise.all(uniqueBlocks.map((bn) => publicClient.getBlock({ blockNumber: bn })));
  const blockTimestamps = new Map(uniqueBlocks.map((bn, i) => [bn, Number(blocks[i].timestamp)]));

  const result: VaultCreationTimes = {};
  for (const log of logs) {
    const vaultAddr = (log.args as { vault?: string }).vault;
    if (vaultAddr && log.blockNumber !== null) {
      result[vaultAddr.toLowerCase()] = blockTimestamps.get(log.blockNumber) ?? 0;
    }
  }
  return result;
}

export function useVaultCreationTimes(chain: ChainDef, owner: `0x${string}` | undefined) {
  return useQuery({
    queryKey: ["vault-creation-times", chain.id, owner],
    enabled: Boolean(owner && chain.factoryAddress),
    staleTime: 5 * 60_000, // a vault's creation time never changes once minted
    queryFn: () => {
      // getPublicClient's return type is config-bound and doesn't structurally
      // match viem's generic PublicClient (used by getLogsChunked below) —
      // it's the same client at runtime, just a stricter/looser generic shape.
      const publicClient = getPublicClient(wagmiConfig, { chainId: chain.id as ConfiguredChainId }) as
        | PublicClient
        | undefined;
      if (!publicClient || !owner) return {};
      return fetchVaultCreationTimes(publicClient, chain, owner);
    },
  });
}
