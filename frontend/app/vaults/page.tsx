"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useAccount, useReadContract, useReadContracts } from "wagmi";
import { useQueries } from "@tanstack/react-query";
import { formatUnits } from "viem";
import { Header } from "../components/Header";
import { ChainIcon } from "../components/ChainIcon";
import { PairIcon } from "../components/TokenIcon";
import { uniswapV3PoolAbi, positionManagerAbi, erc20Abi } from "@/lib/contracts";
import { ethPriceFromTick } from "@/lib/priceMath";
import { estimatePositionAmounts } from "@/lib/keeper/swapMath";
import { uncollectedFeesRaw } from "@/lib/positionMath";
import { useVaultFeesSummary } from "@/lib/useVaultFeesSummary";
import { useVaultPairInfo } from "@/lib/useVaultPairInfo";
import { isCompoundBetaWallet } from "@/lib/compoundBeta";
import { useVaultDepositSummary } from "@/lib/useVaultDepositSummary";
import { fetchVaultCreationTimes } from "@/lib/useVaultCreationTimes";
import { useAvailableChains, useSelectedChain } from "@/lib/useSelectedChain";
import type { ChainDef } from "@/lib/chains";
import { useTranslation } from "@/lib/i18n/useTranslation";

interface VaultRef {
  chain: ChainDef;
  address: `0x${string}`;
  kind: "standard" | "compound";
}

/**
 * Shows every vault across every deployed chain at once, in a SINGLE sorted
 * list — not grouped by chain (each card carries its own chain badge
 * instead). Active vaults first, oldest-first split from closed ones which
 * sink to the bottom, both ordered by creation date — creation date comes
 * from the factory's own VaultCreated event (one chunked log scan per
 * chain, not per vault — see useVaultCreationTimes.ts), since block numbers
 * alone aren't comparable across chains with different block times.
 */
export default function VaultsPage() {
  const { address, isConnected } = useAccount();
  const chains = useAvailableChains();
  const { t } = useTranslation();
  const [chainFilter, setChainFilter] = useState<number | "all">("all");
  const filteredChains = chainFilter === "all" ? chains : chains.filter((c) => c.id === chainFilter);

  return (
    <>
      <Header />
      <main className="section flex-1 pb-24 pt-32">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <span className="eyebrow">{t("vaults.eyebrow")}</span>
            <h1
              className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl"
              style={{ fontFamily: "var(--font-display)" }}
            >
              {t("vaults.title")}
            </h1>
          </div>
          <Link href="/create" className="btn-primary !px-5 !py-2.5">
            {t("vaults.createVault")}
          </Link>
        </div>

        {isConnected && chains.length > 1 && (
          <div className="mt-8 flex flex-wrap gap-1.5 rounded-full border border-hairline p-1" style={{ width: "fit-content" }}>
            <ChainTab label={t("vaults.chainAll")} active={chainFilter === "all"} onClick={() => setChainFilter("all")} />
            {chains.map((c) => (
              <ChainTab key={c.id} label={c.name} active={chainFilter === c.id} onClick={() => setChainFilter(c.id)} />
            ))}
          </div>
        )}

        {!isConnected && (
          <div className="glass mt-10 rounded-2xl p-10 text-center">
            <p className="text-muted">{t("vaults.connectWallet")}</p>
          </div>
        )}

        {isConnected && <AllVaults chains={filteredChains} owner={address as `0x${string}`} />}
      </main>
    </>
  );
}

function ChainTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={
        active
          ? "rounded-full bg-accent px-4 py-1.5 font-mono text-[11px] uppercase tracking-[0.1em] text-background"
          : "rounded-full px-4 py-1.5 font-mono text-[11px] uppercase tracking-[0.1em] text-muted hover:text-foreground"
      }
    >
      {label}
    </button>
  );
}

// One entry per (chain, factory) pair to actually query — a chain with a
// compound factory deployed (Arbitrum, see chains.ts's ChainDef docstring on
// compoundFactoryAddress) contributes TWO entries, standard and compound;
// every other chain contributes just its standard one. Without this, a
// compound vault would be created successfully (see create/page.tsx) but
// then be permanently invisible from this list — the only factory ever
// queried here today is the standard one.
function factoryTargets(chains: ChainDef[]) {
  return chains.flatMap((chain) => {
    const targets: {
      chain: ChainDef;
      kind: "standard" | "compound";
      factoryAddress: ChainDef["factoryAddress"];
      factoryAbi: ChainDef["factoryAbi"];
    }[] = [{ chain, kind: "standard", factoryAddress: chain.factoryAddress, factoryAbi: chain.factoryAbi }];
    if (chain.compoundFactoryAddress) {
      targets.push({
        chain,
        kind: "compound" as const,
        factoryAddress: chain.compoundFactoryAddress,
        factoryAbi: chain.compoundFactoryAbi!,
      });
    }
    return targets;
  });
}

function AllVaults({ chains, owner }: { chains: ChainDef[]; owner: `0x${string}` }) {
  const { t } = useTranslation();
  const targets = useMemo(() => factoryTargets(chains), [chains]);

  // Stage 1: which vaults exist, per (chain, factory) target — one batched
  // call across every standard AND compound factory.
  const { data: vaultListsData, isLoading: vaultListsLoading } = useReadContracts({
    contracts: targets.map(
      (target) =>
        ({
          address: target.factoryAddress || undefined,
          abi: target.factoryAbi,
          functionName: "getVaultsByOwner",
          args: [owner],
          chainId: target.chain.id,
        }) as const,
    ),
    query: { enabled: targets.some((tg) => tg.factoryAddress) },
  });

  const vaultRefs: VaultRef[] = useMemo(
    () =>
      targets.flatMap((target, i) => {
        const list = (vaultListsData?.[i]?.result as string[] | undefined) ?? [];
        return list.map((address) => ({ chain: target.chain, address: address as `0x${string}`, kind: target.kind }));
      }),
    [targets, vaultListsData],
  );

  // Stage 2: closed flag for every vault across every chain — one batched call.
  const { data: closedData, isLoading: closedLoading } = useReadContracts({
    contracts: vaultRefs.map(
      ({ chain, address, kind }) =>
        ({
          address,
          abi: kind === "compound" ? chain.compoundVaultAbi! : chain.vaultAbi,
          functionName: "closed",
          chainId: chain.id,
        }) as const,
    ),
    query: { enabled: vaultRefs.length > 0, refetchInterval: 60_000 },
  });

  // Stage 3: creation timestamps — one indexer-cached directory fetch per
  // chain (dynamic list of queries, so useQueries rather than one useQuery
  // per chain).
  const creationTimesResults = useQueries({
    queries: chains.map((chain) => ({
      queryKey: ["vault-creation-times", chain.id, owner],
      enabled: Boolean(chain.factoryAddress),
      staleTime: 5 * 60_000,
      queryFn: () => fetchVaultCreationTimes(chain, owner),
    })),
  });
  const creationTimesLoading = creationTimesResults.some((r) => r.isLoading);
  const creationTimes = useMemo(() => {
    const merged: Record<string, number> = {};
    for (const r of creationTimesResults) Object.assign(merged, r.data ?? {});
    return merged;
  }, [creationTimesResults]);

  const isLoading = vaultListsLoading || closedLoading || creationTimesLoading;

  const { activeVaults, closedVaults } = useMemo(() => {
    const records = vaultRefs.map((ref, i) => ({
      ...ref,
      isClosed: closedData?.[i]?.result === true,
      createdAt: creationTimes[ref.address.toLowerCase()] ?? 0,
    }));
    // Newest first within each group.
    const byNewest = (a: { createdAt: number }, b: { createdAt: number }) => b.createdAt - a.createdAt;
    return {
      activeVaults: records.filter((r) => !r.isClosed).sort(byNewest),
      closedVaults: records.filter((r) => r.isClosed).sort(byNewest),
    };
  }, [vaultRefs, closedData, creationTimes]);

  if (isLoading) {
    return (
      <div className="glass mt-10 rounded-2xl p-10 text-center">
        <p className="text-muted">{t("vaults.loading")}</p>
      </div>
    );
  }

  if (vaultRefs.length === 0) {
    return (
      <div className="glass mt-10 rounded-2xl p-10 text-center">
        <p className="text-muted">{t("vaults.noneYet")}</p>
        <Link href="/create" className="btn-primary mt-6 !px-5 !py-2.5">
          {t("vaults.createFirst")}
        </Link>
      </div>
    );
  }

  return (
    <>
      {activeVaults.length > 0 && (
        <ul className="mt-10 flex flex-col gap-4">
          {activeVaults.map(({ chain, address, kind, createdAt }) => (
            <li key={`${chain.id}-${address}`}>
              <VaultCard vaultAddress={address} chain={chain} kind={kind} createdAt={createdAt} />
            </li>
          ))}
        </ul>
      )}

      {closedVaults.length > 0 && (
        <div className="mt-12">
          <h2
            className="text-xl font-semibold tracking-tight text-foreground"
            style={{ fontFamily: "var(--font-display)" }}
          >
            {t("vaults.closedTitle")}
          </h2>
          <p className="mt-1 text-sm text-muted">{t("vaults.closedSubtitle")}</p>
          <ul className="mt-4 flex flex-col gap-4">
            {closedVaults.map(({ chain, address, kind, createdAt }) => (
              <li key={`${chain.id}-${address}`}>
                <VaultCard vaultAddress={address} chain={chain} kind={kind} createdAt={createdAt} isClosed />
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

const cardReads = (address: `0x${string}`, vaultAbi: ChainDef["vaultAbi"]) =>
  [
    "paused",
    "positionTokenId",
    "rebalanceCount",
    "maxRebalances",
    "investableUsdt",
    "reserveBalance",
    "pool",
    "feeTier",
  ].map((functionName) => ({ address, abi: vaultAbi, functionName }) as const);

function VaultCard({
  vaultAddress,
  chain,
  kind,
  createdAt,
  isClosed,
}: {
  vaultAddress: `0x${string}`;
  chain: ChainDef;
  kind: "standard" | "compound";
  createdAt?: number;
  isClosed?: boolean;
}) {
  // Clicking into a vault also switches the app's viewing chain to match it
  // — VaultDetail.tsx reads useSelectedChain(), so without this a vault
  // opened while this list shows a DIFFERENT chain's card would try to read
  // its data from the wrong network.
  const { setSelectedChainId } = useSelectedChain();
  const onNavigate = () => setSelectedChainId(chain.id);
  const { t } = useTranslation();
  const { address: connected } = useAccount();

  // Compounding is beta-gated to a single wallet for now (see
  // lib/compoundBeta.ts) — a non-beta viewer sees this card as if it were a
  // plain standard vault, same as VaultDetail.tsx's own gate.
  const showAsCompound = kind === "compound" && isCompoundBetaWallet(connected);
  const vaultAbi = showAsCompound ? chain.compoundVaultAbi! : chain.vaultAbi;

  // This vault's OWN pair (see lib/useVaultPairInfo.ts) — falls back to the
  // chain's default while loading, correct for every vault today since none
  // are on a non-default pair yet (wild-exploring-bumblebee.md's Fase 3).
  const pairInfo = useVaultPairInfo(vaultAddress, chain, vaultAbi);
  const volatileToken = pairInfo.data?.volatileToken ?? chain.volatileToken;
  const stableIsToken0 = pairInfo.data?.stableIsToken0 ?? chain.stableIsToken0;
  const stableDecimals = pairInfo.data?.stableDecimals ?? 6;
  const volatileDecimals = pairInfo.data?.volatileDecimals ?? 18;
  const stableSymbol = pairInfo.data?.stableSymbol ?? chain.stableSymbol;
  const volatileSymbol = pairInfo.data?.volatileSymbol ?? chain.volatileSymbol;

  const { data } = useReadContracts({
    contracts: cardReads(vaultAddress, vaultAbi).map((c) => ({ ...c, chainId: chain.id })),
    query: { refetchInterval: 60_000 },
  });
  const [paused, positionTokenId, rebalanceCount, maxRebalances, investableUsdt, reserveBalance, poolRaw, feeTierRaw] =
    data?.map((d) => d.result) ?? [];
  // A vault's real pool/fee tier is chosen at creation time, not necessarily
  // chain.pool/chain.feeTier's "default" one — see VaultDetail.tsx's own
  // comment on the same read (confirmed live 2026-07-19 against a real vault
  // on Arbitrum's 0.30% pool, not the 0.05% default).
  const poolAddress = (poolRaw as `0x${string}` | undefined) ?? chain.pool;
  const feeTier = feeTierRaw !== undefined ? Number(feeTierRaw) : chain.feeTier;

  const { data: slot0 } = useReadContract({
    address: poolAddress,
    abi: uniswapV3PoolAbi,
    functionName: "slot0",
    chainId: chain.id,
    query: { refetchInterval: 60_000 },
  });
  const currentTick = slot0 ? Number((slot0 as readonly unknown[])[1]) : undefined;
  const { data: feesSummary } = useVaultFeesSummary(vaultAddress, chain, vaultAbi);

  const hasPosition = Boolean(positionTokenId && (positionTokenId as bigint) > 0n);

  const { data: positionData } = useReadContract({
    address: chain.positionManager,
    abi: positionManagerAbi,
    functionName: "positions",
    args: hasPosition ? [positionTokenId as bigint] : undefined,
    chainId: chain.id,
    query: { enabled: hasPosition, refetchInterval: 60_000 },
  });

  const rawTickLower = hasPosition ? (positionData as readonly unknown[] | undefined)?.[5] as number | undefined : undefined;
  const rawTickUpper = hasPosition ? (positionData as readonly unknown[] | undefined)?.[6] as number | undefined : undefined;

  // Same two-stage read PositionNFT.tsx uses to compute uncollected fees
  // LIVE (via feeGrowthGlobal deltas) instead of trusting the position's own
  // tokensOwed0/1 — that field only gets checkpointed on a mint/burn/collect
  // call and otherwise sits frozen, often at zero, between rebalances even
  // while the pool is actively trading through the range (confirmed here:
  // this exact staleness made this card show $0.00/0.00% while the same
  // vault's own detail page correctly showed real accrued fees). Costs 4
  // extra reads per card with an open position — accepted since correctness
  // (and matching the detail page's own number) matters more here than
  // shaving a few RPC calls off a list that isn't large yet.
  const { data: feeReads } = useReadContracts({
    contracts: [
      { address: poolAddress, abi: uniswapV3PoolAbi, functionName: "feeGrowthGlobal0X128", chainId: chain.id },
      { address: poolAddress, abi: uniswapV3PoolAbi, functionName: "feeGrowthGlobal1X128", chainId: chain.id },
      { address: poolAddress, abi: uniswapV3PoolAbi, functionName: "ticks", args: [rawTickLower ?? 0], chainId: chain.id },
      { address: poolAddress, abi: uniswapV3PoolAbi, functionName: "ticks", args: [rawTickUpper ?? 0], chainId: chain.id },
    ],
    query: { enabled: Boolean(positionData), refetchInterval: 60_000 },
  });

  const ethPrice =
    currentTick !== undefined ? ethPriceFromTick(currentTick, stableIsToken0, stableDecimals, volatileDecimals) : undefined;

  let positionValueUsd: number | undefined;
  let rangeLabel: string | undefined;
  let inRange: boolean | undefined;
  // Same metric as PositionNFT.tsx's own "rendimiento de comisiones (posición
  // actual)" — uncollected fees on the CURRENT position, sized against the
  // position's own current value. Deliberately the SAME formula (not the
  // mark-to-market total-value-vs-initial-investment this card used to show
  // under "rentabilidad flotante", a genuinely different number that
  // confused users into thinking the two pages disagreed).
  let feeYieldPct: number | undefined;
  let unclaimedFeesUsd = 0;
  if (positionData && currentTick !== undefined && ethPrice !== undefined) {
    const [, , , , , tickLower, tickUpper, liquidity, feeGrowthInside0LastX128, feeGrowthInside1LastX128, tokensOwed0, tokensOwed1] =
      positionData as readonly [bigint, string, string, string, number, number, number, bigint, bigint, bigint, bigint, bigint];
    const { amount0Raw, amount1Raw } = estimatePositionAmounts({ liquidity, currentTick, tickLower, tickUpper });
    const stableRaw = stableIsToken0 ? amount0Raw : amount1Raw;
    const volatileRaw = stableIsToken0 ? amount1Raw : amount0Raw;
    positionValueUsd = stableRaw * 10 ** -stableDecimals + volatileRaw * 10 ** -volatileDecimals * ethPrice;

    const feeGrowthGlobal0X128 = feeReads?.[0]?.result as bigint | undefined;
    const feeGrowthGlobal1X128 = feeReads?.[1]?.result as bigint | undefined;
    const tickLowerData = feeReads?.[2]?.result as readonly [bigint, bigint, bigint, bigint, ...unknown[]] | undefined;
    const tickUpperData = feeReads?.[3]?.result as readonly [bigint, bigint, bigint, bigint, ...unknown[]] | undefined;

    let owedStableRaw = stableIsToken0 ? tokensOwed0 : tokensOwed1;
    let owedVolatileRaw = stableIsToken0 ? tokensOwed1 : tokensOwed0;
    if (feeGrowthGlobal0X128 !== undefined && feeGrowthGlobal1X128 !== undefined && tickLowerData && tickUpperData) {
      const live = uncollectedFeesRaw({
        liquidity,
        tokensOwed0,
        tokensOwed1,
        feeGrowthInside0LastX128,
        feeGrowthInside1LastX128,
        feeGrowthGlobal0X128,
        feeGrowthGlobal1X128,
        tickLowerOutside0X128: tickLowerData[2],
        tickLowerOutside1X128: tickLowerData[3],
        tickUpperOutside0X128: tickUpperData[2],
        tickUpperOutside1X128: tickUpperData[3],
        currentTick,
        tickLower,
        tickUpper,
      });
      const fees0Raw = BigInt(Math.max(0, Math.floor(live.fees0Raw)));
      const fees1Raw = BigInt(Math.max(0, Math.floor(live.fees1Raw)));
      owedStableRaw = stableIsToken0 ? fees0Raw : fees1Raw;
      owedVolatileRaw = stableIsToken0 ? fees1Raw : fees0Raw;
    }
    unclaimedFeesUsd =
      Number(owedStableRaw) * 10 ** -stableDecimals + Number(owedVolatileRaw) * 10 ** -volatileDecimals * ethPrice;
    feeYieldPct = positionValueUsd > 0 ? (unclaimedFeesUsd / positionValueUsd) * 100 : 0;

    const priceA = ethPriceFromTick(tickLower, stableIsToken0, stableDecimals, volatileDecimals);
    const priceB = ethPriceFromTick(tickUpper, stableIsToken0, stableDecimals, volatileDecimals);
    const lo = Math.min(priceA, priceB);
    const hi = Math.max(priceA, priceB);
    rangeLabel = `$${lo.toFixed(0)} – $${hi.toFixed(0)}`;

    // Uniswap always mints with tickLower < tickUpper numerically, so this is
    // a plain comparison regardless of the price/tick inversion elsewhere.
    inRange = currentTick >= tickLower && currentTick <= tickUpper;
  }

  const idleCapital = ((investableUsdt as bigint) ?? 0n) + ((reserveBalance as bigint) ?? 0n);

  // Raw WETH the vault holds outside the position — never tracked by a
  // ledger (unlike investableUsdt/reserveBalance), so it's invisible unless
  // read directly. Left out of "Capital libre" before, this stat quietly
  // hid real stranded value from a mis-sized swap (confirmed repeatedly in
  // production 2026-07-16, e.g. vault 0x0Bf394B3...5dEBCE5b8: $191 of WETH
  // sitting here with the USDT-only stat showing $0).
  const { data: idleWeth } = useReadContract({
    address: volatileToken,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [vaultAddress],
    chainId: chain.id,
    query: { refetchInterval: 60_000 },
  });
  const idleWethRaw = (idleWeth as bigint) ?? 0n;
  const idleWethUsd = ethPrice !== undefined ? Number(idleWethRaw) * 10 ** -volatileDecimals * ethPrice : undefined;

  // Rentabilidad = comisiones acumuladas (reclamadas + reinyectadas,
  // convertidas a USD) sobre el monto depositado cuando se creó el vault —
  // no el total histórico (top-ups posteriores no cuentan) ni el capital
  // libre actual (que baja cada vez que se abre/reinyecta una posición), ni
  // anualizado. Debe coincidir con VaultDetail.tsx's feesUsdTotal — mismo
  // vault, misma cuenta, en las dos pantallas.
  const { data: depositSummary } = useVaultDepositSummary(vaultAddress, chain, vaultAbi);
  const feesUsdEquivalent =
    Number(formatUnits(feesSummary?.totalUsdt ?? 0n, stableDecimals)) +
    (ethPrice !== undefined ? Number(formatUnits(feesSummary?.totalWeth ?? 0n, volatileDecimals)) * ethPrice : 0) +
    Number(formatUnits(feesSummary?.reinjectedUsdRaw ?? 0n, stableDecimals));
  const initialInvestmentUsd = Number(formatUnits(depositSummary?.initialInvestmentUsdt ?? 0n, stableDecimals));
  const rentLabel =
    initialInvestmentUsd > 0
      ? t("vaults.returnLabel", { pct: ((feesUsdEquivalent / initialInvestmentUsd) * 100).toFixed(2) })
      : "—";

  const floatingLabel =
    hasPosition && feeYieldPct !== undefined ? t("vaults.floatingReturnLabel", { pct: feeYieldPct.toFixed(2) }) : "—";

  const createdOnLabel =
    createdAt !== undefined && createdAt > 0
      ? t("vaults.createdOn", {
          date: new Date(createdAt * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }),
        })
      : undefined;

  return (
    <Link
      href={showAsCompound ? `/vault/${vaultAddress}?kind=compound` : `/vault/${vaultAddress}`}
      onClick={onNavigate}
      className={`glass glass-hover group block overflow-hidden rounded-2xl ${isClosed ? "opacity-60" : ""}`}
    >
      {/* Header row: pair icon anchors the row like a Uniswap position list
          entry, badges/address trail after it, all on one line on desktop. */}
      <div className="flex flex-wrap items-center gap-4 p-5">
        <PairIcon volatileSymbol={volatileSymbol} stableSymbol={stableSymbol} size={36} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-base font-semibold text-foreground">
              {stableSymbol} / {volatileSymbol}
            </span>
            <span className="rounded-md border border-hairline px-1.5 py-0.5 font-mono text-[11px] text-faint">
              {feeTier / 10_000}%
            </span>
            <span className="eyebrow flex items-center gap-1.5 !px-2.5 !py-0.5">
              <ChainIcon chainId={chain.id} size={13} />
              {chain.name}
            </span>
            {showAsCompound && (
              <span className="eyebrow !border-accent/40 !px-2.5 !py-0.5 !text-accent-text">
                {t("vaults.compoundBadge")}
              </span>
            )}
            {isClosed ? (
              <span className="eyebrow !px-2.5 !py-0.5">{t("vaults.closed")}</span>
            ) : paused ? (
              <span className="eyebrow !border-negative/40 !px-2.5 !py-0.5 !text-negative">{t("vaults.paused")}</span>
            ) : (
              <span className="eyebrow !border-positive/40 !px-2.5 !py-0.5 !text-positive">{t("vaults.active")}</span>
            )}
            {!isClosed && !hasPosition && <span className="eyebrow !px-2.5 !py-0.5">{t("vaults.noPosition")}</span>}
            {!isClosed && hasPosition && inRange !== undefined && (
              <span
                className={
                  inRange
                    ? "eyebrow !border-positive/40 !px-2.5 !py-0.5 !text-positive"
                    : "eyebrow !border-negative/40 !px-2.5 !py-0.5 !text-negative"
                }
              >
                {inRange ? t("vaults.inRange") : t("vaults.outOfRange")}
              </span>
            )}
          </div>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px] text-faint">
            <span className="break-all">{vaultAddress}</span>
            {createdOnLabel && <span>{createdOnLabel}</span>}
          </p>
        </div>
        <span className="hidden shrink-0 text-xs text-faint transition-colors group-hover:text-accent-text sm:block">
          {t("vaults.viewDetail")}
        </span>
      </div>

      {/* Stat strip: one row of columns spanning the card's full width,
          wrapping down on narrower screens. Color is reserved for what it
          actually means — accent on the headline position value, green/red
          only on genuine gain/loss figures, everything else neutral. */}
      <div className="grid grid-cols-2 gap-4 border-t border-hairline bg-surface-1 px-5 py-4 sm:grid-cols-3 lg:grid-cols-6">
        <StatCell label={t("vaults.positionValue")}>
          <p className="text-lg font-semibold tabular-nums text-accent-text" style={{ fontFamily: "var(--font-display)" }}>
            {hasPosition && positionValueUsd !== undefined ? `$${positionValueUsd.toFixed(2)}` : "—"}
          </p>
        </StatCell>

        <StatCell label={t("vaults.range")}>
          <p className="font-mono text-xs text-foreground/80">
            {hasPosition && rangeLabel ? rangeLabel : t("vaults.noOpenPosition")}
          </p>
        </StatCell>

        <StatCell label={t("vaults.freeCapital")}>
          <p className="text-sm font-medium text-foreground/90">
            {formatUnits(idleCapital, stableDecimals)} {stableSymbol}
          </p>
          {idleWethRaw > 0n && (
            <p className="mt-0.5 font-mono text-xs text-amber-400">
              + {Number(formatUnits(idleWethRaw, volatileDecimals)).toFixed(6)} {volatileSymbol}
              {idleWethUsd !== undefined ? ` (~$${idleWethUsd.toFixed(2)})` : ""}
            </p>
          )}
        </StatCell>

        <StatCell label={t("vaults.rebalances")}>
          <p className="text-sm font-medium text-foreground/90">
            {String(rebalanceCount ?? 0)} / {String(maxRebalances ?? 0)}
          </p>
        </StatCell>

        <StatCell label={t("vaults.fees")}>
          {/* Headline is the TRUE total in USD (claimed + reinjected) — was
              showing just the raw stable-leg amount before, with no overall
              total anywhere on this card, unlike VaultDetail.tsx's own
              "Comisiones generadas" stat which leads with the $ total. Same
              claimed-only raw breakdown kept as the secondary hint below. */}
          <p className="text-sm font-medium text-positive">${feesUsdEquivalent.toFixed(2)}</p>
          <p className="mt-0.5 font-mono text-xs text-positive/70">
            {formatUnits(feesSummary?.totalUsdt ?? 0n, stableDecimals)} {stableSymbol}
            {(feesSummary?.totalWeth ?? 0n) > 0n
              ? ` + ${Number(formatUnits(feesSummary?.totalWeth ?? 0n, volatileDecimals)).toFixed(6)} ${volatileSymbol}`
              : ""}
          </p>
          <p className="mt-0.5 font-mono text-xs text-foreground/50">{rentLabel}</p>
        </StatCell>

        <StatCell label={t("vaults.floatingReturn")}>
          {/* Same pairing as PositionNFT.tsx's own card: the $ unclaimed-fees
              amount alongside the % it represents of the position's value —
              showing only the % here (with no $ figure anywhere on this
              card) was its own source of confusion. */}
          <p className="text-sm font-medium text-positive">${unclaimedFeesUsd.toFixed(2)}</p>
          <p className={`mt-0.5 font-mono text-xs ${(feeYieldPct ?? 0) >= 0 ? "text-positive/70" : "text-negative"}`}>
            {floatingLabel}
          </p>
        </StatCell>
      </div>
    </Link>
  );
}

function StatCell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">{label}</p>
      <div className="mt-1">{children}</div>
    </div>
  );
}
