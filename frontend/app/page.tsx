"use client";

import Link from "next/link";
import { useReadContract } from "wagmi";
import { Header } from "./components/Header";
import { uniswapV3PoolAbi } from "@/lib/contracts";
import { ethPriceFromTick } from "@/lib/priceMath";
import { useSelectedChain } from "@/lib/useSelectedChain";

export default function Home() {
  const { selectedChain: chain } = useSelectedChain();

  const { data: slot0 } = useReadContract({
    address: chain.pool,
    abi: uniswapV3PoolAbi,
    functionName: "slot0",
    chainId: chain.id,
    query: { refetchInterval: 15_000 },
  });
  const currentTick = slot0 ? Number((slot0 as readonly unknown[])[1]) : undefined;
  const ethPrice = currentTick !== undefined ? ethPriceFromTick(currentTick, chain.stableIsToken0) : undefined;

  const { data: vaultCount } = useReadContract({
    address: chain.factoryAddress || undefined,
    abi: chain.factoryAbi,
    functionName: "vaultCount",
    chainId: chain.id,
    query: { enabled: Boolean(chain.factoryAddress), refetchInterval: 30_000 },
  });

  return (
    <>
      <Header />
      <main className="section flex-1 pb-24 pt-32">
        {/* Hero */}
        <div className="grid items-center gap-10 lg:grid-cols-[1fr_320px]">
          <div className="max-w-3xl">
            <div className="flex flex-wrap items-center gap-3">
              <span className="eyebrow">Uniswap V3 · {chain.name} Mainnet</span>
              <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-faint">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-positive opacity-60" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-positive" />
                </span>
                En producción, con fondos reales
              </span>
            </div>
            <h1
              className="mt-6 text-balance text-5xl font-semibold leading-[1.02] tracking-tight sm:text-6xl"
              style={{ fontFamily: "var(--font-display)" }}
            >
              Auto<span className="text-accent">Range</span>
            </h1>
            <p
              className="mt-5 max-w-xl text-balance text-xl font-medium leading-snug text-white/90 sm:text-2xl"
              style={{ fontFamily: "var(--font-display)" }}
            >
              Liquidez concentrada en pools de Uniswap —el DEX más grande del mundo—, siempre en
              rango, sin ceder nunca la custodia de tus fondos.
            </p>
            <p className="mt-4 max-w-xl text-base font-medium leading-relaxed text-accent">
              Ganá dinero pasivo desde el primer minuto — sin experiencia previa, con control total
              sobre tus fondos.
            </p>
            <p className="mt-6 max-w-xl text-base leading-relaxed text-muted">
              Depositás <span className="text-white/80">{chain.stableSymbol}</span> — un solo token. Un
              agente arma y rebalancea tu posición en el pool {chain.stableSymbol}/{chain.volatileSymbol} por vos,
              corriendo el rango junto con el precio.{" "}
              <span className="text-white/80">Solo vos podés retirar los fondos</span>: el
              operador únicamente rebalancea, dentro de los límites que vos configurás.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/create" className="btn-primary !px-6 !py-3">
                Crear vault
              </Link>
              <Link href="/vaults" className="btn-secondary !px-6 !py-3">
                Ver mis vaults
              </Link>
            </div>

            {/* Live snapshot */}
            <div className="mt-10 flex flex-wrap gap-x-10 gap-y-4 rounded-2xl border border-hairline bg-white/[0.02] px-6 py-4">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-faint">Precio ETH</p>
                <p className="mt-1 font-mono text-lg text-white/90 tabular-nums">
                  {ethPrice !== undefined ? `$${ethPrice.toFixed(2)}` : "…"}
                </p>
              </div>
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-faint">Vaults creados</p>
                <p className="mt-1 font-mono text-lg text-white/90 tabular-nums">
                  {vaultCount !== undefined ? String(vaultCount) : "…"}
                </p>
              </div>
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-faint">Pool</p>
                <p className="mt-1 font-mono text-lg text-white/90">
                  {chain.stableSymbol}/{chain.volatileSymbol} · {chain.feeTier / 10_000}%
                </p>
              </div>
            </div>
          </div>

          {/* Range visual — the actual product idea, at a glance */}
          <div className="glass hidden rounded-2xl p-6 lg:block">
            <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-faint">
              Rango ilustrativo · ±5%
            </span>
            <p
              className="mt-2 text-2xl font-semibold tabular-nums text-white/90"
              style={{ fontFamily: "var(--font-display)" }}
            >
              {ethPrice !== undefined ? `$${ethPrice.toFixed(2)}` : "…"}
            </p>
            <p className="mt-0.5 text-xs text-muted">
              Precio actual · {chain.stableSymbol}/{chain.volatileSymbol}
            </p>

            <div className="relative mt-6 h-1.5 rounded-full bg-white/10">
              <div className="absolute inset-y-0 left-[10%] right-[10%] rounded-full bg-accent/25" />
              <span className="absolute left-1/2 top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent shadow-[0_0_12px_rgba(252,255,82,0.55)]" />
            </div>
            <div className="mt-2.5 flex items-center justify-between font-mono text-[11px] text-faint">
              <span>{ethPrice !== undefined ? `$${(ethPrice * 0.95).toFixed(0)}` : "…"}</span>
              <span className="text-accent">en rango</span>
              <span>{ethPrice !== undefined ? `$${(ethPrice * 1.05).toFixed(0)}` : "…"}</span>
            </div>

            <p className="mt-6 text-xs leading-relaxed text-muted">
              Cuando el precio se acerca a un borde, el agente cierra la posición y
              rearma el rango centrado en el nuevo precio — sin que vos tengas que
              hacer nada.
            </p>
          </div>
        </div>

        {/* How it works */}
        <div className="mt-20 flex flex-col gap-3 lg:flex-row lg:items-stretch lg:gap-0">
          {[
            {
              n: "01",
              t: `Depositás ${chain.stableSymbol}`,
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
          ].map(({ n, t, d }, i, arr) => (
            <div key={n} className="flex flex-1 items-stretch">
              <div className="glass flex-1 rounded-2xl p-5">
                <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-accent">
                  {n}
                </span>
                <h3 className="mt-3 text-lg font-semibold" style={{ fontFamily: "var(--font-display)" }}>
                  {t}
                </h3>
                <p className="mt-2 text-base leading-relaxed text-muted">{d}</p>
              </div>
              {i < arr.length - 1 && (
                <div className="hidden w-10 shrink-0 items-center justify-center text-faint lg:flex">
                  →
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Cómo decide el agente */}
        <div className="mt-20 rounded-3xl border border-hairline bg-white/[0.015] p-6 sm:p-8">
          <span className="eyebrow">El agente</span>
          <h2
            className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Cómo decide cuándo rebalancear
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
            Cada ~5 minutos, para cada vault, el agente corre la misma secuencia — sin
            discreción humana de por medio, todo verificable on-chain.
          </p>

          <ol className="mt-8 flex flex-col gap-3 lg:flex-row lg:items-stretch lg:gap-0">
            {[
              {
                n: "1",
                t: "¿Quedan rebalanceos?",
                d: "rebalanceCount < maxRebalances, el tope que vos fijaste al crear el vault. Si se agotó, no hace nada.",
              },
              {
                n: "2",
                t: "¿Pasó el cooldown?",
                d: "El piso mínimo de tiempo desde el último rebalanceo. Evita thrashing aunque el precio se mueva rápido.",
              },
              {
                n: "3",
                t: "¿Toca el periódico?",
                d: "Si configuraste un intervalo, rebalancea igual aunque el precio siga en rango — actividad real, no solo reactiva.",
              },
              {
                n: "4",
                t: "¿Rompió el rango?",
                d: "Compara el precio actual contra los límites de la posición abierta. Fuera por abajo o por arriba, cada caso arma un rango nuevo distinto.",
              },
            ].map(({ n, t, d }, i, arr) => (
              <li key={n} className="flex flex-1 items-stretch">
                <div className="glass flex-1 rounded-2xl p-5" style={{ backgroundColor: "#0a0a0a" }}>
                  <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-accent">
                    Paso {n}
                  </span>
                  <h3 className="mt-3 text-base font-semibold text-white/90">{t}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted">{d}</p>
                </div>
                {i < arr.length - 1 && (
                  <div className="hidden w-8 shrink-0 items-center justify-center text-faint lg:flex">
                    →
                  </div>
                )}
              </li>
            ))}
          </ol>

          <Link
            href="/recursos"
            className="mt-6 inline-flex items-center gap-1.5 text-sm text-accent underline-offset-4 hover:underline"
          >
            Ver la guía completa con ejemplos numéricos →
          </Link>
        </div>

        {/* El pool */}
        <div className="mt-20">
          <span className="eyebrow">El pool</span>
          <h2
            className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl"
            style={{ fontFamily: "var(--font-display)" }}
          >
            {chain.stableSymbol}/{chain.volatileSymbol}, {chain.feeTier / 10_000}%, con liquidez real
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
            No es un pool de prueba armado para la demo — cada vault mintea su posición en
            el mismo pool público de Uniswap V3 que ya opera en {chain.name} mainnet, compartiendo
            liquidez con cualquier otro LP.
          </p>

          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <div className="glass rounded-2xl p-5">
              <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">Pool</p>
              <a
                href={`${chain.explorerBaseUrl}/address/${chain.pool}`}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1.5 block break-all font-mono text-xs text-white/80 underline-offset-4 hover:text-accent hover:underline"
              >
                {chain.pool} ↗
              </a>
              <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
                Fee tier
              </p>
              <p className="mt-1 text-sm text-white/80">{chain.feeTier / 10_000}%</p>
            </div>
            <div className="glass rounded-2xl p-5">
              <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
                token0 · {chain.stableSymbol}
              </p>
              <a
                href={`${chain.explorerBaseUrl}/address/${chain.stableToken}`}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1.5 block break-all font-mono text-xs text-white/80 underline-offset-4 hover:text-accent hover:underline"
              >
                {chain.stableToken} ↗
              </a>
              <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
                token1 · {chain.volatileSymbol} puenteado
              </p>
              <a
                href={`${chain.explorerBaseUrl}/address/${chain.volatileToken}`}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1.5 block break-all font-mono text-xs text-white/80 underline-offset-4 hover:text-accent hover:underline"
              >
                {chain.volatileToken} ↗
              </a>
            </div>
          </div>

          <p className="mt-4 font-mono text-[11px] text-faint">
            El agente opera vía el{" "}
            <a
              href={`${chain.explorerBaseUrl}/address/${chain.positionManager}`}
              target="_blank"
              rel="noopener noreferrer"
              className="underline-offset-4 hover:text-accent hover:underline"
            >
              NonfungiblePositionManager
            </a>{" "}
            y el{" "}
            <a
              href={`${chain.explorerBaseUrl}/address/${chain.swapRouter02}`}
              target="_blank"
              rel="noopener noreferrer"
              className="underline-offset-4 hover:text-accent hover:underline"
            >
              SwapRouter02
            </a>{" "}
            oficiales de Uniswap en {chain.name} — contratos verificados, no wrappers propios.
          </p>
        </div>

        {/* Un contrato por usuario */}
        <div className="mt-20">
          <span className="eyebrow">Arquitectura</span>
          <h2
            className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Un contrato nuevo por usuario — nunca un fondo compartido
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
            Cuando creás un vault, se despliega un contrato exclusivo para vos — no es una fila en una
            base de datos ni una porción de un pool común. Tu dinero, tu posición y tu historial viven
            ahí, y en ningún otro lugar.
          </p>
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <div className="glass rounded-2xl p-5">
              <h3 className="text-sm font-semibold text-muted">Cómo operan muchos gestores DeFi</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                Un solo contrato reúne el dinero de todos los usuarios en el mismo lugar. Un bug o
                exploit ahí compromete a{" "}
                <span className="text-white/80">todos los depositantes al mismo tiempo.</span>
              </p>
            </div>
            <div className="glass rounded-2xl p-5" style={{ borderColor: "rgba(252,255,82,0.25)" }}>
              <h3 className="text-sm font-semibold text-accent">Cómo opera AutoRange</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                Cada usuario tiene su propio contrato, aislado del resto. Un problema en un vault{" "}
                <span className="text-white/80">queda contenido a ese vault</span> — nunca se propaga
                al dinero de otro usuario.
              </p>
            </div>
          </div>
        </div>

        {/* Garantías no-custodiales */}
        <div className="mt-20 rounded-3xl border border-hairline bg-white/[0.015] p-6 sm:p-8">
          <span className="eyebrow">Sin custodia</span>
          <h2
            className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl"
            style={{ fontFamily: "var(--font-display)" }}
          >
            El operador rebalancea. Vos sos dueño.
          </h2>

          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            {[
              {
                t: "El principal solo vuelve a vos",
                d: "withdrawAll()/withdraw() transfieren siempre al owner del vault — nunca hay un parámetro que redirija a otra dirección.",
              },
              {
                t: "El operador no puede inventar rangos",
                d: "Cada rango que propone se valida on-chain contra los límites que vos configuraste al crear o reconfigurar el vault.",
              },
              {
                t: "Podés pausar o revocar cuando quieras",
                d: "pause() bloquea al agente sin tocar tus fondos. setOperator(0x0) es un kill switch inmediato — nadie puede rebalancear después.",
              },
              {
                t: "Retiro de emergencia sin depender de nadie",
                d: "emergencyWithdrawPosition() fuerza el cierre de la posición y te devuelve todo, incluso si el operador dejó de responder.",
              },
            ].map(({ t, d }) => (
              <div key={t} className="glass rounded-2xl p-5" style={{ backgroundColor: "#0a0a0a" }}>
                <h3 className="text-base font-semibold text-white/90">{t}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">{d}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Modelo de ingresos, con ejemplo numérico */}
        <div className="mt-20">
          <span className="eyebrow">Modelo de ingresos</span>
          <h2
            className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Comisión solo sobre lo que ganás — nunca sobre tu capital
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
            Un ejemplo real: si tu posición genera $1,000 en comisiones de trading sobre $10,000
            depositados (10% de rentabilidad bruta), la plataforma cobra un{" "}
            <span className="text-white/80">10% performance fee</span> solo sobre esa ganancia — nunca
            sobre el capital. Mismo pool, mismas comisiones ganadas: lo único que cambia es el reparto.
          </p>

          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <div className="glass rounded-2xl p-5">
              <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
                Sin AutoRange · gestión manual experta
              </p>
              <div className="mt-3 flex h-8 overflow-hidden rounded-md bg-white/[0.03]">
                <div
                  className="flex w-full items-center justify-end rounded-md pr-3"
                  style={{ backgroundColor: "#b08f14" }}
                >
                  <span className="font-mono text-xs font-semibold text-[#0a0a0a]">$1,000 · 10%</span>
                </div>
              </div>
            </div>
            <div className="glass rounded-2xl p-5">
              <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
                Con AutoRange · automático, sin experiencia
              </p>
              <div className="mt-3 flex h-8 gap-0.5 overflow-hidden rounded-md bg-white/[0.03]">
                <div
                  className="flex items-center justify-end rounded-l-md pr-3"
                  style={{ backgroundColor: "#b08f14", flexGrow: 900 }}
                >
                  <span className="font-mono text-xs font-semibold text-[#0a0a0a]">$900 · 9%</span>
                </div>
                <div
                  className="flex items-center justify-center rounded-r-md"
                  style={{ backgroundColor: "#8b7cf6", flexGrow: 100 }}
                />
              </div>
              <p className="mt-2 text-[11px] text-faint">
                Tramo violeta = $100 · 1% para AutoRange (10% de lo ganado, nunca del capital)
              </p>
            </div>
          </div>

          <p className="mt-4 max-w-2xl text-xs leading-relaxed text-faint">
            Además, cada vault nuevo paga un cargo único de creación (1 USD, una sola vez) que cubre el
            costo de desplegar un contrato propio e independiente para ese usuario. Ambos valores son
            ajustables con el tiempo por decisión de la gobernanza de la plataforma — nunca fijos para
            siempre.
          </p>
        </div>

        {/* Closing CTA */}
        <div className="mt-20 flex flex-wrap items-center gap-4 border-t border-hairline pt-10">
          <Link href="/create" className="btn-primary !px-6 !py-3">
            Crear vault
          </Link>
          <Link href="/recursos" className="btn-secondary !px-6 !py-3">
            Cómo decide el agente
          </Link>
          <Link href="/recursos/inversionistas" className="btn-secondary !px-6 !py-3">
            Presentación para inversionistas
          </Link>
        </div>
      </main>
    </>
  );
}
