"use client";

import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { useReadContracts } from "wagmi";
import { getPublicClient } from "wagmi/actions";
import { parseEventLogs, type Log, type PublicClient } from "viem";
import { wagmiConfig } from "../wagmi";
import { deployedChains, type ChainDef } from "../chains";
import { positionManagerAbi, uniswapV3PoolAbi } from "../contracts";
import { ethPriceFromTick } from "../priceMath";
import { estimatePositionAmounts } from "../keeper/swapMath";
import { getLogsChunkedMulti } from "../getLogsChunked";
import { fetchAllVaultCreations, type VaultCreationRecord } from "./vaultDirectory";
import { fetchMintVolumeEvents, type MintVolumeEvent } from "./mintVolume";
import type { ConfiguredChainId } from "../useVaultCreationTimes";

function publicClientFor(chainId: number): PublicClient | undefined {
  return getPublicClient(wagmiConfig, { chainId: chainId as ConfiguredChainId }) as PublicClient | undefined;
}

interface VaultRef {
  chain: ChainDef;
  record: VaultCreationRecord;
}

export interface VaultCounts {
  total: number;
  withPosition: number;
  closed: number;
}

export interface PoolTypeBucket {
  key: string;
  label: string;
  chainId: number;
  tvlUsd: number;
  vaultCount: number;
}

export interface FeeEvent {
  timestamp: number;
  ownerUsd: number;
  platformUsd: number;
}

export interface RebalanceEvent {
  timestamp: number;
  gasReimbursedUsd: number;
}

export interface ProtocolMetrics {
  /** True while ANY of the below is still loading — kept for callers that
   * don't need granular gating. Prefer snapshotLoading/eventsLoading/
   * mintVolumeLoading to let each stat/chart show as soon as ITS OWN
   * dependencies resolve instead of waiting on the slowest of the three. */
  isLoading: boolean;
  /** Covers tvlUsd/tvlByChain/vaultCounts/vaultCountsByChain/rebalanceCount/
   * rebalanceCountByChain/poolTypes — all derived from cheap multicalls
   * (ledger reads, position/pool reads), not event-log scans. */
  snapshotLoading: boolean;
  /** Covers ownerFeesUsd/platformFeesUsd/gasReimbursedUsd/depositedTotalUsd/
   * feeEvents/rebalanceEvents — these need a full historical event-log scan
   * per chain, slower than the snapshot reads above. */
  eventsLoading: boolean;
  chains: ChainDef[];
  tvlUsd: number;
  tvlByChain: Record<number, number>;
  vaultCounts: VaultCounts;
  vaultCountsByChain: Record<number, VaultCounts>;
  rebalanceCount: number;
  rebalanceCountByChain: Record<number, number>;
  ownerFeesUsd: number;
  platformFeesUsd: number;
  gasReimbursedUsd: number;
  depositedTotalUsd: number;
  poolTypes: PoolTypeBucket[];
  feeEvents: FeeEvent[];
  rebalanceEvents: RebalanceEvent[];
  mintVolumeEvents: MintVolumeEvent[];
  /** Reconstructing historical mint values (mintVolume.ts) is the single
   * most expensive part of this hook — one historical position+pool read
   * per past mint. Gate the Volumen card/chart on this specifically. */
  mintVolumeLoading: boolean;
}

const EMPTY_COUNTS: VaultCounts = { total: 0, withPosition: 0, closed: 0 };

/**
 * Protocol-wide dashboard aggregator — every vault on every deployed chain,
 * no owner filter (unlike useVaultCreationTimes.ts/vaults/page.tsx's "my
 * vaults" scope). Same no-backend philosophy as ActivityFeed/VolumeChart:
 * everything is reconstructed from on-chain reads and event logs, batched
 * via multicall (useReadContracts) and multi-address getLogsChunkedMulti so
 * the cost stays roughly constant per CHAIN rather than growing per VAULT.
 *
 * TVL is a live snapshot (ledgers + current position value at the pool's
 * current tick) — NOT a historical series, since that would need a position
 * valuation at every past block, multiplying RPC cost by however many
 * points are on the chart. Volumen/Comisiones/Rebalanceos ARE historical
 * series because they're event-driven (one block each), which is cheap.
 *
 * Fee/commission USD amounts (LpFeesPaidToOwner/FeesCollected/
 * PerformanceFeeCollected) are converted using each chain's CURRENT ETH
 * price, not the price at the time of that specific event — an accepted
 * approximation (avoids one historical pool read per fee event, which could
 * be a lot over a long history) that KeeperGasReimbursed/Volumen don't need
 * since those already report/derive their own point-in-time USD value.
 */
export function useProtocolMetrics(chainFilter: number | "all"): ProtocolMetrics {
  const allChains = deployedChains();
  const chains = chainFilter === "all" ? allChains : allChains.filter((c) => c.id === chainFilter);

  const directoryQueries = useQueries({
    queries: chains.map((chain) => ({
      queryKey: ["dashboard-vault-directory", chain.id, chain.factoryAddress],
      staleTime: 60_000,
      refetchInterval: 60_000,
      queryFn: async (): Promise<VaultCreationRecord[]> => {
        const publicClient = publicClientFor(chain.id);
        if (!publicClient) return [];
        return fetchAllVaultCreations(publicClient, chain);
      },
    })),
  });
  const directoryLoading = directoryQueries.some((q) => q.isLoading);

  const vaultRefs: VaultRef[] = useMemo(
    () =>
      chains.flatMap((chain, i) => (directoryQueries[i].data ?? []).map((record) => ({ chain, record }))),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- directoryQueries is a fresh array every render; its .data is what actually matters
    [chains, directoryQueries.map((q) => q.data).join("|")],
  );

  // Ledger state, 6 fields per vault, one multicall across every chain at once.
  const ledgerContracts = useMemo(
    () =>
      vaultRefs.flatMap(({ chain, record }) => [
        { address: record.address, abi: chain.vaultAbi, functionName: "closed", chainId: chain.id } as const,
        { address: record.address, abi: chain.vaultAbi, functionName: "positionTokenId", chainId: chain.id } as const,
        { address: record.address, abi: chain.vaultAbi, functionName: "investableUsdt", chainId: chain.id } as const,
        { address: record.address, abi: chain.vaultAbi, functionName: "reserveBalance", chainId: chain.id } as const,
        { address: record.address, abi: chain.vaultAbi, functionName: "rebalanceCount", chainId: chain.id } as const,
        { address: record.address, abi: chain.vaultAbi, functionName: "gasReserveBalance", chainId: chain.id } as const,
      ]),
    [vaultRefs],
  );
  const { data: ledgerData, isLoading: ledgerLoading } = useReadContracts({
    contracts: ledgerContracts,
    query: { enabled: ledgerContracts.length > 0, refetchInterval: 30_000 },
  });

  const FIELDS_PER_VAULT = 6;
  const ledgers = useMemo(
    () =>
      vaultRefs.map((ref, i) => {
        const base = i * FIELDS_PER_VAULT;
        const read = (offset: number) => ledgerData?.[base + offset]?.result;
        return {
          ...ref,
          closed: (read(0) as boolean | undefined) ?? false,
          positionTokenId: (read(1) as bigint | undefined) ?? 0n,
          investableUsdt: (read(2) as bigint | undefined) ?? 0n,
          reserveBalance: (read(3) as bigint | undefined) ?? 0n,
          rebalanceCount: (read(4) as bigint | undefined) ?? 0n,
          // Celo vaults have no gasReserveBalance() at all — that multicall
          // entry fails (not the whole batch), which reads back as
          // `undefined` here, correctly treated as 0.
          gasReserveBalance: (read(5) as bigint | undefined) ?? 0n,
        };
      }),
    [vaultRefs, ledgerData],
  );

  // Position value: only for vaults with an open position. Batch-read
  // positions() and each unique pool's current slot0() in one multicall pass.
  const openPositions = useMemo(() => ledgers.filter((v) => v.positionTokenId > 0n && !v.closed), [ledgers]);
  const positionContracts = useMemo(
    () =>
      openPositions.map(
        ({ chain, positionTokenId }) =>
          ({
            address: chain.positionManager,
            abi: positionManagerAbi,
            functionName: "positions",
            args: [positionTokenId],
            chainId: chain.id,
          }) as const,
      ),
    [openPositions],
  );
  const uniquePools = useMemo(() => {
    const seen = new Map<string, { chain: ChainDef; pool: `0x${string}` }>();
    for (const { chain, record } of vaultRefs) seen.set(`${chain.id}:${record.pool}`, { chain, pool: record.pool });
    return [...seen.values()];
  }, [vaultRefs]);
  const poolContracts = useMemo(
    () =>
      uniquePools.map(
        ({ chain, pool }) =>
          ({ address: pool, abi: uniswapV3PoolAbi, functionName: "slot0", chainId: chain.id }) as const,
      ),
    [uniquePools],
  );

  const { data: positionData, isLoading: positionLoading } = useReadContracts({
    contracts: positionContracts,
    query: { enabled: positionContracts.length > 0, refetchInterval: 30_000 },
  });
  const { data: poolData, isLoading: poolLoading } = useReadContracts({
    contracts: poolContracts,
    query: { enabled: poolContracts.length > 0, refetchInterval: 30_000 },
  });

  const currentTickByPool = useMemo(() => {
    const map = new Map<string, number>();
    uniquePools.forEach(({ chain, pool }, i) => {
      const slot0 = poolData?.[i]?.result as readonly [bigint, number, ...unknown[]] | undefined;
      if (slot0) map.set(`${chain.id}:${pool}`, slot0[1]);
    });
    return map;
  }, [uniquePools, poolData]);

  // Current ETH price per chain — from the chain's default pool's live tick,
  // used only to value fee events (see this hook's own docstring).
  const ethPriceByChain = useMemo(() => {
    const map = new Map<number, number>();
    for (const chain of chains) {
      const tick = currentTickByPool.get(`${chain.id}:${chain.pool}`);
      if (tick !== undefined) map.set(chain.id, ethPriceFromTick(tick, chain.stableIsToken0));
    }
    return map;
  }, [chains, currentTickByPool]);

  const positionValueByVault = useMemo(() => {
    const map = new Map<string, number>();
    openPositions.forEach(({ chain, record }, i) => {
      const position = positionData?.[i]?.result as
        | readonly [bigint, string, string, string, number, number, number, bigint, bigint, bigint, bigint, bigint]
        | undefined;
      if (!position) return;
      const [, , , , , tickLower, tickUpper, liquidity] = position;
      const currentTick = currentTickByPool.get(`${chain.id}:${record.pool}`);
      if (currentTick === undefined) return;
      const ethPrice = ethPriceFromTick(currentTick, chain.stableIsToken0);
      const { amount0Raw, amount1Raw } = estimatePositionAmounts({ liquidity, currentTick, tickLower, tickUpper });
      const stableRaw = chain.stableIsToken0 ? amount0Raw : amount1Raw;
      const volatileRaw = chain.stableIsToken0 ? amount1Raw : amount0Raw;
      map.set(record.address, stableRaw * 1e-6 + volatileRaw * 1e-18 * ethPrice);
    });
    return map;
  }, [openPositions, positionData, currentTickByPool]);

  // Event aggregation: one multi-address chunked scan per chain covers every
  // vault on that chain at once.
  const eventQueries = useQueries({
    queries: chains.map((chain) => ({
      queryKey: ["dashboard-vault-events", chain.id, vaultRefs.filter((r) => r.chain.id === chain.id).length],
      enabled: vaultRefs.some((r) => r.chain.id === chain.id),
      staleTime: 30_000,
      refetchInterval: 30_000,
      queryFn: async () => {
        const publicClient = publicClientFor(chain.id);
        const addresses = vaultRefs.filter((r) => r.chain.id === chain.id).map((r) => r.record.address);
        if (!publicClient || addresses.length === 0) return { logs: [] as Log[], blockTimestamps: new Map<bigint, number>() };
        const logs = await getLogsChunkedMulti(publicClient, {
          address: addresses,
          fromBlock: chain.factoryDeployBlock,
          toBlock: "latest",
        });
        const uniqueBlocks = [...new Set(logs.map((l) => l.blockNumber))].filter((bn): bn is bigint => bn !== null);
        const blocks = await Promise.all(uniqueBlocks.map((bn) => publicClient.getBlock({ blockNumber: bn })));
        const blockTimestamps = new Map(uniqueBlocks.map((bn, i) => [bn, Number(blocks[i].timestamp)]));
        return { logs, blockTimestamps };
      },
    })),
  });
  const eventsLoading = eventQueries.some((q) => q.isLoading);

  const mintVolumeQueries = useQueries({
    queries: chains.map((chain) => ({
      queryKey: ["dashboard-mint-volume", chain.id, vaultRefs.filter((r) => r.chain.id === chain.id).length],
      enabled: vaultRefs.some((r) => r.chain.id === chain.id),
      staleTime: 60_000,
      queryFn: async () => {
        const publicClient = publicClientFor(chain.id);
        const addresses = vaultRefs.filter((r) => r.chain.id === chain.id).map((r) => r.record.address);
        if (!publicClient || addresses.length === 0) return [] as MintVolumeEvent[];
        return fetchMintVolumeEvents(publicClient, chain, addresses);
      },
    })),
  });
  const mintVolumeLoading = mintVolumeQueries.some((q) => q.isLoading);

  return useMemo(() => {
    const snapshotLoading = directoryLoading || ledgerLoading || positionLoading || poolLoading;
    // mintVolumeLoading is deliberately excluded from isLoading: reconstructing
    // historical mint values (see mintVolume.ts) is the single most expensive
    // part of this hook (one historical position+pool read per past mint) and
    // shouldn't hold back TVL/vault counts/rebalance counts/fees. The page
    // gates the Volumen card/chart on mintVolumeLoading specifically instead.
    const isLoading = snapshotLoading || eventsLoading;

    const vaultCountsByChain: Record<number, VaultCounts> = {};
    const tvlByChain: Record<number, number> = {};
    const rebalanceCountByChain: Record<number, number> = {};
    const poolTypeMap = new Map<string, PoolTypeBucket>();

    for (const chain of chains) {
      vaultCountsByChain[chain.id] = { total: 0, withPosition: 0, closed: 0 };
      tvlByChain[chain.id] = 0;
      rebalanceCountByChain[chain.id] = 0;
    }

    for (const v of ledgers) {
      const counts = vaultCountsByChain[v.chain.id];
      counts.total += 1;
      if (v.closed) counts.closed += 1;
      else if (v.positionTokenId > 0n) counts.withPosition += 1;

      rebalanceCountByChain[v.chain.id] += Number(v.rebalanceCount);

      if (v.closed) continue;
      const positionValue = positionValueByVault.get(v.record.address) ?? 0;
      const ledgerValue = Number(v.investableUsdt + v.reserveBalance + v.gasReserveBalance) * 1e-6;
      const value = ledgerValue + positionValue;
      tvlByChain[v.chain.id] += value;

      const poolKey = `${v.chain.id}:${v.record.pool}`;
      const label = `${v.chain.stableSymbol}/${v.chain.volatileSymbol} ${(v.record.fee / 10_000).toFixed(2)}% · ${v.chain.name}`;
      const existing = poolTypeMap.get(poolKey);
      if (existing) {
        existing.tvlUsd += value;
        existing.vaultCount += 1;
      } else {
        poolTypeMap.set(poolKey, { key: poolKey, label, chainId: v.chain.id, tvlUsd: value, vaultCount: 1 });
      }
    }

    const vaultCounts = Object.values(vaultCountsByChain).reduce<VaultCounts>(
      (acc, c) => ({
        total: acc.total + c.total,
        withPosition: acc.withPosition + c.withPosition,
        closed: acc.closed + c.closed,
      }),
      { ...EMPTY_COUNTS },
    );
    const tvlUsd = Object.values(tvlByChain).reduce((a, b) => a + b, 0);
    const rebalanceCount = Object.values(rebalanceCountByChain).reduce((a, b) => a + b, 0);

    let ownerFeesUsd = 0;
    let platformFeesUsd = 0;
    let gasReimbursedUsd = 0;
    let depositedTotalUsd = 0;
    const feeEvents: FeeEvent[] = [];
    const rebalanceEvents: RebalanceEvent[] = [];

    chains.forEach((chain, i) => {
      const { logs = [], blockTimestamps } = eventQueries[i].data ?? {};
      if (!logs || logs.length === 0) return;
      const ethPrice = ethPriceByChain.get(chain.id) ?? 0;
      const parsed = parseEventLogs({ abi: chain.vaultAbi, logs });
      for (const log of parsed) {
        const args = log.args as Record<string, bigint | undefined>;
        const ts = log.blockNumber !== null ? blockTimestamps?.get(log.blockNumber) : undefined;
        if (log.eventName === "LpFeesPaidToOwner" || log.eventName === "FeesCollected") {
          const stableRaw = chain.stableIsToken0 ? args.amount0 : args.amount1;
          const volatileRaw = chain.stableIsToken0 ? args.amount1 : args.amount0;
          const usd = Number(stableRaw ?? 0n) * 1e-6 + Number(volatileRaw ?? 0n) * 1e-18 * ethPrice;
          ownerFeesUsd += usd;
          if (ts !== undefined) feeEvents.push({ timestamp: ts, ownerUsd: usd, platformUsd: 0 });
        } else if (log.eventName === "PerformanceFeeCollected") {
          const stableRaw = chain.stableIsToken0 ? args.amount0 : args.amount1;
          const volatileRaw = chain.stableIsToken0 ? args.amount1 : args.amount0;
          const usd = Number(stableRaw ?? 0n) * 1e-6 + Number(volatileRaw ?? 0n) * 1e-18 * ethPrice;
          platformFeesUsd += usd;
          if (ts !== undefined) feeEvents.push({ timestamp: ts, ownerUsd: 0, platformUsd: usd });
        } else if (log.eventName === "KeeperGasReimbursed") {
          const usd = Number(args.amountUsd ?? 0n) * 1e-6;
          gasReimbursedUsd += usd;
          if (ts !== undefined) rebalanceEvents.push({ timestamp: ts, gasReimbursedUsd: usd });
        } else if (log.eventName === "Deposited") {
          const total = Number((args.investableAmount ?? 0n) + (args.reserveAmount ?? 0n) + (args.gasReserveAmount ?? 0n));
          depositedTotalUsd += total * 1e-6;
        } else if (log.eventName === "Rebalanced" && ts !== undefined) {
          rebalanceEvents.push({ timestamp: ts, gasReimbursedUsd: 0 });
        }
      }
    });

    const mintVolumeEvents = mintVolumeQueries.flatMap((q) => q.data ?? []);

    return {
      isLoading,
      snapshotLoading,
      eventsLoading,
      chains,
      tvlUsd,
      tvlByChain,
      vaultCounts,
      vaultCountsByChain,
      rebalanceCount,
      rebalanceCountByChain,
      ownerFeesUsd,
      platformFeesUsd,
      gasReimbursedUsd,
      depositedTotalUsd,
      poolTypes: [...poolTypeMap.values()].sort((a, b) => b.tvlUsd - a.tvlUsd),
      feeEvents,
      rebalanceEvents,
      mintVolumeEvents,
      mintVolumeLoading,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- eventQueries/mintVolumeQueries are fresh arrays every render; their .data is what actually matters
  }, [
    directoryLoading,
    ledgerLoading,
    positionLoading,
    poolLoading,
    eventsLoading,
    mintVolumeLoading,
    chains,
    ledgers,
    positionValueByVault,
    ethPriceByChain,
    eventQueries.map((q) => q.data).join("|"),
    mintVolumeQueries.map((q) => q.data?.length).join("|"),
  ]);
}
