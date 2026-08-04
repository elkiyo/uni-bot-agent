"use client";

import { useMemo, useState } from "react";
import { formatUnits, type Abi } from "viem";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useVaultEventLogs } from "@/lib/useVaultEventLogs";
import type { ChainDef } from "@/lib/chains";
import { useTranslation } from "@/lib/i18n/useTranslation";

const dateLocale: Record<string, string> = { es: "es", en: "en-US", pt: "pt-BR", zh: "zh-CN" };

type RowKind = "manual" | "auto" | "reinjected";
type PeriodPreset = "7d" | "30d" | "90d" | "all";
type GroupBy = "day" | "week" | "month";

interface Row {
  blockTimestamp: number;
  txHash: string;
  kind: RowKind;
  amountStable: bigint;
  amountVolatile: bigint;
  usdValue: number | null;
  reinjectedStable?: bigint;
  reinjectedVolatile?: bigint;
  positionId?: bigint;
  platformFee?: { stable: bigint; volatile: bigint };
  platformUsd?: number;
  gasUsd?: bigint;
}

const PERIOD_DAYS: Record<Exclude<PeriodPreset, "all">, number> = { "7d": 7, "30d": 30, "90d": 90 };

/**
 * Every fee-related event a vault has ever emitted, merged into ONE
 * chronological breakdown — replaces the earlier split between
 * FeesPayoutHistory.tsx (LpFeesPaidToOwner/FeesCollected) and
 * ReinjectionHistory.tsx (FeesReinjected), which the user asked to see
 * combined ("desglosado total de todas las comisiones"). A fee always
 * takes exactly one of these three paths per transaction — never more than
 * one — so merging them into a single list never double-counts a row:
 *   - "manual": owner's own collectFees() claim, paid straight to their wallet.
 *   - "auto": keeper-triggered payout during a rebalance/threshold auto-claim.
 *   - "reinjected": compound mode (autoCompoundFees on) — fee stayed in the
 *     vault and got folded back into the position instead of paid out.
 *
 * PerformanceFeeCollected (the platform's cut) and KeeperGasReimbursed (the
 * keeper's own gas cost) both fire in the SAME transaction as whichever of
 * the three paths above triggered them, so both are matched here by
 * tx_hash rather than needing their own rows.
 *
 * Date-range filter + day/week/month bucketed stacked-bar chart added
 * 2026-08-04 — every stat card, the chart, and the table below all read
 * from the SAME filteredRows, so switching the range never has the totals
 * disagree with what's actually listed.
 */
export function FeesHistory({
  address,
  chain,
  vaultAbi = chain.vaultAbi,
}: {
  address: `0x${string}`;
  chain: ChainDef;
  vaultAbi?: Abi;
}) {
  const { t, locale } = useTranslation();
  const { data: eventLogs } = useVaultEventLogs(address, chain, vaultAbi);

  const [periodPreset, setPeriodPreset] = useState<PeriodPreset>("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [groupBy, setGroupBy] = useState<GroupBy>("day");
  // Doesn't need to tick — a static "now" from first render is precise
  // enough for a date-range filter (unlike RebalanceCountdown's live
  // second-by-second clock elsewhere on this page).
  const [nowSec] = useState(() => Math.floor(Date.now() / 1000));

  const platformFeeByTxHash = new Map<string, { stable: bigint; volatile: bigint; usd: number }>();
  const gasByTxHash = new Map<string, bigint>();
  for (const log of eventLogs ?? []) {
    if (log.eventName === "PerformanceFeeCollected") {
      const args = log.args as { amount0?: bigint; amount1?: bigint };
      const amount0 = args.amount0 ?? 0n;
      const amount1 = args.amount1 ?? 0n;
      platformFeeByTxHash.set(log.transactionHash, {
        stable: chain.stableIsToken0 ? amount0 : amount1,
        volatile: chain.stableIsToken0 ? amount1 : amount0,
        usd: log.usdValue ?? 0,
      });
    } else if (log.eventName === "KeeperGasReimbursed") {
      const args = log.args as { amountUsd?: bigint };
      gasByTxHash.set(log.transactionHash, args.amountUsd ?? 0n);
    }
  }

  // Which position (tokenId) a reinjection actually landed in — same
  // approach as the old ReinjectionHistory.tsx: the latest
  // PositionInitialized/Rebalanced at or before this event's own block.
  const positionOpens = (eventLogs ?? [])
    .filter((log) => log.eventName === "PositionInitialized" || log.eventName === "Rebalanced")
    .map((log) => ({
      blockNumber: log.blockNumber,
      tokenId: (log.eventName === "PositionInitialized" ? log.args.tokenId : log.args.newTokenId) as bigint,
    }))
    .sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : 1));
  function positionAt(blockNumber: bigint): bigint | undefined {
    let found: bigint | undefined;
    for (const p of positionOpens) {
      if (p.blockNumber <= blockNumber) found = p.tokenId;
      else break;
    }
    return found;
  }

  const allRows: Row[] = [];
  for (const log of eventLogs ?? []) {
    if (log.eventName === "LpFeesPaidToOwner" || log.eventName === "FeesCollected") {
      const args = log.args as { amount0?: bigint; amount1?: bigint };
      const amount0 = args.amount0 ?? 0n;
      const amount1 = args.amount1 ?? 0n;
      const platformFee = platformFeeByTxHash.get(log.transactionHash);
      allRows.push({
        blockTimestamp: log.blockTimestamp,
        txHash: log.transactionHash,
        kind: log.eventName === "FeesCollected" ? "manual" : "auto",
        amountStable: chain.stableIsToken0 ? amount0 : amount1,
        amountVolatile: chain.stableIsToken0 ? amount1 : amount0,
        usdValue: log.usdValue,
        platformFee,
        platformUsd: platformFee?.usd,
        gasUsd: gasByTxHash.get(log.transactionHash),
      });
    } else if (log.eventName === "FeesReinjected") {
      const args = log.args as { netFee0?: bigint; netFee1?: bigint; used0?: bigint; used1?: bigint; netFeeUsd?: bigint };
      const netFee0 = args.netFee0 ?? 0n;
      const netFee1 = args.netFee1 ?? 0n;
      const used0 = args.used0 ?? 0n;
      const used1 = args.used1 ?? 0n;
      const platformFee = platformFeeByTxHash.get(log.transactionHash);
      allRows.push({
        blockTimestamp: log.blockTimestamp,
        txHash: log.transactionHash,
        kind: "reinjected",
        amountStable: chain.stableIsToken0 ? netFee0 : netFee1,
        amountVolatile: chain.stableIsToken0 ? netFee1 : netFee0,
        usdValue: Number(formatUnits(args.netFeeUsd ?? 0n, chain.stableDecimals)),
        reinjectedStable: chain.stableIsToken0 ? used0 : used1,
        reinjectedVolatile: chain.stableIsToken0 ? used1 : used0,
        positionId: positionAt(log.blockNumber),
        platformFee,
        platformUsd: platformFee?.usd,
        gasUsd: gasByTxHash.get(log.transactionHash),
      });
    }
  }
  allRows.sort((a, b) => b.blockTimestamp - a.blockTimestamp); // newest first

  // Custom dates (native <input type="date">, local-midnight semantics) win
  // over the preset pills whenever either is set — same "explicit choice
  // beats default" pattern the rest of this page uses for form fields.
  const rangeStartSec = useMemo(() => {
    if (customFrom) return Math.floor(new Date(`${customFrom}T00:00:00`).getTime() / 1000);
    if (periodPreset === "all") return undefined;
    return nowSec - PERIOD_DAYS[periodPreset] * 86400;
  }, [customFrom, periodPreset, nowSec]);
  const rangeEndSec = useMemo(() => {
    if (!customTo) return undefined;
    return Math.floor(new Date(`${customTo}T23:59:59`).getTime() / 1000);
  }, [customTo]);

  const rows = allRows.filter(
    (r) => (rangeStartSec === undefined || r.blockTimestamp >= rangeStartSec) && (rangeEndSec === undefined || r.blockTimestamp <= rangeEndSec),
  );

  if (allRows.length === 0) return null;

  let totalManualUsd = 0;
  let totalAutoUsd = 0;
  let totalReinjectedUsd = 0;
  let totalPlatformUsd = 0;
  const platformCounted = new Set<string>();
  for (const r of rows) {
    if (r.kind === "manual") totalManualUsd += r.usdValue ?? 0;
    else if (r.kind === "auto") totalAutoUsd += r.usdValue ?? 0;
    else totalReinjectedUsd += r.usdValue ?? 0;
    // Guard against double-counting: platformFee is looked up per ROW, but
    // is keyed by tx_hash — harmless today (a tx only ever produces one
    // manual/auto/reinjected row), kept here so a future event shape change
    // can't silently double-count platform's cut across two rows sharing a tx.
    if (r.platformUsd !== undefined && !platformCounted.has(r.txHash)) {
      totalPlatformUsd += r.platformUsd;
      platformCounted.add(r.txHash);
    }
  }
  const grandTotalUsd = totalManualUsd + totalAutoUsd + totalReinjectedUsd + totalPlatformUsd;

  // Bucket key + label per groupBy, in the LOCAL timezone (matches the date
  // inputs and fmtDate below) — week buckets start Monday.
  function bucketKey(ts: number): { key: string; sortTs: number } {
    const d = new Date(ts * 1000);
    if (groupBy === "day") {
      const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      return { key: day.toISOString().slice(0, 10), sortTs: day.getTime() };
    }
    if (groupBy === "month") {
      const month = new Date(d.getFullYear(), d.getMonth(), 1);
      return { key: `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, "0")}`, sortTs: month.getTime() };
    }
    // week: Monday of that week
    const dow = (d.getDay() + 6) % 7; // 0=Monday
    const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow);
    return { key: monday.toISOString().slice(0, 10), sortTs: monday.getTime() };
  }
  function bucketLabel(sortTs: number): string {
    const d = new Date(sortTs);
    if (groupBy === "month") return d.toLocaleDateString(dateLocale[locale] ?? "es", { month: "short", year: "2-digit" });
    return d.toLocaleDateString(dateLocale[locale] ?? "es", { day: "2-digit", month: "short" });
  }

  const bucketsMap = new Map<string, { sortTs: number; manual: number; auto: number; reinjected: number; platform: number }>();
  for (const r of rows) {
    const { key, sortTs } = bucketKey(r.blockTimestamp);
    const bucket = bucketsMap.get(key) ?? { sortTs, manual: 0, auto: 0, reinjected: 0, platform: 0 };
    if (r.kind === "manual") bucket.manual += r.usdValue ?? 0;
    else if (r.kind === "auto") bucket.auto += r.usdValue ?? 0;
    else bucket.reinjected += r.usdValue ?? 0;
    if (r.platformUsd !== undefined) bucket.platform += r.platformUsd;
    bucketsMap.set(key, bucket);
  }
  const chartData = Array.from(bucketsMap.values())
    .sort((a, b) => a.sortTs - b.sortTs)
    .map((b) => ({ label: bucketLabel(b.sortTs), ...b }));

  const fmtDate = (ts: number) =>
    new Date(ts * 1000).toLocaleString(dateLocale[locale] ?? "es", { dateStyle: "short", timeStyle: "short" });
  const fmtStable = (v: bigint) => `${formatUnits(v, chain.stableDecimals)} ${chain.stableSymbol}`;
  const fmtVolatile = (v: bigint) => `${Number(formatUnits(v, chain.volatileDecimals)).toFixed(6)} ${chain.volatileSymbol}`;
  const fmtUsd = (v: number) => `$${v.toFixed(4)}`;

  const kindLabel = (kind: RowKind) =>
    kind === "manual"
      ? t("feesHistory.kindManual")
      : kind === "auto"
        ? t("feesHistory.kindAuto")
        : t("feesHistory.kindReinjected");

  const periodPills: { value: PeriodPreset; label: string }[] = [
    { value: "7d", label: t("feesHistory.period7d") },
    { value: "30d", label: t("feesHistory.period30d") },
    { value: "90d", label: t("feesHistory.period90d") },
    { value: "all", label: t("feesHistory.periodAll") },
  ];
  const groupPills: { value: GroupBy; label: string }[] = [
    { value: "day", label: t("feesHistory.groupDay") },
    { value: "week", label: t("feesHistory.groupWeek") },
    { value: "month", label: t("feesHistory.groupMonth") },
  ];
  const hasCustomRange = Boolean(customFrom || customTo);

  return (
    <div className="glass mt-10 rounded-2xl p-6 sm:p-8">
      <h2 className="text-2xl font-semibold tracking-tight text-foreground" style={{ fontFamily: "var(--font-display)" }}>
        {t("feesHistory.title")}
      </h2>
      <p className="mt-1 text-sm text-muted">{t("feesHistory.subtitle")}</p>

      <div className="mt-5 flex flex-wrap items-center gap-4">
        <div className="flex flex-wrap gap-1.5">
          {periodPills.map((p) => (
            <button
              key={p.value}
              type="button"
              onClick={() => {
                setPeriodPreset(p.value);
                setCustomFrom("");
                setCustomTo("");
              }}
              className={`rounded-full border px-3 py-1 font-mono text-[11px] uppercase tracking-[0.1em] transition-colors ${
                !hasCustomRange && periodPreset === p.value
                  ? "border-accent-fill-border bg-accent-fill-bg text-accent-fill-text"
                  : "border-hairline text-muted hover:border-border-medium hover:text-foreground"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 font-mono text-[11px] text-muted">
          <label className="flex items-center gap-1.5">
            {t("feesHistory.customFrom")}
            <input
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="rounded-lg border border-hairline bg-transparent px-2 py-1 text-foreground/90"
            />
          </label>
          <label className="flex items-center gap-1.5">
            {t("feesHistory.customTo")}
            <input
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className="rounded-lg border border-hairline bg-transparent px-2 py-1 text-foreground/90"
            />
          </label>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <div className="rounded-xl border border-hairline/60 p-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">{t("feesHistory.totalManual")}</p>
          <p className="mt-1 font-mono text-base font-semibold text-foreground">{fmtUsd(totalManualUsd)}</p>
        </div>
        <div className="rounded-xl border border-hairline/60 p-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">{t("feesHistory.totalAuto")}</p>
          <p className="mt-1 font-mono text-base font-semibold text-foreground">{fmtUsd(totalAutoUsd)}</p>
        </div>
        <div className="rounded-xl border border-hairline/60 p-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">{t("feesHistory.totalReinjected")}</p>
          <p className="mt-1 font-mono text-base font-semibold text-foreground">{fmtUsd(totalReinjectedUsd)}</p>
        </div>
        <div className="rounded-xl border border-hairline/60 p-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">{t("feesHistory.totalPlatform")}</p>
          <p className="mt-1 font-mono text-base font-semibold text-foreground">{fmtUsd(totalPlatformUsd)}</p>
        </div>
        <div className="rounded-xl border border-accent-fill-border bg-accent-fill-bg/10 p-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-accent-text">{t("feesHistory.totalAll")}</p>
          <p className="mt-1 font-mono text-base font-semibold text-accent-text">{fmtUsd(grandTotalUsd)}</p>
          <p className="mt-0.5 font-mono text-[10px] text-faint">{t("feesHistory.totalAllHint", { count: rows.length })}</p>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="mt-8 text-sm text-muted">{t("feesHistory.noDataInRange")}</p>
      ) : (
        <>
          <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">{t("feesHistory.chartTitle")}</span>
            <div className="flex gap-1.5">
              {groupPills.map((g) => (
                <button
                  key={g.value}
                  type="button"
                  onClick={() => setGroupBy(g.value)}
                  className={`rounded-full border px-3 py-1 font-mono text-[11px] uppercase tracking-[0.1em] transition-colors ${
                    groupBy === g.value
                      ? "border-accent-fill-border bg-accent-fill-bg text-accent-fill-text"
                      : "border-hairline text-muted hover:border-border-medium hover:text-foreground"
                  }`}
                >
                  {g.label}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-3" style={{ width: "100%", height: 260 }}>
            <ResponsiveContainer minWidth={200} minHeight={200}>
              <BarChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--hairline)" vertical={false} />
                <XAxis dataKey="label" stroke="var(--faint)" fontSize={11} tickLine={false} />
                <YAxis stroke="var(--faint)" fontSize={11} tickLine={false} tickFormatter={(v) => `$${Number(v).toFixed(0)}`} />
                <Tooltip
                  contentStyle={{ background: "var(--surface)", border: "1px solid var(--hairline)", borderRadius: 8, fontSize: 12 }}
                  formatter={(value: unknown, name: unknown) => [fmtUsd(Number(value)), String(name)] as [string, string]}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="auto" name={t("feesHistory.kindAuto")} stackId="fees" fill="var(--chart-cat-auto)" radius={[0, 0, 0, 0]} />
                <Bar dataKey="manual" name={t("feesHistory.kindManual")} stackId="fees" fill="var(--chart-cat-manual)" />
                <Bar
                  dataKey="reinjected"
                  name={t("feesHistory.kindReinjected")}
                  stackId="fees"
                  fill="var(--chart-cat-reinjected)"
                />
                <Bar
                  dataKey="platform"
                  name={t("feesHistory.totalPlatform")}
                  stackId="fees"
                  fill="var(--chart-cat-platform)"
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="mt-6 overflow-x-auto">
            <table className="w-full min-w-[880px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-hairline text-left">
                  <th className="whitespace-nowrap py-2 pr-4 font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-faint">
                    {t("feesHistory.colDate")}
                  </th>
                  <th className="whitespace-nowrap py-2 pr-4 font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-faint">
                    {t("feesHistory.colType")}
                  </th>
                  <th className="whitespace-nowrap py-2 pr-4 font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-faint">
                    {t("feesHistory.colAmount")}
                  </th>
                  <th className="whitespace-nowrap py-2 pr-4 font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-faint">
                    {t("feesHistory.colPlatformFee")}
                  </th>
                  <th className="whitespace-nowrap py-2 pr-4 font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-faint">
                    {t("feesHistory.colGasCost")}
                  </th>
                  <th className="whitespace-nowrap py-2 font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-faint">
                    {t("feesHistory.colTx")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const gasPct =
                    r.gasUsd !== undefined && r.usdValue && r.usdValue > 0 ? (Number(r.gasUsd) / 1e6 / r.usdValue) * 100 : undefined;
                  const unprofitable = gasPct !== undefined && gasPct >= 100;
                  const marginal = gasPct !== undefined && gasPct >= 25 && gasPct < 100;
                  return (
                    <tr key={`${r.txHash}-${r.kind}`} className="border-b border-hairline/60 last:border-0">
                      <td className="whitespace-nowrap py-3 pr-4 font-mono text-xs text-foreground/90">{fmtDate(r.blockTimestamp)}</td>
                      <td className="whitespace-nowrap py-3 pr-4">
                        <span
                          className={`eyebrow !px-2 !py-0.5 !text-[10px] ${r.kind === "reinjected" ? "!border-accent-fill-border !text-accent-text" : ""}`}
                        >
                          {kindLabel(r.kind)}
                        </span>
                        {r.positionId !== undefined && (
                          <div className="mt-1 font-mono text-[10px] text-faint">
                            {t("feesHistory.positionLabel", { id: r.positionId.toString() })}
                          </div>
                        )}
                      </td>
                      <td className="py-3 pr-4">
                        <span className="font-mono font-semibold text-positive">
                          {r.usdValue !== null ? fmtUsd(r.usdValue) : "—"}
                        </span>
                        <div className="mt-0.5 text-xs text-muted">
                          {fmtStable(r.amountStable)}
                          {r.amountVolatile > 0n ? ` + ${fmtVolatile(r.amountVolatile)}` : ""}
                        </div>
                        {r.kind === "reinjected" && r.reinjectedStable !== undefined && (
                          <div className="mt-0.5 text-[11px] text-faint">
                            {t("feesHistory.reinjectedAs")}: {fmtStable(r.reinjectedStable)}
                            {(r.reinjectedVolatile ?? 0n) > 0n ? ` + ${fmtVolatile(r.reinjectedVolatile ?? 0n)}` : ""}
                          </div>
                        )}
                      </td>
                      <td className="whitespace-nowrap py-3 pr-4 font-mono text-foreground/80">
                        {r.platformFee
                          ? `${fmtStable(r.platformFee.stable)}${r.platformFee.volatile > 0n ? ` + ${fmtVolatile(r.platformFee.volatile)}` : ""}`
                          : "—"}
                      </td>
                      <td className="whitespace-nowrap py-3 pr-4">
                        {r.gasUsd === undefined ? (
                          <span className="text-muted">—</span>
                        ) : (
                          <>
                            <span className="font-mono text-foreground/80">{fmtUsd(Number(r.gasUsd) / 1e6)}</span>
                            {gasPct !== undefined && (
                              <div
                                className={`font-mono text-[11px] ${unprofitable ? "text-negative" : marginal ? "text-accent-text" : "text-faint"}`}
                              >
                                {gasPct.toFixed(1)}%{unprofitable ? ` ${t("feesHistory.unprofitable")}` : ""}
                              </div>
                            )}
                          </>
                        )}
                      </td>
                      <td className="whitespace-nowrap py-3">
                        <a
                          href={`${chain.explorerBaseUrl}/tx/${r.txHash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-mono text-[11px] text-faint underline-offset-4 hover:text-accent-text hover:underline"
                        >
                          {r.txHash.slice(0, 8)}…{r.txHash.slice(-6)} ↗
                        </a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
