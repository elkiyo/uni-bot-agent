"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { uniswapV3FactoryAbi, quoterV2Abi } from "./contracts";
import type { ChainDef, CompoundDepositToken } from "./chains";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

export interface DepositQuote {
  feeTier: number;
  expectedStableOut: bigint; // raw units, chain.stableDecimals
  thirdPartyAmountOutMinimum: bigint; // expectedStableOut with slippage floor applied
  isLoading: boolean;
  isError: boolean;
}

const DISABLED_QUOTE: DepositQuote = {
  feeTier: 0,
  expectedStableOut: 0n,
  thirdPartyAmountOutMinimum: 0n,
  isLoading: false,
  isError: false,
};

/**
 * Live pre-deposit quote for swapping a third-party stablecoin (USDT/DAI)
 * into a compound vault's native stable before crediting its ledger — see
 * RangeVaultArbCompound.sol's depositToken(): reserveAmount/investableAmount/
 * gasReserveAmount are caller-supplied, NOT derived from the swap's real
 * output, so passing the raw typed amount instead of this quoted one would
 * silently overstate the vault's internal ledger. Disabled (returns
 * DISABLED_QUOTE, zero RPC calls) whenever tokenIn is undefined (the native
 * stable was selected) or amountInRaw is zero — the native-stable deposit
 * path must stay exactly as fast/simple as it's always been.
 *
 * Uses Uniswap's real QuoterV2 (chain.quoterV2Address) — safe here because
 * it's only ever called on Arbitrum (canonical deployment); see
 * quoterV2Abi's own docstring on why this would NOT be safe on Celo. Picks
 * the deepest fee tier live (same reasoning as the keeper's own
 * pickDeepestSwapFee in lib/keeper/rebalancer.ts, reimplemented here against
 * wagmi's publicClient instead of importing that server-only module into a
 * client bundle).
 */
export function useThirdPartyDepositQuote(
  chain: ChainDef,
  tokenIn: CompoundDepositToken | undefined,
  amountInRaw: bigint,
  maxSlippageBps: bigint,
): DepositQuote {
  const publicClient = usePublicClient({ chainId: chain.id });

  const { data, isLoading, isError } = useQuery({
    queryKey: ["third-party-deposit-quote", chain.id, tokenIn?.address, amountInRaw.toString(), maxSlippageBps.toString()],
    enabled: Boolean(publicClient && tokenIn && amountInRaw > 0n && chain.quoterV2Address),
    queryFn: async (): Promise<DepositQuote> => {
      if (!publicClient || !tokenIn || !chain.quoterV2Address) return DISABLED_QUOTE;

      const pools = await Promise.all(
        tokenIn.candidateSwapFeeTiers.map(async (fee) => {
          const pool = (await publicClient.readContract({
            address: chain.uniswapV3Factory,
            abi: uniswapV3FactoryAbi,
            functionName: "getPool",
            args: [tokenIn.address, chain.stableToken, fee],
          })) as `0x${string}`;
          return { fee, pool };
        }),
      );

      const liquidities = await Promise.all(
        pools.map(({ pool }) =>
          pool === ZERO_ADDRESS
            ? Promise.resolve(0n)
            : (publicClient
                .readContract({ address: pool, abi: [{ type: "function", name: "liquidity", stateMutability: "view", inputs: [], outputs: [{ type: "uint128" }] }] as const, functionName: "liquidity" })
                .catch(() => 0n) as Promise<bigint>),
        ),
      );

      let bestIdx = 0;
      for (let i = 1; i < liquidities.length; i++) {
        if (liquidities[i] > liquidities[bestIdx]) bestIdx = i;
      }
      const feeTier = pools[bestIdx].fee;

      const [amountOut] = (await publicClient.readContract({
        address: chain.quoterV2Address,
        abi: quoterV2Abi,
        functionName: "quoteExactInputSingle",
        args: [{ tokenIn: tokenIn.address, tokenOut: chain.stableToken, amountIn: amountInRaw, fee: feeTier, sqrtPriceLimitX96: 0n }],
      })) as [bigint, bigint, number, bigint];

      const thirdPartyAmountOutMinimum = amountOut - (amountOut * maxSlippageBps) / 10_000n;

      return { feeTier, expectedStableOut: amountOut, thirdPartyAmountOutMinimum, isLoading: false, isError: false };
    },
  });

  if (!tokenIn || amountInRaw === 0n || !chain.quoterV2Address) return DISABLED_QUOTE;
  return data ?? { ...DISABLED_QUOTE, isLoading, isError };
}
