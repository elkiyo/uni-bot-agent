"use client";

import Link from "next/link";
import { useAccount, useReadContract } from "wagmi";
import { Header } from "./components/Header";
import { vaultFactoryAbi } from "@/lib/contracts";
import { FACTORY_ADDRESS, POOL } from "@/lib/addresses";

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

            {vaultList.length > 0 && (
              <ul className="grid gap-4 sm:grid-cols-2">
                {vaultList.map((vaultAddress) => (
                  <li key={vaultAddress}>
                    <Link
                      href={`/vault/${vaultAddress}`}
                      className="glass glass-hover group block rounded-2xl p-5"
                    >
                      <div className="flex items-center justify-between">
                        <span className="eyebrow !px-3 !py-1">Vault</span>
                        <span className="text-xs text-faint transition-colors group-hover:text-accent">
                          Ver detalle →
                        </span>
                      </div>
                      <p className="mt-4 break-all font-mono text-sm text-white/90">
                        {vaultAddress}
                      </p>
                      <p className="mt-2 font-mono text-[11px] uppercase tracking-[0.14em] text-faint">
                        USDT / WETH · 0.3%
                      </p>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

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
