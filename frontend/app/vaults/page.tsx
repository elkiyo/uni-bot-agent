"use client";

import Link from "next/link";
import { useAccount, useReadContract, useReadContracts } from "wagmi";
import { formatUnits } from "viem";
import { Header } from "../components/Header";
import { uniswapV3PoolAbi, positionManagerAbi, erc20Abi } from "@/lib/contracts";
import { ethPriceFromTick } from "@/lib/priceMath";
import { estimatePositionAmounts } from "@/lib/keeper/swapMath";
import { useVaultFeesSummary } from "@/lib/useVaultFeesSummary";
import { useVaultDepositSummary } from "@/lib/useVaultDepositSummary";
import { useAvailableChains, useSelectedChain } from "@/lib/useSelectedChain";
import type { ChainDef } from "@/lib/chains";

/**
 * Shows every vault across every deployed chain at once — not just whichever
 * one the app's selected-chain state (useSelectedChain) happens to be on.
 * Confirmed in production 2026-07-17: a user's real Celo vaults appeared to
 * vanish simply because that selection was left on Arbitrum from testing —
 * a single-chain-filtered "Mis vaults" is the wrong default for a page whose
 * whole point is "show me everything I own". The selected-chain concept
 * still exists for /create's network picker and the vault detail page's
 * write flows, just not for this list.
 */
export default function VaultsPage() {
  const { address, isConnected } = useAccount();
  const chains = useAvailableChains();

  return (
    <>
      <Header />
      <main className="section flex-1 pb-24 pt-32">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <span className="eyebrow">Panel</span>
            <h1
              className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl"
              style={{ fontFamily: "var(--font-display)" }}
            >
              Mis vaults
            </h1>
          </div>
          <Link href="/create" className="btn-primary !px-5 !py-2.5">
            Crear vault
          </Link>
        </div>

        {!isConnected && (
          <div className="glass mt-10 rounded-2xl p-10 text-center">
            <p className="text-muted">Conectá tu wallet para ver tus vaults.</p>
          </div>
        )}

        {isConnected &&
          chains.map((chain) => (
            <ChainVaultsSection key={chain.id} chain={chain} owner={address as `0x${string}`} />
          ))}
      </main>
    </>
  );
}

function ChainVaultsSection({ chain, owner }: { chain: ChainDef; owner: `0x${string}` }) {
  const { setSelectedChainId } = useSelectedChain();

  const { data: slot0 } = useReadContract({
    address: chain.pool,
    abi: uniswapV3PoolAbi,
    functionName: "slot0",
    chainId: chain.id,
    query: { refetchInterval: 15_000 },
  });
  const currentTick = slot0 ? Number((slot0 as readonly unknown[])[1]) : undefined;

  const { data: vaults, isLoading } = useReadContract({
    address: chain.factoryAddress || undefined,
    abi: chain.factoryAbi,
    functionName: "getVaultsByOwner",
    args: [owner],
    chainId: chain.id,
    query: { enabled: Boolean(chain.factoryAddress) },
  });
  const vaultList = (vaults as string[] | undefined) ?? [];

  // closeVault() is permanent — split those out below instead of mixing them
  // in with vaults that can still operate.
  const { data: closedFlags } = useReadContracts({
    contracts: vaultList.map(
      (v) => ({ address: v as `0x${string}`, abi: chain.vaultAbi, functionName: "closed", chainId: chain.id }) as const,
    ),
    query: { enabled: vaultList.length > 0, refetchInterval: 15_000 },
  });
  const activeVaults = vaultList.filter((_, i) => closedFlags?.[i]?.result !== true);
  const closedVaults = vaultList.filter((_, i) => closedFlags?.[i]?.result === true);

  // Clicking into a vault also switches the app's viewing chain to match it
  // — VaultDetail.tsx reads useSelectedChain(), so without this a vault
  // opened while browsing a DIFFERENT chain's section would try to read its
  // data from the wrong network.
  const goToChain = () => setSelectedChainId(chain.id);

  if (isLoading) {
    return (
      <div className="mt-10">
        <ChainSectionHeader chain={chain} />
        <div className="glass mt-4 rounded-2xl p-10 text-center">
          <p className="text-muted">Cargando…</p>
        </div>
      </div>
    );
  }

  if (vaultList.length === 0) return null; // no noise for a chain the user has nothing on

  return (
    <div className="mt-10">
      <ChainSectionHeader chain={chain} />

      {activeVaults.length > 0 && (
        <ul className="mt-4 grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {activeVaults.map((vaultAddress) => (
            <li key={vaultAddress}>
              <VaultCard
                vaultAddress={vaultAddress as `0x${string}`}
                currentTick={currentTick}
                chain={chain}
                onNavigate={goToChain}
              />
            </li>
          ))}
        </ul>
      )}

      {closedVaults.length > 0 && (
        <div className="mt-6">
          <p className="text-sm text-muted">Cerrados permanentemente — no pueden recibir depósitos ni operar de nuevo.</p>
          <ul className="mt-4 grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
            {closedVaults.map((vaultAddress) => (
              <li key={vaultAddress}>
                <VaultCard
                  vaultAddress={vaultAddress as `0x${string}`}
                  currentTick={currentTick}
                  chain={chain}
                  onNavigate={goToChain}
                  isClosed
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ChainSectionHeader({ chain }: { chain: ChainDef }) {
  return (
    <div className="flex items-center gap-2">
      <h2 className="text-lg font-semibold tracking-tight text-white/90" style={{ fontFamily: "var(--font-display)" }}>
        {chain.name}
      </h2>
      <span className="eyebrow !px-3 !py-1">
        {chain.stableSymbol}/{chain.volatileSymbol}
      </span>
    </div>
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
  ].map((functionName) => ({ address, abi: vaultAbi, functionName }) as const);

function VaultCard({
  vaultAddress,
  currentTick,
  chain,
  onNavigate,
  isClosed,
}: {
  vaultAddress: `0x${string}`;
  currentTick?: number;
  chain: ChainDef;
  onNavigate: () => void;
  isClosed?: boolean;
}) {
  const { data } = useReadContracts({
    contracts: cardReads(vaultAddress, chain.vaultAbi).map((c) => ({ ...c, chainId: chain.id })),
    query: { refetchInterval: 15_000 },
  });
  const [paused, positionTokenId, rebalanceCount, maxRebalances, investableUsdt, reserveBalance] =
    data?.map((d) => d.result) ?? [];
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
    initialInvestmentUsd > 0 ? `${((feesUsdEquivalent / initialInvestmentUsd) * 100).toFixed(2)}% rent.` : "—";

  return (
    <Link
      href={`/vault/${vaultAddress}`}
      onClick={onNavigate}
      className={`glass glass-hover group block rounded-2xl p-5 ${isClosed ? "opacity-60" : ""}`}
    >
      <div className="flex items-center justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <span className="eyebrow !px-3 !py-1">Vault</span>
          {isClosed ? (
            <span className="eyebrow !px-3 !py-1">Cerrado</span>
          ) : paused ? (
            <span className="eyebrow !border-negative/40 !px-3 !py-1 !text-negative">Pausado</span>
          ) : (
            <span className="eyebrow !border-positive/40 !px-3 !py-1 !text-positive">Activo</span>
          )}
          {!isClosed && !hasPosition && <span className="eyebrow !px-3 !py-1">Sin posición</span>}
          {!isClosed && hasPosition && inRange !== undefined && (
            <span
              className={
                inRange
                  ? "eyebrow !border-positive/40 !px-3 !py-1 !text-positive"
                  : "eyebrow !border-negative/40 !px-3 !py-1 !text-negative"
              }
            >
              {inRange ? "En rango" : "Fuera de rango"}
            </span>
          )}
        </div>
        <span className="text-xs text-faint transition-colors group-hover:text-accent">Ver detalle →</span>
      </div>

      <p className="mt-4 break-all font-mono text-xs text-white/70">{vaultAddress}</p>
      <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.14em] text-faint">
        {chain.stableSymbol} / {chain.volatileSymbol} · {chain.feeTier / 10_000}%
      </p>

      {/* Headline: what the position is actually worth right now, and where */}
      <div className="mt-4 rounded-xl border border-hairline bg-white/[0.02] p-4">
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">Valor de la posición</p>
        <p
          className="mt-1 text-2xl font-semibold tabular-nums text-accent"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {hasPosition && positionValueUsd !== undefined ? `$${positionValueUsd.toFixed(2)}` : "—"}
        </p>
        <p className="mt-1 font-mono text-xs text-sky-400">
          {hasPosition && rangeLabel ? rangeLabel : "sin posición abierta"}
        </p>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-4 border-t border-hairline pt-4">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">Capital libre</p>
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
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">Rebalanceos</p>
          <p className="mt-1 text-sm font-medium text-violet-400">
            {String(rebalanceCount ?? 0)} / {String(maxRebalances ?? 0)}
          </p>
        </div>
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">Comisiones</p>
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
      </div>
    </Link>
  );
}
