"use client";

import { useMemo } from "react";
import { useReadContracts } from "wagmi";
import { formatUnits } from "viem";
import { erc20Abi } from "./contracts";
import type { ChainDef } from "./chains";

export interface TokenBalance {
  address: `0x${string}`;
  raw: bigint | undefined;
  formatted: number | undefined;
}

/**
 * Live balanceOf for a handful of candidate deposit tokens at once (native
 * stable + compoundDepositTokens), one multicall — the deposit-token
 * selector needs every candidate's balance simultaneously to render its
 * chips, unlike every other balance read in this codebase which only ever
 * needed one token at a time. Empty `tokens` (e.g. a non-compound vault, or
 * Celo where compoundDepositTokens is undefined) skips the query entirely —
 * zero extra RPC work for every existing flow this hook isn't opted into.
 */
export function useMultiTokenBalances(
  chain: ChainDef,
  tokens: { address: `0x${string}`; decimals: number }[],
  owner: `0x${string}` | undefined,
): { balances: TokenBalance[] } {
  const { data } = useReadContracts({
    contracts: tokens.map((tk) => ({
      address: tk.address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: owner ? [owner] : undefined,
      chainId: chain.id,
    })),
    query: { enabled: Boolean(owner) && tokens.length > 0, refetchInterval: 60_000 },
  });

  const balances = useMemo(
    () =>
      tokens.map((tk, i) => {
        const raw = data?.[i]?.result as bigint | undefined;
        return {
          address: tk.address,
          raw,
          formatted: raw !== undefined ? Number(formatUnits(raw, tk.decimals)) : undefined,
        };
      }),
    [tokens, data],
  );

  return { balances };
}
