"use client";

import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { useReadContracts } from "wagmi";
import { positionManagerAbi, uniswapV3PoolAbi } from "../contracts";
import { ethPriceFromTick } from "../priceMath";
import { estimatePositionAmounts } from "../keeper/swapMath";
import { uncollectedFeesRaw } from "../positionMath";
import { deployedChains, type ChainDef } from "../chains";
import { deserializeArgs } from "../eventArgsCodec";
import { fetchAllVaultCreations, type VaultCreationRecord } from "./vaultDirectory";
import type { MintVolumeEvent } from "./mintVolume";

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
}

export interface ChainFetchError {
  chainId: number;
  chainName: string;
}

export type VaultStatus = "active" | "no_position" | "closed";

export interface VaultRow {
  address: `0x${string}`;
  chain: ChainDef;
  poolLabel: string;
  pool: `0x${string}`;
  feeTier: number;
  createdAt: number;
  txHash: `0x${string}` | null;
  valueUsd: number;
  /** Live price range [low, high] in USD/ETH terms — null when there's no
   * open position (never initialized, or closed) to derive a range from. */
  priceRange: readonly [number, number] | null;
  /** Whether the pool's CURRENT tick still falls inside this vault's open
   * position range — null when there's no open position to check (never
   * initialized, or closed), same convention as priceRange. */
  inRange: boolean | null;
  /** Net fees in USD — the same blended formula as netOperatingProfitPct
   * below, just kept in dollar terms instead of normalized into a %:
   * (fees claimed − gas reimbursed) + 90% of the unrealized/uncollected
   * fees still sitting on the open position. Replaces a plain "fees
   * claimed" figure so this column tells the same story as the %
   * column next to it, just in USD. */
  netFeesUsd: number;
  /** LpFeesPaidToOwner + FeesCollected only, minus cumulative gas
   * reimbursed to the keeper — realized only
   * (claimed/reinjected fees, not what's still accruing in an open
   * position). Same "ignore price/IL" metric as VaultDetail.tsx's Ganancia
   * neta de operación stat, just derived here from this dashboard's own
   * per-chain event scan. Deliberately NOT extended with the unrealized
   * term below — that only affects the % (see netOperatingProfitPct). */
  netOperatingProfitUsd: number;
  /** A blended score, NOT a single ratio over one base: (netOperatingProfitUsd
   * ÷ B1) + 0.9 × (unrealized fees on the open position ÷ that position's
   * current value — the same "Rendimiento de comisiones (posición actual)"
   * metric app/vaults/page.tsx's feeYieldPct already shows per-card). The
   * two terms use DIFFERENT denominators (B1 vs. current position value) by
   * design — confirmed with the user rather than folding the unrealized USD
   * into B1's numerator first, which would've produced a more rigorous
   * single ratio but wasn't what was asked for. 0 when B1 is 0 or the vault
   * has no open position (closed vaults always get 0 for the unrealized
   * half). This dashboard-only definition is intentionally NOT mirrored in
   * VaultDetail.tsx's own Ganancia neta de operación card, which stays
   * realized-only. */
  netOperatingProfitPct: number;
  rebalanceCount: number;
  status: VaultStatus;
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
   * feeEvents/rebalanceEvents/mintVolumeEvents — all derived from a single
   * indexer-cached events fetch per chain (see lib/dashboard/indexer.ts). */
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
  /** Kept for callers that gate the Volumen card/chart on this specifically
   * — now just mirrors eventsLoading, since mint volume comes from the same
   * indexer-cached fetch as everything else in that group (the expensive
   * historical position+pool read that used to make this the slowest part
   * of the hook now happens once, server-side, at index time). */
  mintVolumeLoading: boolean;
  /** One row per vault ever created, newest first — netFeesUsd needs
   * eventsLoading, valueUsd/priceRange need snapshotLoading, so this is only
   * fully accurate once BOTH have resolved (see vaultRowsLoading). */
  vaultRows: VaultRow[];
  vaultRowsLoading: boolean;
  /** Chains whose scan ultimately failed after retries — numbers for these
   * chains are NOT trustworthy as "confirmed zero" while this is non-empty;
   * see this hook's own docstring for why that distinction matters. */
  chainErrors: ChainFetchError[];
}

const EMPTY_COUNTS: VaultCounts = { total: 0, withPosition: 0, closed: 0 };

interface DashboardEventRow {
  address: string;
  event_name: string;
  args: Record<string, unknown>;
  block_timestamp: string;
  usd_value: string | number | null;
}

/**
 * Protocol-wide dashboard aggregator — every vault on every deployed chain,
 * no owner filter (unlike useVaultCreationTimes.ts/vaults/page.tsx's "my
 * vaults" scope). Vault directory and event history are read from the
 * indexer's Postgres cache (lib/dashboard/indexer.ts, via
 * app/api/dashboard/*) instead of scanning chain history directly from the
 * browser — that RPC scan used to be the dominant cost on this page and
 * only grew as the chain's own history grew. Live state (ledgers, open
 * position value, current pool tick) is still read directly via multicall
 * (useReadContracts) since it has to be fresh, not historical, and was
 * already cheap.
 *
 * TVL is a live snapshot (ledgers + current position value at the pool's
 * current tick) — NOT a historical series, since that would need a position
 * valuation at every past block. Volumen/Comisiones/Rebalanceos ARE
 * historical series because they're event-driven (one row each, already
 * resolved by the indexer).
 *
 * Fee/commission USD amounts (LpFeesPaidToOwner/FeesCollected/
 * PerformanceFeeCollected) are converted using each chain's CURRENT ETH
 * price (from the same live pool read TVL uses), not the price at the time
 * of that specific event — an accepted approximation, unchanged from before
 * this hook moved off client-side RPC scanning.
 */
export function useProtocolMetrics(chainFilter: number | "all"): ProtocolMetrics {
  const allChains = deployedChains();
  const chains = chainFilter === "all" ? allChains : allChains.filter((c) => c.id === chainFilter);

  const directoryQueries = useQueries({
    queries: chains.map((chain) => ({
      queryKey: ["dashboard-vault-directory", chain.id, chain.factoryAddress],
      staleTime: 60_000,
      refetchInterval: 60_000,
      retry: 3,
      queryFn: (): Promise<VaultCreationRecord[]> => fetchAllVaultCreations(chain),
    })),
  });
  const directoryLoading = directoryQueries.some((q) => q.isLoading);
  // A chain whose directory fetch ultimately failed (all retries exhausted)
  // must NOT be silently treated as "this chain has 0 vaults" — that's
  // indistinguishable from real empty data otherwise, which is exactly the
  // bug reported 2026-07-18 (Celo's dashboard numbers came back as
  // confirmed-looking zeros while real vaults/fees/rebalances existed).
  // Surfaced instead of swallowed so the UI can tell "empty" from "failed to
  // load" apart.
  const directoryErrorChains = chains.filter((_, i) => directoryQueries[i].isError);

  // directoryQueries is a fresh array every render — this join gives the
  // memo below a stable, comparable primitive to key off instead of the
  // array reference itself.
  const directoryDataKey = directoryQueries.map((q) => q.data).join("|");
  const vaultRefs: VaultRef[] = useMemo(
    () => chains.flatMap((chain, i) => (directoryQueries[i].data ?? []).map((record) => ({ chain, record }))),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- directoryQueries itself is a fresh array every render; directoryDataKey (derived from its .data) is what actually matters
    [chains, directoryDataKey],
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
    query: { enabled: ledgerContracts.length > 0, refetchInterval: 60_000 },
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
  // Pool-level fee growth counters, 2 reads per unique pool (dedupable the
  // same way slot0 is) — combined with tickContracts below to compute each
  // vault's live UNCOLLECTED fees (netOperatingProfitPct's unrealized half),
  // via the same uncollectedFeesRaw formula app/vaults/page.tsx already uses
  // per-card. Kept as its own batch instead of one 4-read call per vault
  // (what vaults/page.tsx/PositionNFT.tsx do) since this hook aggregates
  // hundreds of vaults — this stays O(1) round trips regardless of count.
  const poolFeeGrowthContracts = useMemo(
    () =>
      uniquePools.flatMap(
        ({ chain, pool }) =>
          [
            { address: pool, abi: uniswapV3PoolAbi, functionName: "feeGrowthGlobal0X128", chainId: chain.id } as const,
            { address: pool, abi: uniswapV3PoolAbi, functionName: "feeGrowthGlobal1X128", chainId: chain.id } as const,
          ] as const,
      ),
    [uniquePools],
  );

  const { data: positionData, isLoading: positionLoading } = useReadContracts({
    contracts: positionContracts,
    query: { enabled: positionContracts.length > 0, refetchInterval: 60_000 },
  });
  const { data: poolData, isLoading: poolLoading } = useReadContracts({
    contracts: poolContracts,
    query: { enabled: poolContracts.length > 0, refetchInterval: 60_000 },
  });
  const { data: poolFeeGrowthData } = useReadContracts({
    contracts: poolFeeGrowthContracts,
    query: { enabled: poolFeeGrowthContracts.length > 0, refetchInterval: 60_000 },
  });
  // ticks(tickLower)/ticks(tickUpper) per open position — genuinely
  // dependent on positionData (need each vault's own range first), unlike
  // poolFeeGrowthContracts above which only needs uniquePools. Always emits
  // exactly 2 entries per open position (falling back to tick 0 when a
  // given position hasn't resolved yet) so tickData[i*2]/[i*2+1] stay
  // aligned with openPositions[i] even if one multicall entry individually
  // fails — same "some entries can fail without breaking indexing"
  // consideration as ledgers' gasReserveBalance handling above.
  const tickContracts = useMemo(
    () =>
      openPositions.flatMap(({ chain, record }, i) => {
        const position = positionData?.[i]?.result as
          | readonly [bigint, string, string, string, number, number, number, bigint, bigint, bigint, bigint, bigint]
          | undefined;
        const tickLower = position?.[5] ?? 0;
        const tickUpper = position?.[6] ?? 0;
        return [
          { address: record.pool, abi: uniswapV3PoolAbi, functionName: "ticks", args: [tickLower], chainId: chain.id } as const,
          { address: record.pool, abi: uniswapV3PoolAbi, functionName: "ticks", args: [tickUpper], chainId: chain.id } as const,
        ];
      }),
    [openPositions, positionData],
  );
  const { data: tickData } = useReadContracts({
    contracts: tickContracts,
    query: { enabled: Boolean(positionData) && tickContracts.length > 0, refetchInterval: 60_000 },
  });

  const currentTickByPool = useMemo(() => {
    const map = new Map<string, number>();
    uniquePools.forEach(({ chain, pool }, i) => {
      const slot0 = poolData?.[i]?.result as readonly [bigint, number, ...unknown[]] | undefined;
      if (slot0) map.set(`${chain.id}:${pool}`, slot0[1]);
    });
    return map;
  }, [uniquePools, poolData]);

  const feeGrowthGlobalByPool = useMemo(() => {
    const map = new Map<string, { global0: bigint; global1: bigint }>();
    uniquePools.forEach(({ chain, pool }, i) => {
      const global0 = poolFeeGrowthData?.[i * 2]?.result as bigint | undefined;
      const global1 = poolFeeGrowthData?.[i * 2 + 1]?.result as bigint | undefined;
      if (global0 !== undefined && global1 !== undefined) map.set(`${chain.id}:${pool}`, { global0, global1 });
    });
    return map;
  }, [uniquePools, poolFeeGrowthData]);

  // Current ETH price per chain — from the chain's default pool's live tick,
  // used only to value fee events (see this hook's own docstring).
  const ethPriceByChain = useMemo(() => {
    const map = new Map<number, number>();
    for (const chain of chains) {
      const tick = currentTickByPool.get(`${chain.id}:${chain.pool}`);
      if (tick !== undefined) map.set(chain.id, ethPriceFromTick(tick, chain.stableIsToken0));
    }
    return map;
    // eslint-disable-next-line react-hooks/preserve-manual-memoization -- currentTickByPool is itself a useMemo'd Map (stable per [uniquePools, poolData]), only ever read via .get() here, never mutated
  }, [chains, currentTickByPool]);

  // positionValueByVault (principal, mark-to-market) and feeYieldPctByVault
  // (unrealized fees ÷ that same position value — the "Rendimiento de
  // comisiones (posición actual)" metric app/vaults/page.tsx already shows
  // per-card) are computed in one pass since they share liquidity/tickLower/
  // tickUpper/currentTick/ethPrice — no reason to iterate openPositions twice.
  const { positionValueByVault, feeYieldPctByVault, feeYieldUsdByVault } = useMemo(() => {
    const valueMap = new Map<string, number>();
    const feeYieldMap = new Map<string, number>();
    const feeYieldUsdMap = new Map<string, number>();
    openPositions.forEach(({ chain, record }, i) => {
      const position = positionData?.[i]?.result as
        | readonly [bigint, string, string, string, number, number, number, bigint, bigint, bigint, bigint, bigint]
        | undefined;
      if (!position) return;
      const [
        ,
        ,
        ,
        ,
        ,
        tickLower,
        tickUpper,
        liquidity,
        feeGrowthInside0LastX128,
        feeGrowthInside1LastX128,
        tokensOwed0,
        tokensOwed1,
      ] = position;
      const currentTick = currentTickByPool.get(`${chain.id}:${record.pool}`);
      if (currentTick === undefined) return;
      const ethPrice = ethPriceFromTick(currentTick, chain.stableIsToken0);
      const { amount0Raw, amount1Raw } = estimatePositionAmounts({ liquidity, currentTick, tickLower, tickUpper });
      const stableRaw = chain.stableIsToken0 ? amount0Raw : amount1Raw;
      const volatileRaw = chain.stableIsToken0 ? amount1Raw : amount0Raw;
      const positionValueUsd = stableRaw * 1e-6 + volatileRaw * 1e-18 * ethPrice;
      valueMap.set(record.address, positionValueUsd);

      // Unrealized/uncollected fees — same uncollectedFeesRaw formula
      // app/vaults/page.tsx and PositionNFT.tsx use per-card, fed by the
      // batched feeGrowthGlobalByPool/tickData above instead of a per-vault
      // read. Falls back to the position's own (possibly stale) tokensOwed0/1
      // when the pool's fee-growth/tick reads haven't resolved yet, same
      // graceful-degradation vaults/page.tsx already relies on.
      const feeGrowthGlobal = feeGrowthGlobalByPool.get(`${chain.id}:${record.pool}`);
      const tickLowerData = tickData?.[i * 2]?.result as readonly [bigint, bigint, bigint, bigint, ...unknown[]] | undefined;
      const tickUpperData = tickData?.[i * 2 + 1]?.result as readonly [bigint, bigint, bigint, bigint, ...unknown[]] | undefined;
      let owed0 = tokensOwed0;
      let owed1 = tokensOwed1;
      if (feeGrowthGlobal && tickLowerData && tickUpperData) {
        const live = uncollectedFeesRaw({
          liquidity,
          tokensOwed0,
          tokensOwed1,
          feeGrowthInside0LastX128,
          feeGrowthInside1LastX128,
          feeGrowthGlobal0X128: feeGrowthGlobal.global0,
          feeGrowthGlobal1X128: feeGrowthGlobal.global1,
          tickLowerOutside0X128: tickLowerData[2],
          tickLowerOutside1X128: tickLowerData[3],
          tickUpperOutside0X128: tickUpperData[2],
          tickUpperOutside1X128: tickUpperData[3],
          currentTick,
          tickLower,
          tickUpper,
        });
        owed0 = BigInt(Math.max(0, Math.floor(live.fees0Raw)));
        owed1 = BigInt(Math.max(0, Math.floor(live.fees1Raw)));
      }
      const owedStableRaw = chain.stableIsToken0 ? owed0 : owed1;
      const owedVolatileRaw = chain.stableIsToken0 ? owed1 : owed0;
      const unclaimedFeesUsd = Number(owedStableRaw) * 1e-6 + Number(owedVolatileRaw) * 1e-18 * ethPrice;
      feeYieldMap.set(record.address, positionValueUsd > 0 ? (unclaimedFeesUsd / positionValueUsd) * 100 : 0);
      feeYieldUsdMap.set(record.address, unclaimedFeesUsd);
    });
    return { positionValueByVault: valueMap, feeYieldPctByVault: feeYieldMap, feeYieldUsdByVault: feeYieldUsdMap };
  }, [openPositions, positionData, currentTickByPool, feeGrowthGlobalByPool, tickData]);

  // Live price range [low, high] per vault, in USD/ETH terms — ticks
  // convert directly to a price via the same ethPriceFromTick used
  // everywhere else, so this stays consistent with how the rest of the app
  // already reads a range (e.g. VaultDetail.tsx).
  const priceRangeByVault = useMemo(() => {
    const map = new Map<string, readonly [number, number]>();
    openPositions.forEach(({ chain, record }, i) => {
      const position = positionData?.[i]?.result as
        | readonly [bigint, string, string, string, number, number, number, bigint, bigint, bigint, bigint, bigint]
        | undefined;
      if (!position) return;
      const [, , , , , tickLower, tickUpper] = position;
      const priceAtLower = ethPriceFromTick(tickLower, chain.stableIsToken0);
      const priceAtUpper = ethPriceFromTick(tickUpper, chain.stableIsToken0);
      // Tick direction and price direction are inverted whenever the stable
      // leg isn't token0 (see priceMath.ts) — sort so the pair is always
      // [low, high] regardless of which chain this vault is on.
      const low = Math.min(priceAtLower, priceAtUpper);
      const high = Math.max(priceAtLower, priceAtUpper);
      map.set(record.address, [low, high]);
    });
    return map;
  }, [openPositions, positionData]);

  // Whether the pool's live tick still sits inside the position's range —
  // Uniswap always mints with tickLower < tickUpper numerically, so this is
  // a plain comparison regardless of the price/tick inversion elsewhere.
  const inRangeByVault = useMemo(() => {
    const map = new Map<string, boolean>();
    openPositions.forEach(({ chain, record }, i) => {
      const position = positionData?.[i]?.result as
        | readonly [bigint, string, string, string, number, number, number, bigint, bigint, bigint, bigint, bigint]
        | undefined;
      if (!position) return;
      const [, , , , , tickLower, tickUpper] = position;
      const currentTick = currentTickByPool.get(`${chain.id}:${record.pool}`);
      if (currentTick === undefined) return;
      map.set(record.address, currentTick >= tickLower && currentTick <= tickUpper);
    });
    return map;
  }, [openPositions, positionData, currentTickByPool]);

  // Event aggregation: one indexer-cached fetch per chain covers every
  // vault's whole history (deposits, fees, rebalances, mints) at once —
  // replaces the old per-chain multi-address eth_getLogs scan.
  const eventQueries = useQueries({
    queries: chains.map((chain) => ({
      queryKey: ["dashboard-vault-events", chain.id],
      enabled: vaultRefs.some((r) => r.chain.id === chain.id),
      staleTime: 30_000,
      refetchInterval: 60_000,
      retry: 3,
      queryFn: async (): Promise<DashboardEventRow[]> => {
        const res = await fetch(`/api/dashboard/events?chain=${chain.id}`);
        if (!res.ok) throw new Error(`dashboard events fetch failed: ${res.status}`);
        return (await res.json()) as DashboardEventRow[];
      },
    })),
  });
  // Includes directoryLoading: each per-chain event query is `enabled` only
  // once that chain's vault directory resolved (needs the vault address
  // list first), and react-query reports a disabled query as isLoading:
  // false — without this, a chain whose directory hasn't loaded yet would
  // make the WHOLE flag flip false prematurely (its query never even
  // started), showing confirmed-looking $0.00 before that chain was scanned.
  const eventsLoading = directoryLoading || eventQueries.some((q) => q.isLoading);
  const eventsErrorChains = chains.filter((_, i) => eventQueries[i].isError);
  const chainErrors: ChainFetchError[] = [...new Set([...directoryErrorChains, ...eventsErrorChains].map((c) => c.id))].map(
    (id) => ({ chainId: id, chainName: chains.find((c) => c.id === id)?.name ?? String(id) }),
  );
  // eventQueries/directoryQueries are fresh arrays every render — these joins
  // give the memo below stable, comparable primitives to key off instead of
  // the array references themselves.
  const eventDataKey = eventQueries.map((q) => q.data).join("|");
  const directoryErrorKey = directoryQueries.map((q) => q.isError).join("|");
  const eventErrorKey = eventQueries.map((q) => q.isError).join("|");

  return useMemo(() => {
    const snapshotLoading = directoryLoading || ledgerLoading || positionLoading || poolLoading;
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
    const mintVolumeEvents: MintVolumeEvent[] = [];
    const vaultFeesByAddress = new Map<string, number>();
    const addFee = (address: string, usd: number) =>
      vaultFeesByAddress.set(address.toLowerCase(), (vaultFeesByAddress.get(address.toLowerCase()) ?? 0) + usd);
    // Per-vault gas the keeper has reimbursed itself — paired with
    // vaultFeesByAddress below to derive netOperatingProfitUsd (fees minus
    // gas, same "ignore price/IL" metric as VaultDetail.tsx's Ganancia neta
    // de operación, just aggregated per-row here instead of from one
    // vault's own event log).
    const vaultGasByAddress = new Map<string, number>();
    const addGas = (address: string, usd: number) =>
      vaultGasByAddress.set(address.toLowerCase(), (vaultGasByAddress.get(address.toLowerCase()) ?? 0) + usd);
    // Per-vault B1 (cumulative invested capital) — mirrors
    // lib/useVaultCumulativeInvestment.ts's walkCapitalLedger exactly (same
    // event set/rules, see that file's own docstring): every dollar that
    // ever actually entered the vault's position, counted once, minus
    // anything withdrawn. This is the correct denominator for
    // "rentabilidad" (fees ÷ capital invertido) — the old version only
    // looked at the FIRST Deposited event, which inflated the % for any
    // vault that received capital after creation (top-up, increasePosition,
    // reinjection).
    //
    // This chain's event stream also carries rows from compound (V2)
    // vaults (indexer.ts tracks both factories), but chain.vaultAbi below
    // is always the STANDARD abi — deserializeArgs silently leaves a
    // compound-only field (consumedUncounted, principalUsd) as a raw
    // string when decoding a compound vault's event through the standard
    // abi, since that field isn't part of the standard event's own
    // definition. asBigIntField guards every one of those specific fields
    // so a stray compound-vault row can never throw (bigint/string mix)
    // and break the whole page — compound vaults aren't in `ledgers`
    // anyway (vaultDirectory.ts only scans the standard factory), so
    // anything computed here for their address is inert, never looked up
    // below.
    const asBigIntField = (v: unknown): bigint => (typeof v === "bigint" ? v : 0n);
    const b1ByAddress = new Map<string, bigint>();
    const b1PendingIncreaseByAddress = new Map<string, bigint>();

    chains.forEach((chain, i) => {
      const rows = eventQueries[i].data ?? [];
      const ethPrice = ethPriceByChain.get(chain.id) ?? 0;
      for (const row of rows) {
        const ts = Math.floor(new Date(row.block_timestamp).getTime() / 1000);
        const args = deserializeArgs(chain.vaultAbi, row.event_name, row.args) as Record<string, unknown>;
        const addrKey = row.address.toLowerCase();
        const addB1 = (delta: bigint) => b1ByAddress.set(addrKey, (b1ByAddress.get(addrKey) ?? 0n) + delta);

        if (row.event_name === "LpFeesPaidToOwner" || row.event_name === "FeesCollected") {
          const stableRaw = chain.stableIsToken0 ? args.amount0 : args.amount1;
          const volatileRaw = chain.stableIsToken0 ? args.amount1 : args.amount0;
          const usd = Number(asBigIntField(stableRaw)) * 1e-6 + Number(asBigIntField(volatileRaw)) * 1e-18 * ethPrice;
          ownerFeesUsd += usd;
          addFee(row.address, usd);
          feeEvents.push({ timestamp: ts, ownerUsd: usd, platformUsd: 0 });
        } else if (row.event_name === "PerformanceFeeCollected") {
          const stableRaw = chain.stableIsToken0 ? args.amount0 : args.amount1;
          const volatileRaw = chain.stableIsToken0 ? args.amount1 : args.amount0;
          const usd = Number(asBigIntField(stableRaw)) * 1e-6 + Number(asBigIntField(volatileRaw)) * 1e-18 * ethPrice;
          platformFeesUsd += usd;
          // Deliberately NOT fed into vaultFeesByAddress/addFee — that map
          // backs the per-vault "Comisiones"/"Ganancia neta de operación"
          // columns, which need to match VaultDetail.tsx's own definition
          // (useVaultFeesSummary's totalUsdt/totalWeth): what the OWNER
          // actually received, net of the platform's cut. Still counted in
          // the protocol-wide platformFeesUsd total above and in feeEvents
          // below — this only affects the per-vault row figures.
          feeEvents.push({ timestamp: ts, ownerUsd: 0, platformUsd: usd });
        } else if (row.event_name === "KeeperGasReimbursed") {
          const usd = Number(asBigIntField(args.amountUsd)) * 1e-6;
          gasReimbursedUsd += usd;
          addGas(row.address, usd);
          // Deliberately NOT pushed to rebalanceEvents — this event also
          // fires on its own for a keeper-triggered fee-harvest/reinject
          // cycle (no rebalance at all, see FeesHistory.tsx's own
          // docstring), and doubles up with the Rebalanced branch below on
          // an actual rebalance (same tx emits both). Counting it here
          // inflated the Dashboard's "Rebalances" chart total to ~3476 vs.
          // the real on-chain rebalanceCount()-based stat card's 1871 — bug
          // found live 2026-07-31 comparing the two side by side; confirmed
          // by replaying real indexed events (Rebalanced-only count matched
          // the stat card almost exactly, Rebalanced+KeeperGasReimbursed
          // matched the inflated chart total almost exactly).
        } else if (row.event_name === "Deposited") {
          const investable = asBigIntField(args.investableAmount);
          const reserve = asBigIntField(args.reserveAmount);
          const gasReserve = asBigIntField(args.gasReserveAmount);
          depositedTotalUsd += Number(investable + reserve + gasReserve) * 1e-6;
          // V2-only field, always undefined for a genuine standard vault —
          // see walkCapitalLedger's own Deposited handling.
          if (args.positionAlreadyExists !== true) addB1(investable);
        } else if (row.event_name === "PositionIncreased") {
          const usdtAmount = asBigIntField(args.usdtAmount);
          addB1(usdtAmount);
          const consumedThisCycle = args.consumedUncounted !== undefined ? asBigIntField(args.consumedUncounted) : usdtAmount;
          if (usdtAmount > consumedThisCycle) {
            b1PendingIncreaseByAddress.set(
              addrKey,
              (b1PendingIncreaseByAddress.get(addrKey) ?? 0n) + (usdtAmount - consumedThisCycle),
            );
          }
        } else if (row.event_name === "Rebalanced" || row.event_name === "IdleDustSwept") {
          if (row.event_name === "Rebalanced") {
            rebalanceEvents.push({ timestamp: ts });
            if (row.usd_value !== null) mintVolumeEvents.push({ timestamp: ts, usd: Number(row.usd_value) });
            addB1(asBigIntField(args.reinjectedAmount));
          }
          const consumed = asBigIntField(args.consumedUncounted);
          const pending = b1PendingIncreaseByAddress.get(addrKey) ?? 0n;
          const protectedAmount = consumed < pending ? consumed : pending;
          b1PendingIncreaseByAddress.set(addrKey, pending - protectedAmount);
          addB1(consumed - protectedAmount);
        } else if (row.event_name === "ReinjectedIntoPosition") {
          addB1(asBigIntField(args.amount));
        } else if (row.event_name === "Withdrawn" || row.event_name === "EmergencyWithdraw") {
          addB1(-asBigIntField(args.principalUsd));
        } else if (row.event_name === "PositionInitialized") {
          if (row.usd_value !== null) mintVolumeEvents.push({ timestamp: ts, usd: Number(row.usd_value) });
        }
      }
    });

    const vaultRows: VaultRow[] = ledgers
      .map((v): VaultRow => {
        const positionValue = v.closed ? 0 : (positionValueByVault.get(v.record.address) ?? 0);
        const ledgerValue = v.closed ? 0 : Number(v.investableUsdt + v.reserveBalance + v.gasReserveBalance) * 1e-6;
        const valueUsd = ledgerValue + positionValue;
        const feesUsd = vaultFeesByAddress.get(v.record.address.toLowerCase()) ?? 0;
        const gasUsd = vaultGasByAddress.get(v.record.address.toLowerCase()) ?? 0;
        const netOperatingProfitUsd = feesUsd - gasUsd;
        const b1Raw = b1ByAddress.get(v.record.address.toLowerCase()) ?? 0n;
        const cumulativeInvestmentUsd = Number(b1Raw < 0n ? 0n : b1Raw) * 1e-6;
        // Realized (fees claimed − gas) ÷ B1, plus a 90%-discounted credit
        // for fees already accrued on the OPEN position but not yet
        // collected (feeYieldPctByVault — same "Rendimiento de comisiones
        // (posición actual)" metric app/vaults/page.tsx shows per-card,
        // i.e. unclaimed fees ÷ CURRENT POSITION VALUE, a different
        // denominator than B1). Deliberately a blended score (two
        // percentages summed directly), not one ratio over a single base —
        // confirmed with the user rather than folding the unrealized USD
        // into B1's numerator first.
        const realizedPct = cumulativeInvestmentUsd > 0 ? (netOperatingProfitUsd / cumulativeInvestmentUsd) * 100 : 0;
        const unrealizedPct = v.closed ? 0 : (feeYieldPctByVault.get(v.record.address) ?? 0);
        const unrealizedFeesUsd = v.closed ? 0 : (feeYieldUsdByVault.get(v.record.address) ?? 0);
        const status: VaultStatus = v.closed ? "closed" : v.positionTokenId > 0n ? "active" : "no_position";
        return {
          address: v.record.address,
          chain: v.chain,
          pool: v.record.pool,
          feeTier: v.record.fee,
          poolLabel: `${v.chain.stableSymbol}/${v.chain.volatileSymbol} ${(v.record.fee / 10_000).toFixed(2)}%`,
          createdAt: v.record.createdAt,
          txHash: v.record.txHash,
          valueUsd,
          priceRange: priceRangeByVault.get(v.record.address) ?? null,
          inRange: inRangeByVault.get(v.record.address) ?? null,
          // Same blend as netOperatingProfitPct below, in USD instead of %.
          netFeesUsd: netOperatingProfitUsd + 0.9 * unrealizedFeesUsd,
          netOperatingProfitUsd,
          netOperatingProfitPct: realizedPct + 0.9 * unrealizedPct,
          rebalanceCount: Number(v.rebalanceCount),
          status,
        };
      })
      .sort((a, b) => b.createdAt - a.createdAt);
    const vaultRowsLoading = snapshotLoading || eventsLoading;

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
      mintVolumeLoading: eventsLoading,
      vaultRows,
      vaultRowsLoading,
      chainErrors,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- eventQueries/directoryQueries themselves are fresh arrays every render; the *Key variables (derived from their .data/.isError) are what actually matter
  }, [
    directoryLoading,
    ledgerLoading,
    positionLoading,
    poolLoading,
    eventsLoading,
    chains,
    ledgers,
    positionValueByVault,
    priceRangeByVault,
    inRangeByVault,
    ethPriceByChain,
    eventDataKey,
    directoryErrorKey,
    eventErrorKey,
    chainErrors,
  ]);
}
