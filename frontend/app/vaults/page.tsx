"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useAccount, useReadContract, useReadContracts } from "wagmi";
import { useQueries } from "@tanstack/react-query";
import { formatUnits } from "viem";
import { Header } from "../components/Header";
import { ChainIcon } from "../components/ChainIcon";
import { uniswapV3PoolAbi, positionManagerAbi, erc20Abi } from "@/lib/contracts";
import { ethPriceFromTick } from "@/lib/priceMath";
import { estimatePositionAmounts } from "@/lib/keeper/swapMath";
import { useVaultFeesSummary } from "@/lib/useVaultFeesSummary";
import { useVaultDepositSummary } from "@/lib/useVaultDepositSummary";
import { fetchVaultCreationTimes } from "@/lib/useVaultCreationTimes";
import { useAvailableChains, useSelectedChain } from "@/lib/useSelectedChain";
import type { ChainDef } from "@/lib/chains";
import { useTranslation } from "@/lib/i18n/useTranslation";

interface VaultRef {
  chain: ChainDef;
  address: `0x${string}`;
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

        {!isConnected && (
          <div className="glass mt-10 rounded-2xl p-10 text-center">
            <p className="text-muted">{t("vaults.connectWallet")}</p>
          </div>
        )}

        {isConnected && <AllVaults chains={chains} owner={address as `0x${string}`} />}
      </main>
    </>
  );
}

function AllVaults({ chains, owner }: { chains: ChainDef[]; owner: `0x${string}` }) {
  const { t } = useTranslation();
  // Stage 1: which vaults exist, per chain — one batched call across chains.
  const { data: vaultListsData, isLoading: vaultListsLoading } = useReadContracts({
    contracts: chains.map(
      (chain) =>
        ({
          address: chain.factoryAddress || undefined,
          abi: chain.factoryAbi,
          functionName: "getVaultsByOwner",
          args: [owner],
          chainId: chain.id,
        }) as const,
    ),
    query: { enabled: chains.some((c) => c.factoryAddress) },
  });

  const vaultRefs: VaultRef[] = useMemo(
    () =>
      chains.flatMap((chain, i) => {
        const list = (vaultListsData?.[i]?.result as string[] | undefined) ?? [];
        return list.map((address) => ({ chain, address: address as `0x${string}` }));
      }),
    [chains, vaultListsData],
  );

  // Stage 2: closed flag for every vault across every chain — one batched call.
  const { data: closedData, isLoading: closedLoading } = useReadContracts({
    contracts: vaultRefs.map(
      ({ chain, address }) => ({ address, abi: chain.vaultAbi, functionName: "closed", chainId: chain.id }) as const,
    ),
    query: { enabled: vaultRefs.length > 0, refetchInterval: 15_000 },
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
        <ul className="mt-10 grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {activeVaults.map(({ chain, address, createdAt }) => (
            <li key={`${chain.id}-${address}`}>
              <VaultCard vaultAddress={address} chain={chain} createdAt={createdAt} />
            </li>
          ))}
        </ul>
      )}

      {closedVaults.length > 0 && (
        <div className="mt-12">
          <h2
            className="text-lg font-semibold tracking-tight text-faint"
            style={{ fontFamily: "var(--font-display)" }}
          >
            {t("vaults.closedTitle")}
          </h2>
          <p className="mt-1 text-sm text-muted">{t("vaults.closedSubtitle")}</p>
          <ul className="mt-4 grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
            {closedVaults.map(({ chain, address, createdAt }) => (
              <li key={`${chain.id}-${address}`}>
                <VaultCard vaultAddress={address} chain={chain} createdAt={createdAt} isClosed />
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
  createdAt,
  isClosed,
}: {
  vaultAddress: `0x${string}`;
  chain: ChainDef;
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

  const { data } = useReadContracts({
    contracts: cardReads(vaultAddress, chain.vaultAbi).map((c) => ({ ...c, chainId: chain.id })),
    query: { refetchInterval: 15_000 },
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
    query: { refetchInterval: 15_000 },
  });
  const currentTick = slot0 ? Number((slot0 as readonly unknown[])[1]) : undefined;
  const { data: feesSummary } = useVaultFeesSummary(vaultAddress, chain);

  const hasPosition = Boolean(positionTokenId && (positionTokenId as bigint) > 0n);

  const { data: positionData } = useReadContract({
    address: chain.positionManager,
    abi: positionManagerAbi,
    functionName: "positions",
    args: hasPosition ? [positionTokenId as bigint] : undefined,
    chainId: chain.id,
    query: { enabled: hasPosition, refetchInterval: 15_000 },
  });

  const ethPrice = currentTick !== undefined ? ethPriceFromTick(currentTick, chain.stableIsToken0) : undefined;

  let positionValueUsd: number | undefined;
  let rangeLabel: string | undefined;
  let inRange: boolean | undefined;
  if (positionData && currentTick !== undefined && ethPrice !== undefined) {
    const [, , , , , tickLower, tickUpper, liquidity] = positionData as readonly [
      bigint,
      string,
      string,
      string,
      number,
      number,
      number,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
    ];
    const { amount0Raw, amount1Raw } = estimatePositionAmounts({ liquidity, currentTick, tickLower, tickUpper });
    const stableRaw = chain.stableIsToken0 ? amount0Raw : amount1Raw;
    const volatileRaw = chain.stableIsToken0 ? amount1Raw : amount0Raw;
    positionValueUsd = stableRaw * 1e-6 + volatileRaw * 1e-18 * ethPrice;

    const priceA = ethPriceFromTick(tickLower, chain.stableIsToken0);
    const priceB = ethPriceFromTick(tickUpper, chain.stableIsToken0);
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
    address: chain.volatileToken,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [vaultAddress],
    chainId: chain.id,
    query: { refetchInterval: 15_000 },
  });
  const idleWethRaw = (idleWeth as bigint) ?? 0n;
  const idleWethUsd = ethPrice !== undefined ? Number(idleWethRaw) * 1e-18 * ethPrice : undefined;

  // Rentabilidad = comisiones acumuladas (convertidas a USD) sobre el monto
  // depositado cuando se creó el vault — no el total histórico (top-ups
  // posteriores no cuentan) ni el capital libre actual (que baja cada vez que
  // se abre/reinyecta una posición), ni anualizado.
  const { data: depositSummary } = useVaultDepositSummary(vaultAddress, chain);
  const feesUsdEquivalent =
    Number(formatUnits(feesSummary?.totalUsdt ?? 0n, 6)) +
    (ethPrice !== undefined ? Number(formatUnits(feesSummary?.totalWeth ?? 0n, 18)) * ethPrice : 0);
  const initialInvestmentUsd = Number(formatUnits(depositSummary?.initialInvestmentUsdt ?? 0n, 6));
  const rentLabel =
    initialInvestmentUsd > 0
      ? t("vaults.returnLabel", { pct: ((feesUsdEquivalent / initialInvestmentUsd) * 100).toFixed(2) })
      : "—";

  // Rentabilidad flotante = valor actual de todo lo que el vault sostiene
  // ahora mismo (posición mark-to-market + capital libre) contra la
  // inversión inicial — a diferencia de "rentLabel" arriba, esto SÍ refleja
  // impermanent loss / suba de precio, no solo comisiones cobradas.
  const currentTotalValueUsd =
    (hasPosition ? (positionValueUsd ?? 0) : 0) + Number(formatUnits(idleCapital, 6)) + (idleWethUsd ?? 0);
  const floatingPct =
    initialInvestmentUsd > 0 ? ((currentTotalValueUsd - initialInvestmentUsd) / initialInvestmentUsd) * 100 : undefined;
  const floatingLabel = floatingPct !== undefined ? t("vaults.floatingReturnLabel", { pct: floatingPct.toFixed(2) }) : "—";

  const createdOnLabel =
    createdAt !== undefined && createdAt > 0
      ? t("vaults.createdOn", {
          date: new Date(createdAt * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }),
        })
      : undefined;

  return (
    <Link
      href={`/vault/${vaultAddress}`}
      onClick={onNavigate}
      className={`glass glass-hover group block rounded-2xl p-5 ${isClosed ? "opacity-60" : ""}`}
    >
      <div className="flex items-center justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <span className="eyebrow flex items-center gap-1.5 !border-accent/40 !px-3 !py-1 !text-accent">
            <ChainIcon chainId={chain.id} className="h-3.5 w-3.5 shrink-0" />
            {chain.name}
          </span>
          {isClosed ? (
            <span className="eyebrow !px-3 !py-1">{t("vaults.closed")}</span>
          ) : paused ? (
            <span className="eyebrow !border-negative/40 !px-3 !py-1 !text-negative">{t("vaults.paused")}</span>
          ) : (
            <span className="eyebrow !border-positive/40 !px-3 !py-1 !text-positive">{t("vaults.active")}</span>
          )}
          {!isClosed && !hasPosition && <span className="eyebrow !px-3 !py-1">{t("vaults.noPosition")}</span>}
          {!isClosed && hasPosition && inRange !== undefined && (
            <span
              className={
                inRange
                  ? "eyebrow !border-positive/40 !px-3 !py-1 !text-positive"
                  : "eyebrow !border-negative/40 !px-3 !py-1 !text-negative"
              }
            >
              {inRange ? t("vaults.inRange") : t("vaults.outOfRange")}
            </span>
          )}
        </div>
        <span className="text-xs text-faint transition-colors group-hover:text-accent">{t("vaults.viewDetail")}</span>
      </div>

      <p className="mt-4 break-all font-mono text-xs text-white/70">{vaultAddress}</p>
      <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.14em] text-faint">
        {chain.stableSymbol} / {chain.volatileSymbol} · {feeTier / 10_000}%
      </p>
      {createdOnLabel && <p className="mt-1 font-mono text-[11px] text-faint">{createdOnLabel}</p>}

      {/* Headline: what the position is actually worth right now, and where */}
      <div className="mt-4 rounded-xl border border-hairline bg-white/[0.02] p-4">
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">{t("vaults.positionValue")}</p>
        <p
          className="mt-1 text-2xl font-semibold tabular-nums text-accent"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {hasPosition && positionValueUsd !== undefined ? `$${positionValueUsd.toFixed(2)}` : "—"}
        </p>
        {hasPosition && rangeLabel ? (
          <>
            <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.14em] text-faint">{t("vaults.range")}</p>
            <p className="mt-0.5 font-mono text-xs text-sky-400">{rangeLabel}</p>
          </>
        ) : (
          <p className="mt-1 font-mono text-xs text-sky-400">{t("vaults.noOpenPosition")}</p>
        )}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-4 border-t border-hairline pt-4">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">{t("vaults.freeCapital")}</p>
          <p className="mt-1 text-sm font-medium text-white/90">
            {formatUnits(idleCapital, 6)} {chain.stableSymbol}
          </p>
          {idleWethRaw > 0n && (
            <p className="mt-0.5 font-mono text-xs text-negative">
              + {Number(formatUnits(idleWethRaw, 18)).toFixed(6)} {chain.volatileSymbol}
              {idleWethUsd !== undefined ? ` (~$${idleWethUsd.toFixed(2)})` : ""}
            </p>
          )}
        </div>
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">{t("vaults.rebalances")}</p>
          <p className="mt-1 text-sm font-medium text-violet-400">
            {String(rebalanceCount ?? 0)} / {String(maxRebalances ?? 0)}
          </p>
        </div>
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">{t("vaults.fees")}</p>
          <p className="mt-1 text-sm font-medium text-positive">
            {formatUnits(feesSummary?.totalUsdt ?? 0n, 6)} {chain.stableSymbol}
          </p>
          {(feesSummary?.totalWeth ?? 0n) > 0n && (
            <p className="mt-0.5 font-mono text-xs text-positive/70">
              + {Number(formatUnits(feesSummary?.totalWeth ?? 0n, 18)).toFixed(6)} {chain.volatileSymbol}
              {ethPrice !== undefined
                ? ` (~$${(Number(formatUnits(feesSummary?.totalWeth ?? 0n, 18)) * ethPrice).toFixed(2)})`
                : ""}
            </p>
          )}
          <p className="mt-0.5 font-mono text-xs text-accent">{rentLabel}</p>
        </div>
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">{t("vaults.floatingReturn")}</p>
          <p className={`mt-1 text-sm font-medium ${(floatingPct ?? 0) >= 0 ? "text-positive" : "text-negative"}`}>
            {floatingLabel}
          </p>
        </div>
      </div>
    </Link>
  );
}
