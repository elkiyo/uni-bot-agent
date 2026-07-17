"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { parseEventLogs, type Log } from "viem";
import { uniswapV3PoolAbi, uniswapV3FactoryAbi } from "./contracts";
import { getLogsChunked } from "./getLogsChunked";
import type { ChainDef } from "./chains";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
// ~how far back to sample recent trading activity from — a snapshot, not
// all-time (a pool live for months would otherwise dwarf a newer one on raw
// swap count/volume alone, which says nothing about CURRENT conditions).
const VOLUME_LOOKBACK_BLOCKS = 5_000n;

export interface PoolMetrics {
  fee: number;
  pool: `0x${string}`;
  exists: boolean;
  liquidity: bigint;
  tick: number | undefined;
  swapCount: number;
  distinctTraders: number;
  volumeStable: number; // in the chain's stable token (USDT on Celo, USDC on Arbitrum), not always USDT
  estimatedFeeRevenueUsd: number;
  /** Fee revenue generated per unit of liquidity over the lookback window —
   * a rough proxy for what an LP actually earns per dollar staked, since raw
   * fee-tier % alone ignores how much volume a pool actually sees. Higher is
   * better. undefined when the pool has no liquidity (nothing to divide by,
   * and nowhere to usefully deposit anyway). */
  feeRevenuePerLiquidity: number | undefined;
}

/**
 * Live per-pool metrics for every fee tier of the given chain's stable/WETH
 * pair — same pair every vault on that chain already trades, just at
 * different fee tiers/depths. Surfaced so a user picking WHERE to open their
 * position sees real numbers instead of guessing: a lower fee tier isn't
 * automatically a better (or worse) place to earn LP yield — it depends on
 * how much volume that specific pool actually sees relative to its own
 * liquidity, which shifts over time. Confirmed 2026-07-17 comparing Celo's
 * 0.3% and 0.01% USDT/WETH pools: the 0.01% pool had ~35x the swap volume
 * but ~8x the liquidity and 30x lower fee rate — closer than either number
 * alone suggests, and not something that holds forever.
 *
 * Deliberately does NOT rank/recommend a pool — see feeRevenuePerLiquidity's
 * own caveat above about why a single recent window isn't the whole story.
 *
 * Reads against `chain` explicitly (via wagmi's `usePublicClient({chainId})`)
 * rather than whatever the wallet happens to be connected to — the viewing
 * chain (useSelectedChain) and the wallet's chain are deliberately decoupled,
 * see Header.tsx's NetworkSelector.
 */
export function usePoolMetrics(chain: ChainDef) {
  const publicClient = usePublicClient({ chainId: chain.id });

  return useQuery({
    queryKey: ["pool-metrics", chain.id],
    enabled: Boolean(publicClient),
    refetchInterval: 60_000,
    queryFn: async (): Promise<PoolMetrics[]> => {
      if (!publicClient) return [];

      const pools = await Promise.all(
        chain.candidateSwapFeeTiers.map(async (fee) => {
          const pool = (await publicClient.readContract({
            address: chain.uniswapV3Factory,
            abi: uniswapV3FactoryAbi,
            functionName: "getPool",
            args: [chain.stableToken, chain.volatileToken, fee],
          })) as `0x${string}`;
          return { fee, pool };
        }),
      );

      const latestBlock = await publicClient.getBlockNumber();
      const fromBlock = latestBlock > VOLUME_LOOKBACK_BLOCKS ? latestBlock - VOLUME_LOOKBACK_BLOCKS : 0n;

      return Promise.all(
        pools.map(async ({ fee, pool }): Promise<PoolMetrics> => {
          if (pool === ZERO_ADDRESS) {
            return {
              fee,
              pool,
              exists: false,
              liquidity: 0n,
              tick: undefined,
              swapCount: 0,
              distinctTraders: 0,
              volumeStable: 0,
              estimatedFeeRevenueUsd: 0,
              feeRevenuePerLiquidity: undefined,
            };
          }

          const [liquidity, slot0, rawLogs] = await Promise.all([
            publicClient.readContract({ address: pool, abi: uniswapV3PoolAbi, functionName: "liquidity" }) as Promise<bigint>,
            publicClient
              .readContract({ address: pool, abi: uniswapV3PoolAbi, functionName: "slot0" })
              .catch(() => undefined) as Promise<readonly [bigint, number, number, number, number, number, boolean] | undefined>,
            getLogsChunked(publicClient, { address: pool, fromBlock, toBlock: latestBlock }),
          ]);

          const swaps = parseEventLogs({ abi: uniswapV3PoolAbi, logs: rawLogs as Log[] }).filter(
            (l) => l.eventName === "Swap",
          );
          const senders = new Set<string>();
          let volumeRaw = 0n;
          for (const s of swaps) {
            const args = s.args as { sender: string; amount0: bigint };
            senders.add(args.sender);
            volumeRaw += args.amount0 < 0n ? -args.amount0 : args.amount0;
          }
          const volumeStable = Number(volumeRaw) / 1e6; // both USDT and USDC are 6 decimals
          const estimatedFeeRevenueUsd = (volumeStable * fee) / 1_000_000; // fee is in hundredths of a bip (3000 == 0.3%)

          return {
            fee,
            pool,
            exists: true,
            liquidity,
            tick: slot0?.[1],
            swapCount: swaps.length,
            distinctTraders: senders.size,
            volumeStable,
            estimatedFeeRevenueUsd,
            feeRevenuePerLiquidity: liquidity > 0n ? estimatedFeeRevenueUsd / Number(liquidity) : undefined,
          };
        }),
      );
    },
  });
}
