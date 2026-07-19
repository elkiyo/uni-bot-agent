"use client";

import { Header } from "../components/Header";
import { useTranslation } from "@/lib/i18n/useTranslation";

const timeline = [
  { evtKey: "eventInit", kind: "init", price: "$1800.00", d1: "$1710.00", c1: "$1854.00", width: "7.77%" },
  { evtKey: "eventPeriodico", kind: "sky", price: "$1800.00", d1: "$1710.00 →", c1: "$1854.00 → $1800.00", width: "5.00%" },
  { evtKey: "eventTecho", kind: "accent", price: "$1808.00", d1: "$1710.00 → $1717.60", c1: "$1800.00 → $1862.24", width: "7.77%" },
  { evtKey: "eventPeriodico", kind: "sky", price: "$1830.00", d1: "$1717.60 →", c1: "$1862.24 → $1830.00", width: "6.14%" },
  { evtKey: "eventTecho", kind: "accent", price: "$1850.00", d1: "$1717.60 → $1757.50", c1: "$1830.00 → $1905.50", width: "7.77%" },
  { evtKey: "eventPiso", kind: "negative", price: "$1770.00", d1: "$1778.40 → $1681.50", c1: "$1928.16 → $1770.00", width: "5.00%" },
  { evtKey: "eventPeriodico", kind: "sky", price: "$1735.00", d1: "$1681.50 →", c1: "$1770.00 → $1735.00", width: "3.08%" },
] as const;

const pillClass: Record<string, string> = {
  init: "!border-hairline !text-faint",
  sky: "!border-sky-400/40 !text-sky-400",
  accent: "!border-accent/40 !text-accent",
  negative: "!border-negative/40 !text-negative",
};

const caseBorder: Record<string, string> = {
  sky: "border-l-sky-400",
  negative: "border-l-negative",
  accent: "border-l-accent",
};

const caseTagColor: Record<string, string> = {
  sky: "!border-sky-400/45 !text-sky-400",
  negative: "!border-negative/45 !text-negative",
  accent: "!border-accent/45 !text-accent",
};

export default function RecursosPage() {
  const { t } = useTranslation();

  const fields = [
    { name: t("recursos.field1Name"), what: <>{t("recursos.field1What")}</>, example: t("recursos.field1Example") },
    { name: t("recursos.field2Name"), what: <>{t("recursos.field2What")}</>, example: t("recursos.field2Example") },
    { name: t("recursos.field3Name"), what: <>{t("recursos.field3What")}</>, example: t("recursos.field3Example") },
    {
      name: t("recursos.field4Name"),
      what: (
        <>
          {t("recursos.field4WhatPre")}
          <code>0</code>
          {t("recursos.field4WhatPost")}
        </>
      ),
      example: t("recursos.field4Example"),
    },
    {
      name: t("recursos.field5Name"),
      what: (
        <>
          {t("recursos.field5WhatPre")}
          <code>0</code>
          {t("recursos.field5WhatPost")}
        </>
      ),
      example: t("recursos.field5Example"),
    },
    {
      name: t("recursos.field6Name"),
      what: (
        <>
          {t("recursos.field6WhatPre")}
          <code>0</code>
          {t("recursos.field6WhatPost")}
        </>
      ),
      example: t("recursos.field6Example"),
    },
  ];

  const steps = [
    {
      title: t("recursos.step1Title"),
      body: <code className="font-mono text-[13px]">rebalanceCount &lt; maxRebalances</code>,
      result: { kind: "no" as const, text: t("recursos.step1No") },
    },
    {
      title: t("recursos.step2Title"),
      body: <code className="font-mono text-[13px]">ahora ≥ últimoRebalanceo + minRebalanceInterval</code>,
      result: { kind: "no" as const, text: t("recursos.step2No") },
    },
    {
      title: t("recursos.step3Title"),
      body: <code className="font-mono text-[13px]">ahora ≥ últimoRebalanceo + periodicRebalanceInterval</code>,
      result: { kind: "yes" as const, text: t("recursos.step3Yes") },
    },
    {
      title: t("recursos.step4Title"),
      body: t("recursos.step4Body"),
      result: { kind: "yes" as const, text: t("recursos.step4Yes") },
    },
  ];

  const cases = [
    {
      color: "sky",
      name: t("recursos.case1Name"),
      trigger: t("recursos.case1Trigger"),
      desc: t("recursos.case1Desc"),
      example: "D1 = $1710 (piso, sin cambios) + precio actual = $1800 → nueva posición [$1710 – $1800]",
    },
    {
      color: "negative",
      name: t("recursos.case2Name"),
      trigger: t("recursos.case2Trigger"),
      desc: t("recursos.case2Desc"),
      example: "posición vieja [$1710 – $1770] + precio cae a $1700 → D1 = $1700 × 0.95 = $1615",
    },
    {
      color: "accent",
      name: t("recursos.case3Name"),
      trigger: t("recursos.case3Trigger"),
      desc: t("recursos.case3Desc"),
      example: "techo viejo = $1800, roto + precio actual = $1810 → [$1810 × 0.95, $1810 × 1.03] = [$1720 – $1864]",
    },
  ];

  return (
    <>
      <Header />
      <main className="section flex-1 pb-24 pt-32">
        <span className="eyebrow">{t("recursos.eyebrow")}</span>
        <h1
          className="mt-5 text-balance text-3xl font-semibold leading-[1.1] tracking-tight sm:text-4xl"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {t("recursos.titlePre")}
          <span className="text-accent">{t("recursos.titleHighlight")}</span>
          {t("recursos.titlePost")}
        </h1>
        <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-muted">{t("recursos.subtitle")}</p>

        {/* §1 fields */}
        <section className="mt-16">
          <h2 className="text-xl font-semibold tracking-tight" style={{ fontFamily: "var(--font-display)" }}>
            {t("recursos.section1Title")}
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">{t("recursos.section1Subtitle")}</p>
          <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {fields.map((f) => (
              <div key={f.name} className="glass rounded-2xl p-5">
                <p className="font-mono text-xs text-accent">{f.name}</p>
                <p className="mt-2 text-sm leading-relaxed text-white/90">{f.what}</p>
                <p className="mt-3 border-t border-hairline pt-3 font-mono text-xs text-faint">
                  <b className="text-muted">{t("recursos.exampleLabel")}</b> {f.example}
                </p>
              </div>
            ))}
          </div>
          <p className="mt-5 max-w-2xl text-sm leading-relaxed text-muted">
            {t("recursos.seventhFieldPre")}
            <code className="text-white/80">minRebalanceInterval</code>
            {t("recursos.seventhFieldMid")}
            <code className="text-white/80">0</code>
            {t("recursos.seventhFieldPost")}
          </p>
        </section>

        {/* §2 decision order */}
        <section className="mt-16">
          <h2 className="text-xl font-semibold tracking-tight" style={{ fontFamily: "var(--font-display)" }}>
            {t("recursos.section2Title")}
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">{t("recursos.section2Subtitle")}</p>
          <ol className="mt-6 flex flex-col gap-5">
            {steps.map((s, i) => (
              <li key={s.title} className="flex gap-4">
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-accent font-mono text-xs text-accent">
                  {i + 1}
                </span>
                <div>
                  <p className="text-sm font-medium text-white/90">{s.title}</p>
                  <p className="mt-1 text-sm text-muted">{s.body}</p>
                  <p
                    className={`mt-1.5 font-mono text-xs ${
                      s.result.kind === "no" ? "text-negative" : "text-positive"
                    }`}
                  >
                    {s.result.text}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        {/* §3 cases */}
        <section className="mt-16">
          <h2 className="text-xl font-semibold tracking-tight" style={{ fontFamily: "var(--font-display)" }}>
            {t("recursos.section3Title")}
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">{t("recursos.section3Subtitle")}</p>
          <div className="mt-5 flex flex-col gap-4">
            {cases.map((c) => (
              <div key={c.name} className={`glass rounded-2xl border-l-4 ${caseBorder[c.color]} p-6`}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-base font-semibold text-white/90">{c.name}</span>
                  <span className={`eyebrow !px-3 !py-1 ${caseTagColor[c.color]}`}>{c.trigger}</span>
                </div>
                <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">{c.desc}</p>
                <div className="mt-4 rounded-xl border border-hairline bg-white/[0.02] p-4">
                  <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
                    {t("recursos.exampleLabelUpper")}
                  </p>
                  <p className="mt-2 break-words font-mono text-xs text-white/80">{c.example}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* §4 timeline */}
        <section className="mt-16">
          <h2 className="text-xl font-semibold tracking-tight" style={{ fontFamily: "var(--font-display)" }}>
            {t("recursos.section4Title")}
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">{t("recursos.section4Subtitle")}</p>
          <div className="mt-5 overflow-x-auto rounded-2xl border border-hairline">
            <table className="w-full min-w-[640px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-hairline bg-white/[0.02]">
                  {(
                    [
                      t("recursos.colEvento"),
                      t("recursos.colPrecio"),
                      t("recursos.colD1"),
                      t("recursos.colC1"),
                      t("recursos.colAncho"),
                    ] as const
                  ).map((h) => (
                    <th
                      key={h}
                      className="whitespace-nowrap px-4 py-3 text-left font-mono text-[10px] uppercase tracking-[0.12em] text-faint"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {timeline.map((row, i) => (
                  <tr key={i} className="border-b border-hairline last:border-0">
                    <td className="whitespace-nowrap px-4 py-3">
                      <span className={`eyebrow !px-2.5 !py-0.5 !text-[10px] ${pillClass[row.kind]}`}>
                        {t(`recursos.${row.evtKey}` as "recursos.eventInit")}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-muted">{row.price}</td>
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-muted">{row.d1}</td>
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-muted">{row.c1}</td>
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-muted">{row.width}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* §5 pitfall */}
        <section className="mt-16">
          <h2 className="text-xl font-semibold tracking-tight" style={{ fontFamily: "var(--font-display)" }}>
            {t("recursos.section5Title")}
          </h2>
          <div className="mt-5 rounded-2xl border border-negative/35 bg-negative/[0.06] p-6">
            <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-negative">
              {t("recursos.pitfallConfirmed")}
            </p>
            <p className="mt-3 text-sm text-white/90">
              <b>{t("recursos.pitfallSymptomLabel")}</b> {t("recursos.pitfallSymptomText")}
            </p>
            <p className="mt-2 text-sm text-white/90">
              <b>{t("recursos.pitfallCauseLabel")}</b> <code>maxRebalances = 0</code>
              {t("recursos.pitfallCauseMid")}
            </p>
            <p className="mt-2 text-sm text-white/90">
              <b>{t("recursos.pitfallHowLabel")}</b> {t("recursos.pitfallHowPre")}
              <code>0</code>
              {t("recursos.pitfallHowMid")}
              <code>0</code>
              {t("recursos.pitfallHowPost")}
            </p>
            <p className="mt-2 text-sm text-white/90">
              <b>{t("recursos.pitfallFixLabel")}</b> {t("recursos.pitfallFixText")}
            </p>
          </div>
        </section>

        <p className="mt-16 font-mono text-[11px] uppercase tracking-[0.14em] text-faint">
          {t("recursos.sourceLabel")} frontend/lib/keeper/monitor.ts + frontend/lib/keeper/rebalancer.ts
        </p>
      </main>
    </>
  );
}
