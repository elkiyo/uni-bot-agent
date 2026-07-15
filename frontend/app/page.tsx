"use client";

import Link from "next/link";
import { Header } from "./components/Header";
import { POOL } from "@/lib/addresses";

export default function Home() {
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
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/create" className="btn-primary !px-6 !py-3">
              Crear vault
            </Link>
            <Link href="/vaults" className="btn-secondary !px-6 !py-3">
              Ver mis vaults
            </Link>
          </div>
        </div>

        {/* How it works */}
        <div className="mt-20 grid gap-4 sm:grid-cols-3">
          {[
            {
              n: "01",
              t: "Depositás USDT",
              d: "Un solo token. El vault lo reparte entre capital invertible y reserva de reinyección.",
            },
            {
              n: "02",
              t: "El agente opera",
              d: "Consulta uni-lab.xyz (pagando vía x402 con su propia wallet), hace el swap necesario y mintea la posición. Rebalancea si el precio sale del rango o en el intervalo que definas.",
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
