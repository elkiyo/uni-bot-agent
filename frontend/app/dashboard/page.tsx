"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  AreaChart,
  Area,
  Cell,
} from "recharts";
import { Header } from "../components/Header";
import { useProtocolMetrics, type VaultRow, type VaultStatus } from "@/lib/dashboard/useProtocolMetrics";
import { bucketByTime, type Granularity } from "@/lib/dashboard/bucket";
import { useAvailableChains, useSelectedChain } from "@/lib/useSelectedChain";
import { useTranslation } from "@/lib/i18n/useTranslation";

const CHART_COLORS = ["#fcff52", "#4ade80", "#60a5fa", "#f472b6", "#fb923c", "#a78bfa"];

function granularityLabels(t: ReturnType<typeof useTranslation>["t"]): Record<Granularity, string> {
  return {
    day: t("dashboard.granularityDay"),
    week: t("dashboard.granularityWeek"),
    month: t("dashboard.granularityMonth"),
    year: t("dashboard.granularityYear"),
  };
}

function usd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(n < 10 ? 2 : 0)}`;
}

export default function DashboardPage() {
  const chains = useAvailableChains();
  const [chainFilter, setChainFilter] = useState<number | "all">("all");
  const [granularity, setGranularity] = useState<Granularity>("day");
  const metrics = useProtocolMetrics(chainFilter);
  const { t } = useTranslation();
  const GRANULARITY_LABELS = granularityLabels(t);

  return (
    <>
      <Header />
      <main className="section flex-1 pb-24 pt-32">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <span className="eyebrow">{t("dashboard.eyebrow")}</span>
            <h1
              className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl"
              style={{ fontFamily: "var(--font-display)" }}
            >
              {t("dashboard.title")}
            </h1>
            <p className="mt-2 max-w-xl text-sm text-muted">{t("dashboard.subtitle")}</p>
          </div>

          <div className="flex items-center gap-3">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-positive opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-positive" />
            </span>
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">{t("dashboard.live")}</span>
          </div>
        </div>

        <div className="mt-8 flex flex-wrap gap-1.5 rounded-full border border-hairline p-1" style={{ width: "fit-content" }}>
          <ChainTab label={t("dashboard.chainAll")} active={chainFilter === "all"} onClick={() => setChainFilter("all")} />
          {chains.map((c) => (
            <ChainTab key={c.id} label={c.name} active={chainFilter === c.id} onClick={() => setChainFilter(c.id)} />
          ))}
        </div>

        {metrics.chainErrors.length > 0 && (
          <div className="glass mt-8 rounded-2xl border-negative/40 bg-negative/[0.06] p-5">
            <p className="text-sm font-medium text-negative">
              {t("dashboard.chainErrorMsg", { chains: metrics.chainErrors.map((e) => e.chainName).join(", ") })}
            </p>
          </div>
        )}

        <StatGrid metrics={metrics} />

        {metrics.poolTypes.length > 0 && <PoolTypeChart poolTypes={metrics.poolTypes} />}

        <div className="mt-10 flex items-center justify-between gap-4">
          <h2 className="text-lg font-semibold tracking-tight text-white/90" style={{ fontFamily: "var(--font-display)" }}>
            {t("dashboard.historicalSeries")}
          </h2>
          <div className="flex gap-1.5 rounded-full border border-hairline p-1">
            {(Object.keys(GRANULARITY_LABELS) as Granularity[]).map((g) => (
              <button
                key={g}
                onClick={() => setGranularity(g)}
                className={
                  granularity === g
                    ? "rounded-full bg-accent px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.1em] text-background"
                    : "rounded-full px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.1em] text-muted hover:text-white"
                }
              >
                {GRANULARITY_LABELS[g]}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <VolumeSeriesChart events={metrics.mintVolumeEvents} granularity={granularity} isLoading={metrics.mintVolumeLoading} />
          <FeesSeriesChart events={metrics.feeEvents} granularity={granularity} isLoading={metrics.eventsLoading} />
          <RebalanceSeriesChart events={metrics.rebalanceEvents} granularity={granularity} isLoading={metrics.eventsLoading} />
          <VaultStatusChart metrics={metrics} />
        </div>

        <VaultHistoryTable
          rows={metrics.vaultRows}
          isLoading={metrics.vaultRowsLoading}
          snapshotLoading={metrics.snapshotLoading}
          eventsLoading={metrics.eventsLoading}
        />

        <p className="mt-10 max-w-2xl font-mono text-[11px] leading-relaxed text-faint">{t("dashboard.footnote")}</p>
      </main>
    </>
  );
}

function ChainTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={
        active
          ? "rounded-full bg-accent px-4 py-1.5 font-mono text-[11px] uppercase tracking-[0.1em] text-background"
          : "rounded-full px-4 py-1.5 font-mono text-[11px] uppercase tracking-[0.1em] text-muted hover:text-white"
      }
    >
      {label}
    </button>
  );
}

function Stat({
  label,
  value,
  accent,
  sub,
}: {
  label: React.ReactNode;
  value: string;
  accent?: boolean;
  sub?: string;
}) {
  return (
    <div className={accent ? "glass rounded-2xl border-accent/35 bg-accent/[0.06] p-5" : "glass rounded-2xl p-5"}>
      <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">{label}</span>
      <p
        className={`mt-2 text-2xl font-semibold tabular-nums ${accent ? "text-accent" : "text-white/90"}`}
        style={{ fontFamily: "var(--font-display)" }}
      >
        {value}
      </p>
      {sub && <p className="mt-1 font-mono text-[11px] text-faint">{sub}</p>}
    </div>
  );
}

function StatGrid({ metrics }: { metrics: ReturnType<typeof useProtocolMetrics> }) {
  const { t } = useTranslation();
  const chainBreakdown = (byChain: Record<number, number>, format: (n: number) => string = usd) =>
    metrics.chains.map((c) => `${c.name}: ${format(byChain[c.id] ?? 0)}`).join(" · ");

  const mintVolumeTotal = metrics.mintVolumeEvents.reduce((sum, e) => sum + e.usd, 0);

  return (
    <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Stat
        label={t("dashboard.statTvl")}
        value={metrics.snapshotLoading ? "…" : usd(metrics.tvlUsd)}
        accent
        sub={chainBreakdown(metrics.tvlByChain)}
      />
      <Stat
        label={t("dashboard.statVolumeMoved")}
        value={metrics.mintVolumeLoading ? "…" : usd(mintVolumeTotal)}
        sub={t("dashboard.statVolumeSub")}
      />
      <Stat
        label={t("dashboard.statActiveVaults")}
        value={metrics.snapshotLoading ? "…" : String(metrics.vaultCounts.withPosition)}
        sub={t("dashboard.statActiveVaultsSub", {
          total: metrics.vaultCounts.total,
          closed: metrics.vaultCounts.closed,
        })}
      />
      <Stat
        label={t("dashboard.statRebalances")}
        value={metrics.snapshotLoading ? "…" : String(metrics.rebalanceCount)}
        sub={chainBreakdown(metrics.rebalanceCountByChain, String)}
      />
      <Stat
        label={t("dashboard.statOwnerFees")}
        value={metrics.eventsLoading ? "…" : usd(metrics.ownerFeesUsd)}
        sub={t("dashboard.statOwnerFeesSub")}
      />
      <Stat
        label={t("dashboard.statPlatformRevenue")}
        value={metrics.eventsLoading ? "…" : usd(metrics.platformFeesUsd)}
        sub={t("dashboard.statPlatformRevenueSub")}
      />
      <Stat
        label={
          <>
            {t("dashboard.statGasReimbursedPre")}
            <span className="text-accent">{t("dashboard.statGasReimbursedHighlight")}</span>
          </>
        }
        value={metrics.eventsLoading ? "…" : usd(metrics.gasReimbursedUsd)}
        sub={t("dashboard.statGasReimbursedSub")}
      />
      <Stat
        label={t("dashboard.statHistoricalDeposits")}
        value={metrics.eventsLoading ? "…" : usd(metrics.depositedTotalUsd)}
        sub={t("dashboard.statHistoricalDepositsSub")}
      />
    </div>
  );
}

function PoolTypeChart({ poolTypes }: { poolTypes: ReturnType<typeof useProtocolMetrics>["poolTypes"] }) {
  const { t } = useTranslation();
  const data = poolTypes.map((p) => ({ label: p.label, tvl: Number(p.tvlUsd.toFixed(2)), vaults: p.vaultCount }));
  return (
    <div className="glass mt-8 rounded-2xl p-6 sm:p-8">
      <h2 className="text-xl font-semibold tracking-tight" style={{ fontFamily: "var(--font-display)" }}>
        {t("dashboard.poolTypeTitle")}
      </h2>
      <p className="mt-1 text-sm text-muted">{t("dashboard.poolTypeSubtitle")}</p>
      <div className="mt-6" style={{ width: "100%", height: 280 }}>
        <ResponsiveContainer minWidth={200} minHeight={200}>
          <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1b1b1b" />
            <XAxis dataKey="label" stroke="#71717a" fontSize={11} tickLine={false} />
            <YAxis stroke="#71717a" fontSize={11} tickLine={false} tickFormatter={(v) => usd(Number(v))} />
            <Tooltip
              contentStyle={{ background: "#0a0a0a", border: "1px solid #1b1b1b", borderRadius: 8, fontSize: 12 }}
              formatter={(value: unknown) => [usd(Number(value)), t("dashboard.statTvl")]}
              cursor={false}
            />
            <Bar dataKey="tvl" radius={[6, 6, 0, 0]} activeBar={{ stroke: "#ffffff", strokeWidth: 2 }}>
              {data.map((_, i) => (
                <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function ChartShell({ title, subtitle, isLoading, empty, children }: {
  title: string;
  subtitle: React.ReactNode;
  isLoading: boolean;
  empty: boolean;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="glass rounded-2xl p-6 sm:p-8">
      <h3 className="text-base font-semibold tracking-tight" style={{ fontFamily: "var(--font-display)" }}>
        {title}
      </h3>
      <p className="mt-1 text-sm text-muted">{subtitle}</p>
      {isLoading && (
        <p className="mt-8 font-mono text-[11px] uppercase tracking-[0.14em] text-muted">{t("dashboard.scanning")}</p>
      )}
      {!isLoading && empty && <p className="mt-8 text-sm text-muted">{t("dashboard.noDataYet")}</p>}
      {!isLoading && !empty && <div className="mt-6" style={{ width: "100%", height: 240 }}>{children}</div>}
    </div>
  );
}

function VolumeSeriesChart({
  events,
  granularity,
  isLoading,
}: {
  events: { timestamp: number; usd: number }[];
  granularity: Granularity;
  isLoading: boolean;
}) {
  const { t } = useTranslation();
  const data = bucketByTime(events, (e) => e.timestamp, (e) => e.usd, granularity).map((b) => ({
    label: b.label,
    value: Number(b.value.toFixed(2)),
  }));
  return (
    <ChartShell
      title={t("dashboard.volumeTitle")}
      subtitle={
        <>
          {t("dashboard.volumeSubtitlePre")}
          <span className="text-accent">{t("dashboard.volumeSubtitleHighlight")}</span>
        </>
      }
      isLoading={isLoading}
      empty={data.length === 0}
    >
      <ResponsiveContainer minWidth={200} minHeight={200}>
        <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1b1b1b" />
          <XAxis dataKey="label" stroke="#71717a" fontSize={11} tickLine={false} />
          <YAxis stroke="#71717a" fontSize={11} tickLine={false} tickFormatter={(v) => usd(Number(v))} />
          <Tooltip
            contentStyle={{ background: "#0a0a0a", border: "1px solid #1b1b1b", borderRadius: 8, fontSize: 12 }}
            formatter={(value: unknown) => [usd(Number(value)), t("dashboard.tooltipVolume")]}
            cursor={false}
          />
          <Bar
            dataKey="value"
            fill="#fcff52"
            radius={[6, 6, 0, 0]}
            activeBar={{ fill: "#fff7a8", stroke: "#ffffff", strokeWidth: 2 }}
          />
        </BarChart>
      </ResponsiveContainer>
    </ChartShell>
  );
}

function FeesSeriesChart({
  events,
  granularity,
  isLoading,
}: {
  events: { timestamp: number; ownerUsd: number; platformUsd: number }[];
  granularity: Granularity;
  isLoading: boolean;
}) {
  const { t } = useTranslation();
  const owner = bucketByTime(events, (e) => e.timestamp, (e) => e.ownerUsd, granularity);
  const platform = bucketByTime(events, (e) => e.timestamp, (e) => e.platformUsd, granularity);
  const labels = [...new Set([...owner.map((b) => b.label), ...platform.map((b) => b.label)])];
  const ownerMap = new Map(owner.map((b) => [b.label, b.value]));
  const platformMap = new Map(platform.map((b) => [b.label, b.value]));
  const data = labels.map((label) => ({
    label,
    owner: Number((ownerMap.get(label) ?? 0).toFixed(2)),
    platform: Number((platformMap.get(label) ?? 0).toFixed(2)),
  }));

  return (
    <ChartShell title={t("dashboard.feesTitle")} subtitle={t("dashboard.feesSubtitle")} isLoading={isLoading} empty={data.length === 0}>
      <ResponsiveContainer minWidth={200} minHeight={200}>
        <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1b1b1b" />
          <XAxis dataKey="label" stroke="#71717a" fontSize={11} tickLine={false} />
          <YAxis stroke="#71717a" fontSize={11} tickLine={false} tickFormatter={(v) => usd(Number(v))} />
          <Tooltip
            contentStyle={{ background: "#0a0a0a", border: "1px solid #1b1b1b", borderRadius: 8, fontSize: 12 }}
            formatter={(value: unknown, name: unknown) => [
              usd(Number(value)),
              name === "owner" ? t("dashboard.tooltipOwner") : t("dashboard.tooltipPlatform"),
            ]}
            cursor={false}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Bar
            dataKey="owner"
            stackId="fees"
            fill="#4ade80"
            radius={[0, 0, 0, 0]}
            activeBar={{ stroke: "#ffffff", strokeWidth: 2 }}
          />
          <Bar
            dataKey="platform"
            stackId="fees"
            fill="#60a5fa"
            radius={[6, 6, 0, 0]}
            activeBar={{ stroke: "#ffffff", strokeWidth: 2 }}
          />
        </BarChart>
      </ResponsiveContainer>
    </ChartShell>
  );
}

function RebalanceSeriesChart({
  events,
  granularity,
  isLoading,
}: {
  events: { timestamp: number; gasReimbursedUsd: number }[];
  granularity: Granularity;
  isLoading: boolean;
}) {
  const { t } = useTranslation();
  const data = bucketByTime(events, (e) => e.timestamp, () => 1, granularity).map((b) => ({
    label: b.label,
    count: b.count,
  }));
  return (
    <ChartShell
      title={t("dashboard.rebalancesTitle")}
      subtitle={
        <>
          {t("dashboard.rebalancesSubtitlePre")}
          <span className="text-accent">{t("dashboard.rebalancesSubtitleHighlight")}</span>
        </>
      }
      isLoading={isLoading}
      empty={data.length === 0}
    >
      <ResponsiveContainer minWidth={200} minHeight={200}>
        <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1b1b1b" />
          <XAxis dataKey="label" stroke="#71717a" fontSize={11} tickLine={false} />
          <YAxis stroke="#71717a" fontSize={11} tickLine={false} allowDecimals={false} />
          <Tooltip
            contentStyle={{ background: "#0a0a0a", border: "1px solid #1b1b1b", borderRadius: 8, fontSize: 12 }}
            formatter={(value: unknown) => [Number(value), t("dashboard.tooltipRebalances")]}
          />
          <Area type="monotone" dataKey="count" stroke="#fcff52" fill="#fcff52" fillOpacity={0.25} />
        </AreaChart>
      </ResponsiveContainer>
    </ChartShell>
  );
}

function VaultStatusChart({ metrics }: { metrics: ReturnType<typeof useProtocolMetrics> }) {
  const { t } = useTranslation();
  const data = metrics.chains.map((c) => {
    const counts = metrics.vaultCountsByChain[c.id] ?? { total: 0, withPosition: 0, closed: 0 };
    return {
      label: c.name,
      activos: counts.withPosition,
      sinPosicion: counts.total - counts.withPosition - counts.closed,
      cerrados: counts.closed,
    };
  });
  const empty = data.every((d) => d.activos + d.sinPosicion + d.cerrados === 0);

  return (
    <ChartShell
      title={t("dashboard.vaultsByStatusTitle")}
      subtitle={t("dashboard.vaultsByStatusSubtitle")}
      isLoading={metrics.snapshotLoading}
      empty={empty}
    >
      <ResponsiveContainer minWidth={200} minHeight={200}>
        <BarChart data={data} layout="vertical" margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1b1b1b" />
          <XAxis type="number" stroke="#71717a" fontSize={11} tickLine={false} allowDecimals={false} />
          <YAxis type="category" dataKey="label" stroke="#71717a" fontSize={11} tickLine={false} width={70} />
          <Tooltip
            contentStyle={{ background: "#0a0a0a", border: "1px solid #1b1b1b", borderRadius: 8, fontSize: 12 }}
            cursor={false}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Bar
            dataKey="activos"
            stackId="status"
            fill="#4ade80"
            name={t("dashboard.statusWithPosition")}
            activeBar={{ stroke: "#ffffff", strokeWidth: 2 }}
          />
          <Bar
            dataKey="sinPosicion"
            stackId="status"
            fill="#71717a"
            name={t("dashboard.statusNoPosition")}
            activeBar={{ stroke: "#ffffff", strokeWidth: 2 }}
          />
          <Bar
            dataKey="cerrados"
            stackId="status"
            fill="#3f3f46"
            name={t("dashboard.statusClosed")}
            radius={[0, 6, 6, 0]}
            activeBar={{ stroke: "#ffffff", strokeWidth: 2 }}
          />
        </BarChart>
      </ResponsiveContainer>
    </ChartShell>
  );
}

function statusLabels(t: ReturnType<typeof useTranslation>["t"]): Record<VaultStatus, string> {
  return {
    active: t("dashboard.statusActive"),
    no_position: t("dashboard.statusNoPositionShort"),
    closed: t("dashboard.statusClosedShort"),
  };
}
const STATUS_CLASS: Record<VaultStatus, string> = {
  active: "bg-positive/10 text-positive",
  no_position: "bg-white/5 text-muted",
  closed: "bg-white/5 text-faint",
};

function formatPrice(n: number): string {
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (n >= 1) return n.toFixed(2);
  return n.toPrecision(3);
}

const dateLocale: Record<string, string> = { es: "es", en: "en-US", pt: "pt-BR", zh: "zh-CN" };

function formatDate(ts: number, locale: string): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString(dateLocale[locale] ?? "es", { dateStyle: "medium", timeStyle: "short" });
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 8)}…${hash.slice(-6)}`;
}

// Same "Xd Yh Zm" shape as VaultDetail.tsx's VaultAgeStat.
function formatAge(totalSeconds: number): string {
  const d = Math.floor(totalSeconds / 86400);
  const h = Math.floor((totalSeconds % 86400) / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// Same click-to-copy + explorer-link pattern as create/page.tsx's pool
// address row — kept local (not shared) since the two live in unrelated
// pages and the id/wording differ (pool vs vault).
function VaultAddressCell({
  address,
  explorerBaseUrl,
  t,
}: {
  address: string;
  explorerBaseUrl: string;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="flex items-center gap-2 font-mono text-[11px] text-muted">
      <button
        type="button"
        onClick={async () => {
          await navigator.clipboard.writeText(address);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="transition-colors hover:text-accent"
        title={t("dashboard.copyVaultAddress")}
      >
        {copied ? t("dashboard.copiedAddress") : shortHash(address)}
      </button>
      <a
        href={`${explorerBaseUrl}/address/${address}`}
        target="_blank"
        rel="noopener noreferrer"
        className="transition-colors hover:text-accent"
        title={t("dashboard.viewVaultExplorer")}
      >
        ↗
      </a>
    </div>
  );
}

/**
 * A <th> that IS its own filter: the visible header text is the select's
 * currently chosen option, so picking a value replaces the column name with
 * what's now being filtered on — no separate filter toolbar needed. The
 * first option (value "all") is always the plain column name.
 */
function FilterHeader({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  const active = value !== "all";
  return (
    <th className="px-4 py-3 font-normal text-left">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`cursor-pointer bg-transparent font-mono text-[10px] uppercase tracking-[0.12em] outline-none ${active ? "text-accent" : "text-faint"}`}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} className="bg-background normal-case text-white">
            {o.label}
          </option>
        ))}
      </select>
    </th>
  );
}

function SortableHeader({
  column,
  sortKey,
  sortDir,
  onClick,
}: {
  column: { key: SortKey; label: string; align: "left" | "right" };
  sortKey: SortKey;
  sortDir: "asc" | "desc";
  onClick: (key: SortKey) => void;
}) {
  const active = sortKey === column.key;
  return (
    <th className={`px-4 py-3 font-normal ${column.align === "right" ? "text-right" : "text-left"}`}>
      <button
        onClick={() => onClick(column.key)}
        className={`inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.12em] transition-colors hover:text-white ${active ? "text-accent" : "text-faint"}`}
      >
        {column.label}
        <span className="text-[9px]">{active ? (sortDir === "desc" ? "▼" : "▲") : "↕"}</span>
      </button>
    </th>
  );
}

/**
 * "Historial de vaults" — every vault ever created, across every chain, in
 * one chronological (newest-first) list: pool pair + fee tier, protocol
 * version, live value, range, fees generated, coarse yield, chain, creation
 * hash. Everything vaultRows already carries from useProtocolMetrics — this
 * component is purely presentational.
 */
type SortKey = "createdAt" | "valueUsd" | "feesUsd" | "yieldPct" | "rangeWidthPct" | "rebalanceCount";

function sortableColumns(
  t: ReturnType<typeof useTranslation>["t"],
): { key: SortKey; label: string; align: "left" | "right" }[] {
  return [
    { key: "createdAt", label: t("dashboard.colDate"), align: "left" },
    { key: "valueUsd", label: t("dashboard.colValue"), align: "right" },
    { key: "feesUsd", label: t("dashboard.colFees"), align: "right" },
    { key: "yieldPct", label: t("dashboard.colYield"), align: "right" },
    { key: "rangeWidthPct", label: t("dashboard.colRangeWidth"), align: "right" },
    { key: "rebalanceCount", label: t("dashboard.colRebalances"), align: "right" },
  ];
}

// rangeWidthPct isn't a real field on VaultRow (it's derived from
// priceRange for display), so sorting needs a getter instead of the
// direct row[sortKey] index the other columns use.
function sortValue(row: VaultRow, key: SortKey): number {
  if (key === "rangeWidthPct") {
    if (!row.priceRange || row.priceRange[1] <= 0) return -1;
    return ((row.priceRange[1] - row.priceRange[0]) / row.priceRange[1]) * 100;
  }
  return row[key];
}

function VaultHistoryTable({
  rows,
  isLoading,
  snapshotLoading,
  eventsLoading,
}: {
  rows: VaultRow[];
  isLoading: boolean;
  snapshotLoading: boolean;
  eventsLoading: boolean;
}) {
  const { setSelectedChainId } = useSelectedChain();
  const { t, locale } = useTranslation();
  const SORTABLE_COLUMNS = sortableColumns(t);
  const STATUS_LABEL = statusLabels(t);
  // One shared ticking clock for the whole table's Antigüedad column,
  // instead of a per-row interval — same "Xd Yh Zm" live counter as
  // VaultDetail.tsx's VaultAgeStat, just driven off createdAt rows already
  // carry (no extra per-vault fetch needed here).
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  const [statusFilter, setStatusFilter] = useState<VaultStatus | "all">("all");
  const [poolRangeFilter, setPoolRangeFilter] = useState<"all" | "in" | "out" | "none">("all");
  const [chainFilter, setChainFilter] = useState<string>("all");
  const [poolFilter, setPoolFilter] = useState<string>("all");
  const [versionFilter, setVersionFilter] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>("createdAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const chainOptions = [...new Map(rows.map((r) => [String(r.chain.id), r.chain.name])).entries()];
  const poolOptions = [...new Set(rows.map((r) => r.poolLabel))];
  // Every vault runs Uniswap V3 today — kept as a real filter (not hardcoded
  // to one option) so a future protocol version shows up here automatically.
  const versionOptions = ["Uniswap V3"];

  const filteredRows = rows
    .filter((r) => r.status !== "no_position")
    .filter((r) => statusFilter === "all" || r.status === statusFilter)
    .filter((r) => {
      if (poolRangeFilter === "all") return true;
      if (poolRangeFilter === "none") return r.inRange === null;
      if (poolRangeFilter === "in") return r.inRange === true;
      return r.inRange === false;
    })
    .filter((r) => chainFilter === "all" || String(r.chain.id) === chainFilter)
    .filter((r) => poolFilter === "all" || r.poolLabel === poolFilter)
    .filter(() => versionFilter === "all" || versionFilter === "Uniswap V3")
    .sort((a, b) =>
      sortDir === "desc" ? sortValue(b, sortKey) - sortValue(a, sortKey) : sortValue(a, sortKey) - sortValue(b, sortKey),
    );

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  return (
    <div className="glass mt-10 rounded-2xl p-6 sm:p-8">
      <h2 className="text-xl font-semibold tracking-tight" style={{ fontFamily: "var(--font-display)" }}>
        {t("dashboard.historyTitle")}
      </h2>
      <p className="mt-1 text-sm text-muted">{t("dashboard.historySubtitle")}</p>

      {isLoading && rows.length === 0 && (
        <p className="mt-8 font-mono text-[11px] uppercase tracking-[0.14em] text-muted">{t("dashboard.scanning")}</p>
      )}
      {!isLoading && rows.length === 0 && <p className="mt-8 text-sm text-muted">{t("dashboard.noVaultsYet")}</p>}
      {rows.length > 0 && filteredRows.length === 0 && (
        <p className="mt-8 text-sm text-muted">{t("dashboard.noneMatchFilters")}</p>
      )}

      {filteredRows.length > 0 && (
        <div className="mt-6 max-h-[640px] overflow-auto rounded-xl border border-hairline">
          <table className="w-full min-w-[920px] border-collapse text-sm">
            <thead className="sticky top-0 z-10" style={{ backgroundColor: "#0a0a0a" }}>
              <tr className="border-b border-hairline text-left font-mono text-[10px] uppercase tracking-[0.12em] text-faint">
                <SortableHeader column={SORTABLE_COLUMNS[0]} sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} />
                <th className="px-4 py-3 font-normal">{t("dashboard.colAge")}</th>
                <FilterHeader
                  value={chainFilter}
                  onChange={setChainFilter}
                  options={[{ value: "all", label: t("dashboard.colChain") }, ...chainOptions.map(([id, name]) => ({ value: id, label: name }))]}
                />
                <FilterHeader
                  value={poolFilter}
                  onChange={setPoolFilter}
                  options={[{ value: "all", label: t("dashboard.colPool") }, ...poolOptions.map((p) => ({ value: p, label: p }))]}
                />
                <th className="px-4 py-3 font-normal">{t("dashboard.colVault")}</th>
                <FilterHeader
                  value={versionFilter}
                  onChange={setVersionFilter}
                  options={[{ value: "all", label: t("dashboard.colVersion") }, ...versionOptions.map((v) => ({ value: v, label: v }))]}
                />
                <th className="px-4 py-3 font-normal">{t("dashboard.colRange")}</th>
                <SortableHeader column={SORTABLE_COLUMNS[4]} sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} />
                <FilterHeader
                  value={poolRangeFilter}
                  onChange={(v) => setPoolRangeFilter(v as "all" | "in" | "out" | "none")}
                  options={[
                    { value: "all", label: t("dashboard.colPoolRange") },
                    { value: "in", label: t("vaults.inRange") },
                    { value: "out", label: t("vaults.outOfRange") },
                    { value: "none", label: t("vaults.noPosition") },
                  ]}
                />
                <SortableHeader column={SORTABLE_COLUMNS[1]} sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} />
                <SortableHeader column={SORTABLE_COLUMNS[2]} sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} />
                <SortableHeader column={SORTABLE_COLUMNS[3]} sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} />
                <SortableHeader column={SORTABLE_COLUMNS[5]} sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} />
                <FilterHeader
                  value={statusFilter}
                  onChange={(v) => setStatusFilter(v as VaultStatus | "all")}
                  options={[
                    { value: "all", label: t("dashboard.colStatus") },
                    ...(["active", "closed"] as VaultStatus[]).map((s) => ({ value: s, label: STATUS_LABEL[s] })),
                  ]}
                />
                <th className="px-4 py-3 font-normal">{t("dashboard.colHash")}</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((row) => (
                <tr key={`${row.chain.id}-${row.address}`} className="border-b border-hairline/60 last:border-0 hover:bg-white/[0.02]">
                  <td className="whitespace-nowrap px-4 py-3 font-mono text-[11px] text-muted">{formatDate(row.createdAt, locale)}</td>
                  <td className="whitespace-nowrap px-4 py-3 font-mono text-[11px] tabular-nums text-muted">
                    {formatAge(Math.max(0, now - row.createdAt))}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">{row.chain.name}</td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <Link
                      href={`/vault/${row.address}`}
                      onClick={() => setSelectedChainId(row.chain.id)}
                      className="text-white/90 underline-offset-4 hover:text-accent hover:underline"
                    >
                      {row.poolLabel}
                    </Link>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <VaultAddressCell address={row.address} explorerBaseUrl={row.chain.explorerBaseUrl} t={t} />
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 font-mono text-[11px] text-faint">Uniswap V3</td>
                  <td className="whitespace-nowrap px-4 py-3 font-mono text-[11px] text-muted">
                    {snapshotLoading
                      ? "…"
                      : row.priceRange
                        ? `$${formatPrice(row.priceRange[0])} – $${formatPrice(row.priceRange[1])}`
                        : "—"}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right font-mono text-[11px] tabular-nums text-muted">
                    {snapshotLoading
                      ? "…"
                      : row.priceRange && row.priceRange[1] > 0
                        ? `${sortValue(row, "rangeWidthPct").toFixed(2)}%`
                        : "—"}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    {snapshotLoading ? (
                      "…"
                    ) : row.inRange === null ? (
                      <span className="font-mono text-[11px] text-faint">—</span>
                    ) : (
                      <span
                        className={`rounded-full px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.08em] ${
                          row.inRange ? "bg-positive/10 text-positive" : "bg-negative/10 text-negative"
                        }`}
                      >
                        {row.inRange ? t("vaults.inRange") : t("vaults.outOfRange")}
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">
                    {snapshotLoading ? "…" : usd(row.valueUsd)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-positive">
                    {eventsLoading ? "…" : usd(row.feesUsd)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">
                    {eventsLoading || snapshotLoading ? "…" : row.valueUsd > 0 ? `${row.yieldPct.toFixed(2)}%` : "—"}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">
                    {snapshotLoading ? "…" : row.rebalanceCount}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <span className={`rounded-full px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.08em] ${STATUS_CLASS[row.status]}`}>
                      {STATUS_LABEL[row.status]}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    {row.txHash ? (
                      <a
                        href={`${row.chain.explorerBaseUrl}/tx/${row.txHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono text-[11px] text-muted underline-offset-4 hover:text-accent hover:underline"
                      >
                        {shortHash(row.txHash)} ↗
                      </a>
                    ) : (
                      <span className="font-mono text-[11px] text-faint">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
