"use client";

import Link from "next/link";
import { useAccount, useReadContract, useReadContracts } from "wagmi";
import { formatUnits } from "viem";
import { Header } from "./components/Header";
import { vaultFactoryAbi, rangeVaultAbi } from "@/lib/contracts";
import { FACTORY_ADDRESS, POOL } from "@/lib/addresses";
import { useVaultFeesSummary } from "@/lib/useVaultFeesSummary";

export default function Home() {
  const { address, isConnected } = useAccount();

  const { data: vaults, isLoading } = useReadContract({
    address: FACTORY_ADDRESS,
    abi: vaultFactoryAbi,
    functionName: "getVaultsByOwner",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address && FACTORY_ADDRESS) },
  });

  const vaultList = (vaults as string[] | undefined) ?? [];

  // closeVault() is permanent (deposit/configureTarget/initPosition/rebalance
  // all revert forever after) — split those out below the active list instead
  // of mixing them in, since they can never operate again.
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
        {/* Hero */}
        <div className="max-w-3xl">
          <span className="eyebrow">Uniswap V3 · Celo Mainnet</span>
          <h1
            className="mt-6 text-balance text-4xl font-semibold leading-[1.04] tracking-tight sm:text-5xl"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Liquidez concentrada,{" "}
            <span className="text-accent">gestionada por un agente</span> — sin ceder la
            custodia.
          </h1>
          <p className="mt-5 max-w-xl text-[15px] leading-relaxed text-muted">
            Depositás USDT, el agente arma y rebalancea tu posición en el pool USDT/WETH.
            Solo vos podés retirar los fondos: el operador únicamente rebalancea, dentro
            de los límites que vos configurás.
          </p>
        </div>

        {/* Vaults */}
        <div className="mt-16">
          <div className="flex items-center justify-between">
            <h2
              className="text-2xl font-semibold tracking-tight"
              style={{ fontFamily: "var(--font-display)" }}
            >
              Mis vaults
            </h2>
            <Link href="/create" className="btn-primary !px-5 !py-2.5">
              Crear vault
            </Link>
          </div>

          <div className="mt-6">
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
              <ul className="grid gap-4 sm:grid-cols-2">
                {activeVaults.map((vaultAddress) => (
                  <li key={vaultAddress}>
                    <VaultCard vaultAddress={vaultAddress as `0x${string}`} />
                  </li>
                ))}
              </ul>
            )}

            {vaultList.length > 0 && activeVaults.length === 0 && closedVaults.length === 0 && (
              <div className="glass rounded-2xl p-10 text-center">
                <p className="text-muted">Cargando estado de tus vaults…</p>
              </div>
            )}
          </div>
        </div>

        {closedVaults.length > 0 && (
          <div className="mt-10">
            <h2
              className="text-lg font-semibold tracking-tight text-faint"
              style={{ fontFamily: "var(--font-display)" }}
            >
              Vaults cerrados
            </h2>
            <p className="mt-1 text-sm text-muted">
              Cerrados permanentemente — no pueden recibir depósitos ni operar de nuevo.
            </p>
            <ul className="mt-4 grid gap-4 sm:grid-cols-2">
              {closedVaults.map((vaultAddress) => (
                <li key={vaultAddress}>
                  <VaultCard vaultAddress={vaultAddress as `0x${string}`} isClosed />
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* How it works */}
        <div className="mt-20 grid gap-4 sm:grid-cols-3">
          {[
            {
              n: "01",
              t: "Depositás USDT",
              d: "Un solo token. El vault lo reparte entre capital invertible, reserva de reinyección y presupuesto para la API de cálculo.",
            },
            {
              n: "02",
              t: "El agente opera",
              d: "Consulta uni-lab.xyz (pagando on-chain por cada cálculo), hace el swap necesario y mintea la posición. Rebalancea si el precio sale del rango o en el intervalo que definas.",
            },
            {
              n: "03",
              t: "Solo vos retirás",
              d: "withdrawAll() siempre paga al owner. El operador no puede tocar el principal, y podés revocarlo o pausar el vault cuando quieras.",
            },
          ].map(({ n, t, d }) => (
            <div key={n} className="glass rounded-2xl p-5">
              <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-accent">
                {n}
              </span>
              <h3 className="mt-3 font-semibold" style={{ fontFamily: "var(--font-display)" }}>
                {t}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{d}</p>
            </div>
          ))}
        </div>

        <p className="mt-16 font-mono text-[11px] uppercase tracking-[0.14em] text-faint">
          Pool objetivo:{" "}
          <a
            href={`https://app.uniswap.org/explore/pools/celo/${POOL}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted underline-offset-4 hover:text-accent hover:underline"
          >
            {POOL}
          </a>
        </p>
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

function VaultCard({ vaultAddress, isClosed }: { vaultAddress: `0x${string}`; isClosed?: boolean }) {
  const { data } = useReadContracts({
    contracts: cardReads(vaultAddress),
    query: { refetchInterval: 15_000 },
  });
  const [paused, positionTokenId, rebalanceCount, maxRebalances, investableUsdt, reserveBalance, usdtBudget] =
    data?.map((d) => d.result) ?? [];
  const { data: feesSummary } = useVaultFeesSummary(vaultAddress);

  const hasPosition = Boolean(positionTokenId && (positionTokenId as bigint) > 0n);
  const totalCapital =
    ((investableUsdt as bigint) ?? 0n) + ((reserveBalance as bigint) ?? 0n) + ((usdtBudget as bigint) ?? 0n);

  return (
    <Link
      href={`/vault/${vaultAddress}`}
      className={`glass glass-hover group block rounded-2xl p-5 ${isClosed ? "opacity-60" : ""}`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="eyebrow !px-3 !py-1">Vault</span>
          {isClosed ? (
            <span className="eyebrow !px-3 !py-1">Cerrado</span>
          ) : paused ? (
            <span className="eyebrow !border-negative/40 !px-3 !py-1 !text-negative">Pausado</span>
          ) : (
            <span className="eyebrow !border-positive/40 !px-3 !py-1 !text-positive">Activo</span>
          )}
          {!isClosed && !hasPosition && <span className="eyebrow !px-3 !py-1">Sin posición</span>}
        </div>
        <span className="text-xs text-faint transition-colors group-hover:text-accent">
          Ver detalle →
        </span>
      </div>
      <p className="mt-4 break-all font-mono text-sm text-white/90">{vaultAddress}</p>
      <p className="mt-2 font-mono text-[11px] uppercase tracking-[0.14em] text-faint">
        USDT / WETH · 0.3%
      </p>
      <div className="mt-4 grid grid-cols-3 gap-4 border-t border-hairline pt-4">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
            Capital
          </p>
          <p className="mt-1 text-sm font-medium text-white/90">
            {formatUnits(totalCapital, 6)} USDT
          </p>
        </div>
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
            Rebalanceos
          </p>
          <p className="mt-1 text-sm font-medium text-white/90">
            {String(rebalanceCount ?? 0)} / {String(maxRebalances ?? 0)}
          </p>
        </div>
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
            Comisiones
          </p>
          <p className="mt-1 text-sm font-medium text-positive">
            {formatUnits(feesSummary?.totalUsdt ?? 0n, 6)} USDT
          </p>
        </div>
      </div>
    </Link>
  );
}
