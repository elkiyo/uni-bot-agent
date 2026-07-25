"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import type { Abi } from "viem";
import { erc20Abi } from "./contracts";
import type { ChainDef } from "./chains";

export interface VaultPairInfo {
  stableToken: `0x${string}`;
  volatileToken: `0x${string}`;
  stableIsToken0: boolean;
  stableDecimals: number;
  volatileDecimals: number;
  stableSymbol: string;
  volatileSymbol: string;
}

/**
 * A single vault's own resolved pair, read live — the frontend-reading half
 * of the "resolver el par de ESTE vault" pattern (see lib/keeper/pairInfo.ts
 * for the keeper's identical version). `token0()`/`token1()`/
 * `stableIsToken0()` are already public getters on every vault contract, and
 * `decimals()`/`symbol()` are readable off any ERC20 directly — no separate
 * pairs registry needed to correctly read an ALREADY-DEPLOYED vault,
 * regardless of which pair it actually trades.
 *
 * `staleTime: Infinity`: a vault's pair is fixed forever at creation, so once
 * resolved this never needs a refetch — same reasoning as
 * useVaultCreatedAt's own staleTime.
 */
export function useVaultPairInfo(address: `0x${string}` | undefined, chain: ChainDef, vaultAbi: Abi) {
  const publicClient = usePublicClient({ chainId: chain.id });

  return useQuery({
    queryKey: ["vault-pair-info", chain.id, address],
    enabled: Boolean(address && publicClient),
    staleTime: Infinity,
    queryFn: async (): Promise<VaultPairInfo> => {
      if (!address || !publicClient) throw new Error("useVaultPairInfo: missing address or publicClient");

      const [token0, token1, stableIsToken0] = await Promise.all([
        publicClient.readContract({ address, abi: vaultAbi, functionName: "token0" }) as Promise<`0x${string}`>,
        publicClient.readContract({ address, abi: vaultAbi, functionName: "token1" }) as Promise<`0x${string}`>,
        publicClient.readContract({ address, abi: vaultAbi, functionName: "stableIsToken0" }) as Promise<boolean>,
      ]);
      const stableToken = stableIsToken0 ? token0 : token1;
      const volatileToken = stableIsToken0 ? token1 : token0;

      const [stableDecimals, volatileDecimals, stableSymbol, volatileSymbol] = await Promise.all([
        publicClient.readContract({ address: stableToken, abi: erc20Abi, functionName: "decimals" }) as Promise<number>,
        publicClient.readContract({ address: volatileToken, abi: erc20Abi, functionName: "decimals" }) as Promise<number>,
        publicClient.readContract({ address: stableToken, abi: erc20Abi, functionName: "symbol" }) as Promise<string>,
        publicClient.readContract({ address: volatileToken, abi: erc20Abi, functionName: "symbol" }) as Promise<string>,
      ]);

      return { stableToken, volatileToken, stableIsToken0, stableDecimals, volatileDecimals, stableSymbol, volatileSymbol };
    },
  });
}
