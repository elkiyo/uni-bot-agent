"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { parseEventLogs, type Log } from "viem";
import { uniswapV3PoolAbi, uniswapV3FactoryAbi, erc20Abi } from "./contracts";
import { getLogsChunked } from "./getLogsChunked";
import { ethPriceFromTick } from "./priceMath";
import { computeStableIsToken0, type ChainDef, type SupportedPair } from "./chains";

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
  tvlUsd: number; // pool's actual token balances (balanceOf), not a liquidity-derived estimate
  estimatedFeeRevenueUsd: number;
  /** Fee revenue generated per unit of liquidity over the lookback window —
   * a rough proxy for what an LP actually earns per dollar staked, since raw
   * fee-tier % alone ignores how much volume a pool actually sees. Higher is
   * better. undefined when the pool has no liquidity (nothing to divide by,
   * and nowhere to usefully deposit anyway). */
  feeRevenuePerLiquidity: number | undefined;
}

/**
 * Live per-pool metrics for every fee tier of the given PAIR — same pair
 * every candidate pool shares, just at different fee tiers/depths. Surfaced
 * so a user picking WHERE to open their position sees real numbers instead
 * of guessing: a lower fee tier isn't automatically a better (or worse)
 * place to earn LP yield — it depends on how much volume that specific pool
 * actually sees relative to its own liquidity, which shifts over time.
 * Confirmed 2026-07-17 comparing Celo's 0.3% and 0.01% USDT/WETH pools: the
 * 0.01% pool had ~35x the swap volume but ~8x the liquidity and 30x lower
 * fee rate — closer than either number alone suggests, and not something
 * that holds forever.
 *
 * Deliberately does NOT rank/recommend a pool — see feeRevenuePerLiquidity's
 * own caveat above about why a single recent window isn't the whole story.
 *
 * `pair` defaults to the chain's own default (chain.supportedPairs[0]) at
 * every call site today — /create hasn't grown a pair selector yet (see
 * wild-exploring-bumblebee.md's multi-pair Fase 4), so there's only ever one
 * real pair to pass. Taking it as an explicit param (not read off `chain`
 * directly) is what makes this ready for a second pair without another
 * signature change once one is actually curated.
 *
 * Reads against `chain` explicitly (via wagmi's `usePublicClient({chainId})`)
 * rather than whatever the wallet happens to be connected to — the viewing
 * chain (useSelectedChain) and the wallet's chain are deliberately decoupled —
 * see lib/useSelectedChain.tsx.
 */
export function usePoolMetrics(chain: ChainDef, pair: SupportedPair = chain.supportedPairs[0]) {
  const publicClient = usePublicClient({ chainId: chain.id });

  return useQuery({
    queryKey: ["pool-metrics", chain.id, pair.stableToken, pair.volatileToken],
    enabled: Boolean(publicClient),
    refetchInterval: 60_000,
    queryFn: async (): Promise<PoolMetrics[]> => {
      if (!publicClient) return [];

      const pools = await Promise.all(
        pair.candidateSwapFeeTiers.map(async (fee) => {
          const pool = (await publicClient.readContract({
            address: chain.uniswapV3Factory,
            abi: uniswapV3FactoryAbi,
            functionName: "getPool",
            args: [pair.stableToken, pair.volatileToken, fee],
          })) as `0x${string}`;
          return { fee, pool };
        }),
      );

      const latestBlock = await publicClient.getBlockNumber();
      const fromBlock = latestBlock > VOLUME_LOOKBACK_BLOCKS ? latestBlock - VOLUME_LOOKBACK_BLOCKS : 0n;
      // Derived from THIS pair's own addresses, not chain.stableIsToken0 —
      // correct for any pair, not just the chain's default one.
      const stableIsToken0 = computeStableIsToken0(pair.stableToken, pair.volatileToken);
      // Decimals aren't part of SupportedPair (deliberately minimal, see its
      // own docstring) — chain.stableDecimals/volatileDecimals are correct
      // for every pair that exists today (all 6/18), but would need to
      // become per-pair fields too the day a pair with different decimals
      // (e.g. WBTC, 8) is actually curated.
      const { stableDecimals, volatileDecimals } = chain;

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
              tvlUsd: 0,
              estimatedFeeRevenueUsd: 0,
              feeRevenuePerLiquidity: undefined,
            };
          }

          const [liquidity, slot0, rawLogs, stableBalanceRaw, volatileBalanceRaw] = await Promise.all([
            publicClient.readContract({ address: pool, abi: uniswapV3PoolAbi, functionName: "liquidity" }) as Promise<bigint>,
            publicClient
              .readContract({ address: pool, abi: uniswapV3PoolAbi, functionName: "slot0" })
              .catch(() => undefined) as Promise<readonly [bigint, number, number, number, number, number, boolean] | undefined>,
            getLogsChunked(publicClient, { address: pool, fromBlock, toBlock: latestBlock }),
            publicClient.readContract({
              address: pair.stableToken,
              abi: erc20Abi,
              functionName: "balanceOf",
              args: [pool],
            }) as Promise<bigint>,
            publicClient.readContract({
              address: pair.volatileToken,
              abi: erc20Abi,
              functionName: "balanceOf",
              args: [pool],
            }) as Promise<bigint>,
          ]);

          // TVL from the pool's REAL token balances, not a liquidity-derived
          // estimate — exact, and consistent regardless of how concentrated
          // that liquidity is around the current tick.
          const tick = slot0?.[1];
          const ethPrice = tick !== undefined ? ethPriceFromTick(tick, stableIsToken0, stableDecimals, volatileDecimals) : undefined;
          const tvlUsd =
            Number(stableBalanceRaw) * 10 ** -stableDecimals +
            (ethPrice !== undefined ? Number(volatileBalanceRaw) * 10 ** -volatileDecimals * ethPrice : 0);

          const swaps = parseEventLogs({ abi: uniswapV3PoolAbi, logs: rawLogs as Log[] }).filter(
            (l) => l.eventName === "Swap",
          );
          const senders = new Set<string>();
          let volumeRaw = 0n;
          for (const s of swaps) {
            const args = s.args as { sender: string; amount0: bigint; amount1: bigint };
            senders.add(args.sender);
            // Which side is the stable leg flips per pair (WETH is token0 on
            // Arbitrum, token1 on Celo — see chains.ts's stableIsToken0
            // docstring) — hardcoding amount0 here silently treated an
            // 18-decimal WETH amount as 6-decimal stable on Arbitrum,
            // inflating "volumen reciente" by ~1e12x (confirmed in production
            // 2026-07-18: a real few-thousand-dollar volume showed as $39
            // TRILLION).
            const stableAmount = stableIsToken0 ? args.amount0 : args.amount1;
            volumeRaw += stableAmount < 0n ? -stableAmount : stableAmount;
          }
          const volumeStable = Number(volumeRaw) * 10 ** -stableDecimals;
          const estimatedFeeRevenueUsd = (volumeStable * fee) / 1_000_000; // fee is in hundredths of a bip (3000 == 0.3%)

          return {
            fee,
            pool,
            exists: true,
            liquidity,
            tick,
            swapCount: swaps.length,
            distinctTraders: senders.size,
            volumeStable,
            tvlUsd,
            estimatedFeeRevenueUsd,
            feeRevenuePerLiquidity: liquidity > 0n ? estimatedFeeRevenueUsd / Number(liquidity) : undefined,
          };
        }),
      );
    },
  });
}
