"use client";

import Link from "next/link";
import { useAccount, useReadContract, useReadContracts } from "wagmi";
import { formatUnits } from "viem";
import { Header } from "../components/Header";
import { vaultFactoryAbi, rangeVaultAbi, uniswapV3PoolAbi, positionManagerAbi } from "@/lib/contracts";
import { FACTORY_ADDRESS, POOL, POSITION_MANAGER } from "@/lib/addresses";
import { ethPriceFromTick } from "@/lib/priceMath";
import { estimatePositionAmounts } from "@/lib/keeper/swapMath";
import { useVaultFeesSummary } from "@/lib/useVaultFeesSummary";

export default function VaultsPage() {
  const { address, isConnected } = useAccount();

  // Fetched once here and passed down — every card needs the live price, no
  // reason for each of N cards to poll the same pool independently.
  const { data: slot0 } = useReadContract({
    address: POOL,
    abi: uniswapV3PoolAbi,
    functionName: "slot0",
    query: { refetchInterval: 15_000 },
  });
  const currentTick = slot0 ? Number((slot0 as readonly unknown[])[1]) : undefined;

  const { data: vaults, isLoading } = useReadContract({
    address: FACTORY_ADDRESS,
    abi: vaultFactoryAbi,
    functionName: "getVaultsByOwner",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address && FACTORY_ADDRESS) },
  });
  const vaultList = (vaults as string[] | undefined) ?? [];

  // closeVault() is permanent — split those out below instead of mixing them
  // in with vaults that can still operate.
  const { data: closedFlags } = useReadContracts({
    contracts: vaultList.map(
      (v) => ({ address: v as `0x${string}`, abi: rangeVaultAbi, functionName: "closed" }) as const,
    ),
    query: { enabled: vaultList.length > 0, refetchInterval: 15_000 },
  });
  const activeVaults = vaultList.filter((_, i) => closedFlags?.[i]?.result !== true);
  const closedVaults = vaultList.filter((_, i) => closedFlags?.[i]?.result === true);

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

        <div className="mt-10">
          {!FACTORY_ADDRESS && (
            <div className="glass rounded-2xl border-accent/35 bg-accent/[0.06] p-5 text-sm text-muted">
              Los contratos todavía no están configurados en este entorno.
            </div>
          )}

          {FACTORY_ADDRESS && !isConnected && (
            <div className="glass rounded-2xl p-10 text-center">
              <p className="text-muted">Conectá tu wallet para ver tus vaults.</p>
            </div>
          )}

          {FACTORY_ADDRESS && isConnected && isLoading && (
            <div className="glass rounded-2xl p-10 text-center">
              <p className="text-muted">Cargando…</p>
            </div>
          )}

          {FACTORY_ADDRESS && isConnected && !isLoading && vaultList.length === 0 && (
            <div className="glass rounded-2xl p-10 text-center">
              <p className="text-muted">Todavía no tenés ningún vault.</p>
              <Link href="/create" className="btn-primary mt-6 !px-5 !py-2.5">
                Crear mi primer vault
              </Link>
            </div>
          )}

          {activeVaults.length > 0 && (
            <ul className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
              {activeVaults.map((vaultAddress) => (
                <li key={vaultAddress}>
                  <VaultCard vaultAddress={vaultAddress as `0x${string}`} currentTick={currentTick} />
                </li>
              ))}
            </ul>
          )}
        </div>

        {closedVaults.length > 0 && (
          <div className="mt-12">
            <h2
              className="text-lg font-semibold tracking-tight text-faint"
              style={{ fontFamily: "var(--font-display)" }}
            >
              Vaults cerrados
            </h2>
            <p className="mt-1 text-sm text-muted">
              Cerrados permanentemente — no pueden recibir depósitos ni operar de nuevo.
            </p>
            <ul className="mt-4 grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
              {closedVaults.map((vaultAddress) => (
                <li key={vaultAddress}>
                  <VaultCard vaultAddress={vaultAddress as `0x${string}`} currentTick={currentTick} isClosed />
                </li>
              ))}
            </ul>
          </div>
        )}
      </main>
    </>
  );
}

const cardReads = (address: `0x${string}`) =>
  [
    "paused",
    "positionTokenId",
    "rebalanceCount",
    "maxRebalances",
    "investableUsdt",
    "reserveBalance",
    "usdtBudget",
  ].map((functionName) => ({ address, abi: rangeVaultAbi, functionName }) as const);

function VaultCard({
  vaultAddress,
  currentTick,
  isClosed,
}: {
  vaultAddress: `0x${string}`;
  currentTick?: number;
  isClosed?: boolean;
}) {
  const { data } = useReadContracts({
    contracts: cardReads(vaultAddress),
    query: { refetchInterval: 15_000 },
  });
  const [paused, positionTokenId, rebalanceCount, maxRebalances, investableUsdt, reserveBalance, usdtBudget] =
    data?.map((d) => d.result) ?? [];
  const { data: feesSummary } = useVaultFeesSummary(vaultAddress);

  const hasPosition = Boolean(positionTokenId && (positionTokenId as bigint) > 0n);

  const { data: positionData } = useReadContract({
    address: POSITION_MANAGER,
    abi: positionManagerAbi,
    functionName: "positions",
    args: hasPosition ? [positionTokenId as bigint] : undefined,
    query: { enabled: hasPosition, refetchInterval: 15_000 },
  });

  const ethPrice = currentTick !== undefined ? ethPriceFromTick(currentTick) : undefined;

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
    positionValueUsd = amount0Raw * 1e-6 + amount1Raw * 1e-18 * ethPrice;

    const priceA = ethPriceFromTick(tickLower);
    const priceB = ethPriceFromTick(tickUpper);
    const lo = Math.min(priceA, priceB);
    const hi = Math.max(priceA, priceB);
    rangeLabel = `$${lo.toFixed(0)} – $${hi.toFixed(0)}`;

    // Uniswap always mints with tickLower < tickUpper numerically, so this is
    // a plain comparison regardless of the price/tick inversion elsewhere.
    inRange = currentTick >= tickLower && currentTick <= tickUpper;
  }

  const idleCapital =
    ((investableUsdt as bigint) ?? 0n) + ((reserveBalance as bigint) ?? 0n) + ((usdtBudget as bigint) ?? 0n);

  return (
    <Link
      href={`/vault/${vaultAddress}`}
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
      <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.14em] text-faint">USDT / WETH · 0.3%</p>

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
          <p className="mt-1 text-sm font-medium text-white/90">{formatUnits(idleCapital, 6)} USDT</p>
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
            {formatUnits(feesSummary?.totalUsdt ?? 0n, 6)} USDT
          </p>
        </div>
      </div>
    </Link>
  );
}
