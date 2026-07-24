"use client";

import Link from "next/link";
import { useReadContract } from "wagmi";
import { Header } from "./components/Header";
import { uniswapV3PoolAbi } from "@/lib/contracts";
import { ethPriceFromTick } from "@/lib/priceMath";
import { useSelectedChain } from "@/lib/useSelectedChain";
import { useTranslation } from "@/lib/i18n/useTranslation";

export default function Home() {
  const { selectedChain: chain } = useSelectedChain();
  const { t } = useTranslation();
  const pair = `${chain.stableSymbol}/${chain.volatileSymbol}`;

  const { data: slot0 } = useReadContract({
    address: chain.pool,
    abi: uniswapV3PoolAbi,
    functionName: "slot0",
    chainId: chain.id,
    query: { refetchInterval: 60_000 },
  });
  const currentTick = slot0 ? Number((slot0 as readonly unknown[])[1]) : undefined;
  const ethPrice = currentTick !== undefined ? ethPriceFromTick(currentTick, chain.stableIsToken0) : undefined;

  const { data: vaultCount } = useReadContract({
    address: chain.factoryAddress || undefined,
    abi: chain.factoryAbi,
    functionName: "vaultCount",
    chainId: chain.id,
    query: { enabled: Boolean(chain.factoryAddress), refetchInterval: 60_000 },
  });

  return (
    <>
      <Header />
      <main className="section flex-1 pb-24 pt-32">
        {/* Hero */}
        <div className="grid items-center gap-10 lg:grid-cols-[1fr_320px]">
          <div className="max-w-3xl">
            <div className="flex flex-wrap items-center gap-3">
              <span className="eyebrow">{t("home.eyebrowMainnet", { chain: chain.name })}</span>
              <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-faint">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-positive opacity-60" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-positive" />
                </span>
                {t("home.liveBadge")}
              </span>
            </div>
            <h1
              className="mt-6 text-balance text-5xl font-semibold leading-[1.02] tracking-tight sm:text-6xl"
              style={{ fontFamily: "var(--font-display)" }}
            >
              Auto<span className="text-accent">Range</span>
            </h1>
            <p className="mt-2 font-mono text-xs uppercase tracking-[0.22em] text-accent">
              AI Agent
            </p>
            <p
              className="mt-5 max-w-xl text-balance text-xl font-medium leading-snug text-white/90 sm:text-2xl"
              style={{ fontFamily: "var(--font-display)" }}
            >
              {t("home.heroSubtitle")}
            </p>
            <p className="mt-4 max-w-xl text-base font-medium leading-relaxed text-accent">
              {t("home.heroHighlight")}
            </p>
            <p className="mt-6 max-w-xl text-base leading-relaxed text-muted">
              {t("home.heroBodyPre")} <span className="text-white/80">{chain.stableSymbol}</span>
              {t("home.heroBodyMid", { pair })}
              <span className="text-white/80">{t("home.heroBodyHighlight")}</span>
              {t("home.heroBodyPost")}
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/create" className="btn-primary !px-6 !py-3">
                {t("home.ctaCreate")}
              </Link>
              <Link href="/vaults" className="btn-secondary !px-6 !py-3">
                {t("home.ctaViewVaults")}
              </Link>
            </div>

            {/* Live snapshot */}
            <div className="mt-10 flex flex-wrap gap-x-10 gap-y-4 rounded-2xl border border-hairline bg-white/[0.02] px-6 py-4">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-faint">{t("home.snapshotEthPrice")}</p>
                <p className="mt-1 font-mono text-lg text-white/90 tabular-nums">
                  {ethPrice !== undefined ? `$${ethPrice.toFixed(2)}` : "…"}
                </p>
              </div>
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-faint">{t("home.snapshotVaultsCreated")}</p>
                <p className="mt-1 font-mono text-lg text-white/90 tabular-nums">
                  {vaultCount !== undefined ? String(vaultCount) : "…"}
                </p>
              </div>
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-faint">{t("home.snapshotPool")}</p>
                <p className="mt-1 font-mono text-lg text-white/90">
                  {chain.stableSymbol}/{chain.volatileSymbol} · {chain.feeTier / 10_000}%
                </p>
              </div>
            </div>
          </div>

          {/* Logo + range visual — the actual product idea, at a glance */}
          <div className="hidden flex-col items-end gap-4 lg:flex">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/brand/logo-mark-256.png"
              alt="AutoRange"
              className="h-16 w-16 rounded-full shadow-[0_0_36px_rgba(252,255,82,0.18)]"
            />
            <div className="glass w-full rounded-2xl p-6">
              <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-faint">
                {t("home.illustrativeRange")}
              </span>
              <p
                className="mt-2 text-2xl font-semibold tabular-nums text-white/90"
                style={{ fontFamily: "var(--font-display)" }}
              >
                {ethPrice !== undefined ? `$${ethPrice.toFixed(2)}` : "…"}
              </p>
              <p className="mt-0.5 text-xs text-muted">{t("home.currentPrice", { pair })}</p>

              <div className="relative mt-6 h-1.5 rounded-full bg-white/10">
                <div className="absolute inset-y-0 left-[10%] right-[10%] rounded-full bg-accent/25" />
                <span className="absolute left-1/2 top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent shadow-[0_0_12px_rgba(252,255,82,0.55)]" />
              </div>
              <div className="mt-2.5 flex items-center justify-between font-mono text-[11px] text-faint">
                <span>{ethPrice !== undefined ? `$${(ethPrice * 0.95).toFixed(0)}` : "…"}</span>
                <span className="text-accent">{t("home.inRange")}</span>
                <span>{ethPrice !== undefined ? `$${(ethPrice * 1.05).toFixed(0)}` : "…"}</span>
              </div>

              <p className="mt-6 text-xs leading-relaxed text-muted">{t("home.illustrativeCaption")}</p>
            </div>
          </div>
        </div>

        {/* How it works */}
        <div className="mt-20 flex flex-col gap-3 lg:flex-row lg:items-stretch lg:gap-0">
          {[
            {
              n: t("home.step1N"),
              title: t("home.step1T", { symbol: chain.stableSymbol }),
              d: t("home.step1D"),
            },
            {
              n: t("home.step2N"),
              title: (
                <>
                  {t("home.step2TPre")}
                  <span className="text-accent">{t("home.step2THighlight")}</span>
                  {t("home.step2TPost")}
                </>
              ),
              d: t("home.step2D"),
            },
            {
              n: t("home.step3N"),
              title: t("home.step3T"),
              d: t("home.step3D"),
            },
          ].map(({ n, title, d }, i, arr) => (
            <div key={n} className="flex flex-1 items-stretch">
              <div className="glass flex-1 rounded-2xl p-5">
                <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-accent">
                  {n}
                </span>
                <h3 className="mt-3 text-lg font-semibold" style={{ fontFamily: "var(--font-display)" }}>
                  {title}
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
          <span className="eyebrow">
            {t("home.decisionEyebrowPre")}
            <span className="text-accent">{t("home.decisionEyebrowHighlight")}</span>
          </span>
          <h2
            className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl"
            style={{ fontFamily: "var(--font-display)" }}
          >
            {t("home.decisionTitle")}
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">{t("home.decisionSubtitle")}</p>

          <ol className="mt-8 flex flex-col gap-3 lg:flex-row lg:items-stretch lg:gap-0">
            {[
              { n: "1", title: t("home.decision1T"), d: t("home.decision1D") },
              { n: "2", title: t("home.decision2T"), d: t("home.decision2D") },
              { n: "3", title: t("home.decision3T"), d: t("home.decision3D") },
              { n: "4", title: t("home.decision4T"), d: t("home.decision4D") },
            ].map(({ n, title, d }, i, arr) => (
              <li key={n} className="flex flex-1 items-stretch">
                <div className="glass flex-1 rounded-2xl p-5" style={{ backgroundColor: "#0a0a0a" }}>
                  <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-accent">
                    {t("home.decisionStepLabel", { n })}
                  </span>
                  <h3 className="mt-3 text-base font-semibold text-white/90">{title}</h3>
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
            {t("home.decisionLink")}
          </Link>
        </div>

        {/* El pool */}
        <div className="mt-20">
          <span className="eyebrow">{t("home.poolEyebrow")}</span>
          <h2
            className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl"
            style={{ fontFamily: "var(--font-display)" }}
          >
            {t("home.poolTitle", { pair, fee: chain.feeTier / 10_000 })}
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
            {t("home.poolSubtitle", { chain: chain.name })}
          </p>

          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <div className="glass rounded-2xl p-5">
              <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">{t("home.poolLabel")}</p>
              <a
                href={`${chain.explorerBaseUrl}/address/${chain.pool}`}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1.5 block break-all font-mono text-xs text-white/80 underline-offset-4 hover:text-accent hover:underline"
              >
                {chain.pool} ↗
              </a>
              <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
                {t("home.feeTierLabel")}
              </p>
              <p className="mt-1 text-sm text-white/80">{chain.feeTier / 10_000}%</p>
            </div>
            <div className="glass rounded-2xl p-5">
              <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
                {t("home.token0Label", { symbol: chain.stableSymbol })}
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
                {t("home.token1Label", { symbol: chain.volatileSymbol })}
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
            {t("home.poolFooterPre")}
            <a
              href={`${chain.explorerBaseUrl}/address/${chain.positionManager}`}
              target="_blank"
              rel="noopener noreferrer"
              className="underline-offset-4 hover:text-accent hover:underline"
            >
              NonfungiblePositionManager
            </a>
            {t("home.poolFooterMid")}
            <a
              href={`${chain.explorerBaseUrl}/address/${chain.swapRouter02}`}
              target="_blank"
              rel="noopener noreferrer"
              className="underline-offset-4 hover:text-accent hover:underline"
            >
              SwapRouter02
            </a>
            {t("home.poolFooterPost", { chain: chain.name })}
          </p>
        </div>

        {/* Un contrato por usuario */}
        <div className="mt-20">
          <span className="eyebrow">{t("home.archEyebrow")}</span>
          <h2
            className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl"
            style={{ fontFamily: "var(--font-display)" }}
          >
            {t("home.archTitle")}
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">{t("home.archSubtitle")}</p>
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <div className="glass rounded-2xl p-5">
              <h3 className="text-sm font-semibold text-muted">{t("home.archOthersTitle")}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                {t("home.archOthersDPre")}
                <span className="text-white/80">{t("home.archOthersDHighlight")}</span>
              </p>
            </div>
            <div className="glass rounded-2xl p-5" style={{ borderColor: "rgba(252,255,82,0.25)" }}>
              <h3 className="text-sm font-semibold text-accent">{t("home.archUsTitle")}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                {t("home.archUsDPre")}
                <span className="text-white/80">{t("home.archUsDHighlight")}</span>
                {t("home.archUsDPost")}
              </p>
            </div>
          </div>
        </div>

        {/* Garantías no-custodiales */}
        <div className="mt-20 rounded-3xl border border-hairline bg-white/[0.015] p-6 sm:p-8">
          <span className="eyebrow">{t("home.custodyEyebrow")}</span>
          <h2
            className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl"
            style={{ fontFamily: "var(--font-display)" }}
          >
            {t("home.custodyTitle")}
          </h2>

          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            {[
              { title: t("home.custody1T"), d: t("home.custody1D") },
              { title: t("home.custody2T"), d: t("home.custody2D") },
              { title: t("home.custody3T"), d: t("home.custody3D") },
              { title: t("home.custody4T"), d: t("home.custody4D") },
            ].map(({ title, d }) => (
              <div key={title} className="glass rounded-2xl p-5" style={{ backgroundColor: "#0a0a0a" }}>
                <h3 className="text-base font-semibold text-white/90">{title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">{d}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Modelo de ingresos, con ejemplo numérico */}
        <div className="mt-20">
          <span className="eyebrow">{t("home.revenueEyebrow")}</span>
          <h2
            className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl"
            style={{ fontFamily: "var(--font-display)" }}
          >
            {t("home.revenueTitle")}
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
            {t("home.revenueSubtitlePre")}
            <span className="text-white/80">{t("home.revenueSubtitleHighlight")}</span>
            {t("home.revenueSubtitlePost")}
          </p>

          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <div className="glass rounded-2xl p-5">
              <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
                {t("home.revenueWithoutLabel")}
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
                {t("home.revenueWithLabel")}
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
              <p className="mt-2 text-[11px] text-faint">{t("home.revenueBarCaption")}</p>
            </div>
          </div>

          <p className="mt-4 max-w-2xl text-xs leading-relaxed text-faint">{t("home.revenueFooter")}</p>
        </div>

        {/* Closing CTA */}
        <div className="mt-20 flex flex-wrap items-center gap-4 border-t border-hairline pt-10">
          <Link href="/create" className="btn-primary !px-6 !py-3">
            {t("home.ctaCreate")}
          </Link>
          <Link href="/recursos" className="btn-secondary !px-6 !py-3">
            {t("home.closingGuide")}
          </Link>
          <Link href="/recursos/inversionistas" className="btn-secondary !px-6 !py-3">
            {t("home.closingInvestors")}
          </Link>
        </div>
      </main>
    </>
  );
}
