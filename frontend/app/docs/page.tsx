"use client";

import Link from "next/link";
import { Header } from "../components/Header";
import {
  USDT,
  WETH,
  POOL,
  FEE_TIER,
  POSITION_MANAGER,
  SWAP_ROUTER02,
  UNILAB_PAYMENT_WALLET,
} from "@/lib/addresses";
import { useTranslation } from "@/lib/i18n/useTranslation";

export default function Docs() {
  const { t } = useTranslation();

  const toc = [
    { id: "que-es", label: t("docs.tocQueEs") },
    { id: "roles", label: t("docs.tocRoles") },
    { id: "ciclo-de-vida", label: t("docs.tocCicloDeVida") },
    { id: "contratos", label: t("docs.tocContratos") },
    { id: "decision", label: t("docs.tocDecision") },
    { id: "pagos", label: t("docs.tocPagos") },
    { id: "seguridad", label: t("docs.tocSeguridad") },
    { id: "direcciones", label: t("docs.tocDirecciones") },
    { id: "glosario", label: t("docs.tocGlosario") },
  ];

  return (
    <>
      <Header />
      <main className="section flex-1 pb-24 pt-32">
        <span className="eyebrow">{t("docs.eyebrow")}</span>
        <h1
          className="mt-5 max-w-2xl text-3xl font-semibold leading-[1.12] tracking-tight sm:text-4xl"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {t("docs.title")}
        </h1>
        <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-muted">
          {t("docs.subtitlePre")}
          <Link href="/recursos" className="text-accent underline-offset-4 hover:underline">
            {t("docs.subtitleLink")}
          </Link>
          .
        </p>

        <div className="mt-12 grid gap-10 lg:grid-cols-[200px_1fr]">
          {/* TOC */}
          <nav className="hidden lg:block">
            <div className="sticky top-32 flex flex-col gap-1 border-l border-hairline pl-4">
              {toc.map((item) => (
                <a
                  key={item.id}
                  href={`#${item.id}`}
                  className="py-1 text-xs text-muted transition-colors hover:text-accent"
                >
                  {item.label}
                </a>
              ))}
            </div>
          </nav>

          <div className="flex flex-col gap-20 overflow-hidden">
            {/* Qué es */}
            <Section id="que-es" eyebrow="01" title={t("docs.s01Title")}>
              <p>
                {t("docs.s01P1Pre")}
                <strong className="text-white/85">USDT</strong>
                {t("docs.s01P1Mid")}
                <em>keeper</em>
                {t("docs.s01P1Post")}
              </p>
              <p>
                {t("docs.s01P2Pre")}
                <strong className="text-white/85">{t("docs.s01P2Strong")}</strong>
                {t("docs.s01P2Mid")}
                <code>owner</code>
                {t("docs.s01P2Post")}
              </p>
              <p>
                {t("docs.s01P3Pre")}
                <em>{t("docs.s01P3Em")}</em>
                {t("docs.s01P3Post")}
              </p>
            </Section>

            {/* Los 3 roles */}
            <Section id="roles" eyebrow="02" title={t("docs.s02Title")}>
              <p>{t("docs.s02Intro")}</p>

              <div className="mt-6 grid gap-4 sm:grid-cols-3">
                <RoleCard
                  title={t("docs.rolePlatformTitle")}
                  subtitle={t("docs.rolePlatformSubtitle")}
                  points={[t("docs.rolePlatformPoint1"), t("docs.rolePlatformPoint2"), t("docs.rolePlatformPoint3")]}
                />
                <RoleCard
                  title={t("docs.roleOwnerTitle")}
                  subtitle={t("docs.roleOwnerSubtitle")}
                  points={[
                    t("docs.roleOwnerPoint1"),
                    t("docs.roleOwnerPoint2"),
                    t("docs.roleOwnerPoint3"),
                    t("docs.roleOwnerPoint4"),
                  ]}
                  accent
                />
                <RoleCard
                  title={t("docs.roleOperatorTitle")}
                  subtitle={
                    <>
                      {t("docs.roleOperatorSubtitlePre")}
                      <span className="text-accent">{t("docs.roleOperatorSubtitleHighlight")}</span>
                    </>
                  }
                  points={[t("docs.roleOperatorPoint1"), t("docs.roleOperatorPoint2"), t("docs.roleOperatorPoint3")]}
                />
              </div>

              <div className="mt-6 rounded-2xl border border-hairline bg-white/[0.02] p-5">
                <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-faint">
                  {t("docs.trustBoxTitle")}
                </p>
                <ul className="mt-3 flex flex-col gap-2 text-sm text-muted">
                  <li>
                    <code>withdraw()</code>
                    {t("docs.trustPoint1Mid")}
                    <code>withdrawAll()</code>
                    {t("docs.trustPoint1Post")}
                    <code>owner</code>
                    {t("docs.trustPoint1End")}
                  </li>
                  <li>
                    <code>initPosition()</code>
                    {t("docs.trustPoint2Mid")}
                    <code>rebalance()</code>
                    {t("docs.trustPoint2Post")}
                    <code>recipient</code>
                    {t("docs.trustPoint2End")}
                  </li>
                  <li>
                    {t("docs.trustPoint3Pre")}
                    <code>maxRangeDeviationBps</code>
                    {t("docs.trustPoint3Post")}
                  </li>
                  <li>
                    {t("docs.trustPoint4Pre")}
                    <code>setOperator(0x0)</code>
                    {t("docs.trustPoint4Mid")}
                    <code>emergencyWithdrawPosition()</code>
                    {t("docs.trustPoint4Post")}
                  </li>
                </ul>
              </div>
            </Section>

            {/* Ciclo de vida */}
            <Section id="ciclo-de-vida" eyebrow="03" title={t("docs.s03Title")}>
              <p>{t("docs.s03Intro")}</p>

              <FlowDiagram
                steps={[
                  { who: t("docs.flow1Who"), what: t("docs.flow1What"), detail: t("docs.flow1Detail") },
                  { who: t("docs.flow2Who"), what: t("docs.flow2What"), detail: t("docs.flow2Detail") },
                  { who: t("docs.flow3Who"), what: t("docs.flow3What"), detail: t("docs.flow3Detail") },
                  { who: t("docs.flow4Who"), what: t("docs.flow4What"), detail: t("docs.flow4Detail") },
                ]}
              />

              <div className="my-6 rounded-2xl border border-accent/30 bg-accent/[0.04] p-5">
                <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-accent">
                  {t("docs.cycleBoxTitle")}
                </p>
                <p className="mt-2 text-sm text-muted">
                  {t("docs.cycleBoxTextPre")}
                  <a href="#decision" className="text-accent underline-offset-4 hover:underline">
                    {t("docs.cycleBoxLink")}
                  </a>
                  {t("docs.cycleBoxTextPost")}
                </p>
              </div>

              <FlowDiagram
                steps={[
                  { who: t("docs.flow5Who"), what: t("docs.flow5What"), detail: t("docs.flow5Detail") },
                  { who: t("docs.flow6Who"), what: t("docs.flow6What"), detail: t("docs.flow6Detail") },
                ]}
              />
            </Section>

            {/* Contratos */}
            <Section id="contratos" eyebrow="04" title={t("docs.s04Title")}>
              <p>{t("docs.s04Intro")}</p>

              <ArchitectureDiagram t={t} />

              <ContractBlock
                name="PlatformConfig.sol"
                desc={t("docs.platformConfigDesc")}
                rows={[
                  ["performanceFeeBps", t("docs.platformConfigRow1Desc")],
                  ["feeToken", t("docs.platformConfigRow2Desc")],
                  ["defaultOperator", t("docs.platformConfigRow3Desc")],
                  ["maxDepositUsd", t("docs.platformConfigRow4Desc")],
                ]}
              />

              <ContractBlock
                name="VaultFactory.sol"
                desc={t("docs.vaultFactoryDesc")}
                rows={[
                  ["createVault(pool, token0, token1, fee)", t("docs.vaultFactoryRow1Desc")],
                  ["getVaultsByOwner(address)", t("docs.vaultFactoryRow2Desc")],
                  ["allVaults(i) / vaultCount()", t("docs.vaultFactoryRow3Desc")],
                ]}
              />

              <ContractBlock name="RangeVault.sol" desc={t("docs.rangeVaultDesc")}>
                <p className="mt-4 text-sm font-medium text-white/80">{t("docs.fundFlowTitle")}</p>
                <p className="mt-1 text-sm text-muted">{t("docs.fundFlowDesc")}</p>
                <FundFlowDiagram t={t} />

                <p className="mt-6 text-sm font-medium text-white/80">{t("docs.ledgersTitle")}</p>
                <p className="mt-1 text-sm text-muted">
                  {t("docs.ledgersTextPre")}
                  <code>investableUsdt</code>
                  {t("docs.ledgersTextMid")}
                  <code>reserveBalance</code>
                  {t("docs.ledgersTextPost")}
                </p>

                <p className="mt-5 text-sm font-medium text-white/80">{t("docs.ownerFunctionsTitle")}</p>
                <FunctionTable
                  rows={[
                    ["deposit(reserve, investable)", t("docs.ownerFn1Desc")],
                    ["configureTarget(...)", t("docs.ownerFn2Desc")],
                    ["setRiskParams(...)", t("docs.ownerFn3Desc")],
                    ["increasePosition(swapIx, usdtAmount, ...)", t("docs.ownerFn4Desc")],
                    ["withdraw(positionShareBps, fundsShareBps)", t("docs.ownerFn5Desc")],
                    ["withdrawAll()", t("docs.ownerFn6Desc")],
                    ["setOperator(address)", t("docs.ownerFn7Desc")],
                    ["pause() / unpause()", t("docs.ownerFn8Desc")],
                    ["emergencyWithdrawPosition()", t("docs.ownerFn9Desc")],
                    ["closeVault()", t("docs.ownerFn10Desc")],
                  ]}
                />

                <p className="mt-5 text-sm font-medium text-white/80">
                  {t("docs.operatorFunctionsTitlePre")}
                  <span className="text-accent">{t("docs.operatorFunctionsTitleHighlight")}</span>
                  {t("docs.operatorFunctionsTitlePost")}
                </p>
                <FunctionTable
                  rows={[
                    ["initPosition(swapIx, ...)", t("docs.operatorFn1Desc")],
                    ["rebalance(newTickLower, newTickUpper, swapIx, ...)", t("docs.operatorFn2Desc")],
                    ["reinjectIntoPosition(swapIx, amount, ...)", t("docs.operatorFn3Desc")],
                    ["sweepIdleDust(swapIx, ...)", t("docs.operatorFn4Desc")],
                  ]}
                />

                <p className="mt-5 text-sm font-medium text-white/80">{t("docs.eventsTitle")}</p>
                <p className="mt-1 text-sm leading-relaxed text-muted">
                  <code>PositionInitialized</code>, <code>Rebalanced</code>,{" "}
                  <code>LpFeesPaidToOwner</code>, <code>Withdrawn</code>,{" "}
                  <code>PositionIncreased</code>, <code>ReinjectedIntoPosition</code>,{" "}
                  <code>IdleDustSwept</code>
                  {t("docs.eventsTextPre")}
                  <Link href="/vaults" className="text-accent underline-offset-4 hover:underline">
                    {t("docs.eventsTextLink")}
                  </Link>
                  {t("docs.eventsTextPost")}
                </p>
              </ContractBlock>
            </Section>

            {/* Cómo decide el agente */}
            <Section
              id="decision"
              eyebrow="05"
              title={
                <>
                  {t("docs.s05TitlePre")}
                  <span className="text-accent">{t("docs.s05TitleHighlight")}</span>
                </>
              }
            >
              <p>{t("docs.s05Intro")}</p>
              <ol className="mt-4 flex flex-col gap-2 text-sm text-muted">
                <li>
                  <strong className="text-white/80">1.</strong> {t("docs.d1Pre")}
                  <code>rebalanceCount &lt; maxRebalances</code>
                </li>
                <li>
                  <strong className="text-white/80">2.</strong> {t("docs.d2")}
                </li>
                <li>
                  <strong className="text-white/80">3.</strong> {t("docs.d3")}
                </li>
                <li>
                  <strong className="text-white/80">4.</strong> {t("docs.d4")}
                </li>
              </ol>
              <p className="mt-4">
                {t("docs.s05OutroPre")}
                <Link href="/recursos" className="text-accent underline-offset-4 hover:underline">
                  {t("docs.s05OutroLink")}
                </Link>
                .
              </p>
            </Section>

            {/* Pagos */}
            <Section id="pagos" eyebrow="06" title={t("docs.s06Title")}>
              <p>
                {t("docs.s06P1Pre")}
                <a
                  href="https://uni-lab-xyz.vercel.app/api-docs"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent underline-offset-4 hover:underline"
                >
                  uni-lab.xyz
                </a>
                {t("docs.s06P1Mid")}
                <strong className="text-white/85">{t("docs.s06P1Strong")}</strong>
                {t("docs.s06P1Post")}
                <code>api.x402.celo.org</code>
                {t("docs.s06P1End")}
              </p>
              <p>
                {t("docs.s06P2Pre")}
                <strong className="text-white/85">{t("docs.s06P2Strong")}</strong>
                {t("docs.s06P2Mid")}
                <strong className="text-white/85">{t("docs.s06P2Strong2")}</strong>
                {t("docs.s06P2Post")}
              </p>

              <FlowDiagram
                steps={[
                  { who: t("docs.payFlow1Who"), what: t("docs.payFlow1What"), detail: t("docs.payFlow1Detail") },
                  { who: t("docs.payFlow2Who"), what: t("docs.payFlow2What"), detail: t("docs.payFlow2Detail") },
                  { who: t("docs.payFlow3Who"), what: t("docs.payFlow3What"), detail: t("docs.payFlow3Detail") },
                  { who: t("docs.payFlow4Who"), what: t("docs.payFlow4What"), detail: t("docs.payFlow4Detail") },
                ]}
              />
            </Section>

            {/* Seguridad */}
            <Section id="seguridad" eyebrow="07" title={t("docs.s07Title")}>
              <div className="grid gap-4 sm:grid-cols-2">
                <GuardCard title={t("docs.guard1Title")} desc={t("docs.guard1Desc")} />
                <GuardCard title={t("docs.guard2Title")} desc={t("docs.guard2Desc")} />
                <GuardCard title={t("docs.guard3Title")} desc={t("docs.guard3Desc")} />
                <GuardCard title={t("docs.guard4Title")} desc={t("docs.guard4Desc")} />
              </div>
            </Section>

            {/* Direcciones */}
            <Section id="direcciones" eyebrow="08" title={t("docs.s08Title")}>
              <AddrTable
                rows={[
                  [t("docs.addrPoolLabel"), POOL, t("docs.addrPoolNote", { fee: FEE_TIER / 10_000 })],
                  [t("docs.addrUsdtLabel"), USDT, t("docs.addrUsdtNote")],
                  [t("docs.addrWethLabel"), WETH, t("docs.addrWethNote")],
                  [t("docs.addrPosManagerLabel"), POSITION_MANAGER, t("docs.addrPosManagerNote")],
                  [t("docs.addrSwapRouterLabel"), SWAP_ROUTER02, t("docs.addrSwapRouterNote")],
                  [t("docs.addrUnilabLabel"), UNILAB_PAYMENT_WALLET, t("docs.addrUnilabNote")],
                ]}
              />
              <p className="mt-4 text-sm text-muted">
                {t("docs.s08FooterPre")}
                <code className="text-xs">PLAN.md</code>
                {t("docs.s08FooterPost")}
              </p>
            </Section>

            {/* Glosario */}
            <Section id="glosario" eyebrow="09" title={t("docs.s09Title")}>
              <dl className="grid gap-4 sm:grid-cols-2">
                {[
                  [t("docs.g1Term"), t("docs.g1Def")],
                  [t("docs.g2Term"), t("docs.g2Def")],
                  [t("docs.g3Term"), t("docs.g3Def")],
                  [t("docs.g4Term"), t("docs.g4Def")],
                  [t("docs.g5Term"), t("docs.g5Def")],
                  [t("docs.g6Term"), t("docs.g6Def")],
                  [t("docs.g7Term"), t("docs.g7Def")],
                  [t("docs.g8Term"), t("docs.g8Def")],
                ].map(([term, def]) => (
                  <div key={term} className="rounded-xl border border-hairline bg-white/[0.02] p-4">
                    <dt className="text-sm font-semibold text-white/85">{term}</dt>
                    <dd className="mt-1.5 text-xs leading-relaxed text-muted">{def}</dd>
                  </div>
                ))}
              </dl>
            </Section>

            <div className="flex flex-wrap gap-3 border-t border-hairline pt-10">
              <Link href="/create" className="btn-primary !px-6 !py-3">
                {t("docs.ctaCreate")}
              </Link>
              <Link href="/recursos" className="btn-secondary !px-6 !py-3">
                {t("docs.ctaRecursos")}
              </Link>
            </div>
          </div>
        </div>
      </main>
    </>
  );
}

type T = ReturnType<typeof useTranslation>["t"];

function Section({
  id,
  eyebrow,
  title,
  children,
}: {
  id: string;
  eyebrow: string;
  title: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-28">
      <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-accent">{eyebrow}</span>
      <h2
        className="mt-2 text-2xl font-semibold tracking-tight sm:text-[28px]"
        style={{ fontFamily: "var(--font-display)" }}
      >
        {title}
      </h2>
      <div className="mt-4 flex flex-col gap-4 text-[15px] leading-relaxed text-muted [&_code]:rounded [&_code]:bg-white/[0.06] [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[13px] [&_code]:text-white/80">
        {children}
      </div>
    </section>
  );
}

function RoleCard({
  title,
  subtitle,
  points,
  accent,
}: {
  title: string;
  subtitle: React.ReactNode;
  points: string[];
  accent?: boolean;
}) {
  return (
    <div className={accent ? "glass rounded-2xl border-accent/35 bg-accent/[0.06] p-5" : "glass rounded-2xl p-5"}>
      <h3 className="text-base font-semibold text-white/90">{title}</h3>
      <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.12em] text-faint">{subtitle}</p>
      <ul className="mt-3 flex flex-col gap-1.5 text-xs leading-relaxed text-muted">
        {points.map((p) => (
          <li key={p}>· {p}</li>
        ))}
      </ul>
    </div>
  );
}

function FlowDiagram({ steps }: { steps: { who: string; what: string; detail: string }[] }) {
  return (
    <div className="my-6 flex flex-col gap-0 overflow-x-auto sm:flex-row sm:items-stretch sm:gap-0">
      {steps.map((s, i) => (
        <div key={s.what} className="flex flex-1 items-center sm:flex-row">
          <div className="glass w-full shrink-0 rounded-2xl p-4 sm:min-w-[180px]">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-accent">{s.who}</span>
            <p className="mt-1.5 font-mono text-xs text-white/90">{s.what}</p>
            <p className="mt-1 text-[11px] leading-snug text-muted">{s.detail}</p>
          </div>
          {i < steps.length - 1 && (
            <span className="mx-2 my-2 shrink-0 text-lg text-faint sm:mx-3 sm:my-0" aria-hidden>
              <span className="hidden sm:inline">→</span>
              <span className="sm:hidden">↓</span>
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function ArchitectureDiagram({ t }: { t: T }) {
  return (
    <div className="my-6 overflow-x-auto">
      <div className="flex min-w-[560px] flex-col items-center gap-0">
        <DiagramBox
          label={t("docs.diagPlatformLabel")}
          name="PlatformConfig.sol"
          detail={t("docs.diagPlatformDetail")}
        />
        <Connector label={t("docs.diagConfiguresTo")} />
        <DiagramBox label={t("docs.diagFactoryLabel")} name="VaultFactory.sol" detail={t("docs.diagFactoryDetail")} />
        <Connector label={t("docs.diagDeploysN")} />
        <div className="flex w-full items-start justify-center gap-3">
          {[t("docs.diagVaultAna"), t("docs.diagVaultBruno"), t("docs.diagVaultCami")].map((v, i) => (
            <div
              key={v}
              className={
                "glass flex-1 rounded-2xl p-3 text-center " + (i === 1 ? "border-accent/35 bg-accent/[0.05]" : "")
              }
            >
              <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-faint">RangeVault.sol</p>
              <p className="mt-1 text-xs font-medium text-white/85">{v}</p>
              <p className="mt-1 text-[10px] text-muted">{t("docs.diagRangeVaultNote")}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function DiagramBox({ label, name, detail }: { label: string; name: string; detail: string }) {
  return (
    <div className="glass w-full max-w-sm rounded-2xl p-4 text-center">
      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-accent">{label}</span>
      <p className="mt-1 font-mono text-sm text-white/90">{name}</p>
      <p className="mt-1 text-[11px] text-muted">{detail}</p>
    </div>
  );
}

function Connector({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center py-1.5 text-faint">
      <span className="h-4 w-px bg-hairline" aria-hidden />
      <span className="my-0.5 whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.1em]">{label}</span>
      <span className="h-4 w-px bg-hairline" aria-hidden />
      <span aria-hidden>↓</span>
    </div>
  );
}

function FundFlowDiagram({ t }: { t: T }) {
  return (
    <div className="my-5 overflow-x-auto">
      <div className="grid min-w-[640px] grid-cols-[1fr_auto_1fr_auto_1fr] items-center gap-2">
        {/* Row 1: Owner -> Vault */}
        <FlowNode label={t("docs.fundFlowOwnerLabel")} detail={t("docs.fundFlowOwnerDepositDetail")} />
        <Arrow text="deposit()" />
        <FlowNode label={t("docs.fundFlowVaultLabel")} detail={t("docs.fundFlowVaultLedgersDetail")} highlight />
        <Arrow text={t("docs.arrowSwapMint")} />
        <FlowNode label={t("docs.fundFlowPositionLabel")} detail={t("docs.fundFlowPositionNftDetail")} />

        {/* Row 2: return paths */}
        <FlowNode label={t("docs.fundFlowOwnerLabel")} detail={t("docs.fundFlowOwnerWithdrawDetail")} />
        <Arrow text="withdraw()" reverse />
        <FlowNode label={t("docs.fundFlowVaultLabel")} detail={t("docs.fundFlowVaultFeesDetail")} highlight />
        <Arrow text={t("docs.arrowCollect")} reverse />
        <FlowNode label={t("docs.fundFlowPositionLabel")} detail={t("docs.fundFlowPositionFeesDetail")} />

        {/* Row 3: operator fee, off to the side */}
        <div />
        <div />
        <FlowNode label={t("docs.fundFlowOperatorLabel")} detail={t("docs.fundFlowOperatorDetail")} small />
        <Arrow text={t("docs.arrowPerformanceFee")} small />
        <FlowNode label={t("docs.fundFlowVaultLabel")} detail={t("docs.fundFlowVaultNeverPrincipalDetail")} highlight small />
      </div>
    </div>
  );
}

function FlowNode({
  label,
  detail,
  highlight,
  small,
}: {
  label: string;
  detail: string;
  highlight?: boolean;
  small?: boolean;
}) {
  return (
    <div
      className={
        (highlight ? "border-accent/35 bg-accent/[0.05] " : "") +
        "glass rounded-xl p-3 text-center " +
        (small ? "opacity-80" : "")
      }
    >
      <p className="text-xs font-medium text-white/85">{label}</p>
      <p className="mt-0.5 text-[10px] leading-snug text-muted">{detail}</p>
    </div>
  );
}

function Arrow({ text, reverse, small }: { text: string; reverse?: boolean; small?: boolean }) {
  return (
    <div className={"flex flex-col items-center " + (small ? "opacity-80" : "")}>
      <span className="text-base text-faint" aria-hidden>
        {reverse ? "←" : "→"}
      </span>
      <span className="whitespace-nowrap font-mono text-[9px] uppercase tracking-[0.08em] text-faint">{text}</span>
    </div>
  );
}

function ContractBlock({
  name,
  desc,
  rows,
  children,
}: {
  name: string;
  desc: string;
  rows?: [string, string][];
  children?: React.ReactNode;
}) {
  return (
    <div className="glass mt-6 rounded-2xl p-5 sm:p-6">
      <h3 className="font-mono text-sm text-accent">{name}</h3>
      <p className="mt-2 text-sm leading-relaxed text-muted">{desc}</p>
      {rows && <FunctionTable rows={rows} />}
      {children}
    </div>
  );
}

function FunctionTable({ rows }: { rows: [string, string][] }) {
  return (
    <div className="mt-3 flex flex-col gap-2">
      {rows.map(([fn, desc]) => (
        <div key={fn} className="grid gap-1 sm:grid-cols-[minmax(0,280px)_1fr] sm:gap-4">
          <code className="break-all font-mono text-[12px] text-white/80">{fn}</code>
          <p className="text-xs leading-relaxed text-muted">{desc}</p>
        </div>
      ))}
    </div>
  );
}

function GuardCard({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="glass rounded-2xl p-5">
      <h3 className="text-sm font-semibold text-white/90">{title}</h3>
      <p className="mt-2 text-xs leading-relaxed text-muted">{desc}</p>
    </div>
  );
}

function AddrTable({ rows }: { rows: [string, string, string][] }) {
  return (
    <div className="mt-4 flex flex-col divide-y divide-hairline overflow-hidden rounded-2xl border border-hairline">
      {rows.map(([label, address, note]) => (
        <div key={label} className="grid gap-1 bg-white/[0.01] p-4 sm:grid-cols-[160px_1fr_auto] sm:items-center sm:gap-4">
          <span className="text-xs font-medium text-white/80">{label}</span>
          <a
            href={`https://celoscan.io/address/${address}`}
            target="_blank"
            rel="noopener noreferrer"
            className="break-all font-mono text-xs text-muted underline-offset-4 hover:text-accent hover:underline"
          >
            {address} ↗
          </a>
          <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-faint">{note}</span>
        </div>
      ))}
    </div>
  );
}
