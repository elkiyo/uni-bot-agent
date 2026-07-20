"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useAccount, useReadContracts } from "wagmi";
import { isAddress } from "viem";
import { Header } from "../../components/Header";
import { platformConfigAbi } from "@/lib/contracts";
import { useSelectedChain, useAvailableChains } from "@/lib/useSelectedChain";
import { useTranslation } from "@/lib/i18n/useTranslation";
import { getChain } from "@/lib/chains";

interface OverviewRow {
  referrer: string;
  totalReferred: number;
  activeCount: number;
  lastReferredAt: string;
  liquidatedByToken: Record<string, number>;
}

interface VolumeByChain {
  chainId: number;
  chainName: string;
  tokenSymbol: string;
  totalDeposited: number;
  vaultCount: number;
  hasDeposit: boolean;
}

interface ReferralRow {
  id: number;
  referrer: string;
  referred: string;
  created_at: string;
  activated_at: string | null;
  volumeByChain: VolumeByChain[];
}

interface LiquidationRow {
  id: number;
  amount: string;
  token_symbol: string;
  chain_id: number;
  chain_name: string;
  tx_hash: string;
  notes: string | null;
  created_at: string;
}

interface StatsResponse {
  referrals: ReferralRow[];
  liquidations: LiquidationRow[];
  grandTotalByToken: Record<string, number>;
  activeCount: number;
  totalCount: number;
}

function truncate(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export default function AdminReferralsPage() {
  const { address: connected } = useAccount();
  const { selectedChain: chain } = useSelectedChain();
  const availableChains = useAvailableChains();
  const { t } = useTranslation();

  // Same client-side owner gate as /admin — see that page's `isPlatformOwner`.
  const { data } = useReadContracts({
    contracts: [
      { address: chain.platformConfigAddress || undefined, abi: platformConfigAbi, functionName: "owner", chainId: chain.id },
    ],
    query: { enabled: Boolean(chain.platformConfigAddress) },
  });
  const owner = data?.[0]?.result as string | undefined;
  const isPlatformOwner = Boolean(connected && owner && connected.toLowerCase() === owner.toLowerCase());

  const [overview, setOverview] = useState<OverviewRow[] | null>(null);
  const [rowVolume, setRowVolume] = useState<Record<string, Record<string, number>>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<StatsResponse | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!isPlatformOwner) return;
    fetch("/api/admin/referral-overview")
      .then((res) => res.json())
      .then((body) => setOverview(body.overview ?? []))
      .catch(() => setOverview([]));
  }, [isPlatformOwner]);

  // Overview itself is DB-only (fast); per-row on-chain volume is fetched
  // separately, in parallel, so it never blocks the table's initial render —
  // see Promtp_sis_referrers/promt_sis_ref.md §5.
  useEffect(() => {
    if (!overview || overview.length === 0) return;
    Promise.allSettled(
      overview.map(async (row) => {
        const res = await fetch(`/api/referral/stats?referrer=${row.referrer}`);
        if (!res.ok) throw new Error("failed");
        const body: StatsResponse = await res.json();
        return { referrer: row.referrer, totals: body.grandTotalByToken };
      }),
    ).then((results) => {
      const next: Record<string, Record<string, number>> = {};
      for (const r of results) {
        if (r.status === "fulfilled") next[r.value.referrer] = r.value.totals;
      }
      setRowVolume(next);
    });
  }, [overview]);

  useEffect(() => {
    // No reset-to-null branch here on purpose: the detail panel below only
    // renders when `selected` is truthy, so a stale `detail` from a
    // previously selected referrer is simply never shown once deselected.
    if (!selected) return;
    fetch(`/api/referral/stats?referrer=${selected}`)
      .then((res) => res.json())
      .then(setDetail)
      .catch(() => setDetail(null));
  }, [selected]);

  const totals = useMemo(() => {
    if (!overview) return null;
    return {
      referrers: overview.length,
      referred: overview.reduce((s, r) => s + r.totalReferred, 0),
      active: overview.reduce((s, r) => s + r.activeCount, 0),
    };
  }, [overview]);

  function formatTotals(totalsByToken: Record<string, number>): string {
    const entries = Object.entries(totalsByToken);
    if (entries.length === 0) return "—";
    return entries.map(([sym, amt]) => `${amt.toFixed(2)} ${sym}`).join(" + ");
  }

  if (!connected || !isPlatformOwner) {
    return (
      <>
        <Header />
        <main className="section flex-1 pb-24 pt-32">
          <div className="glass mt-10 rounded-2xl p-8 text-center">
            <p className="text-sm text-muted">{t("adminReferrals.ownerOnly")}</p>
          </div>
        </main>
      </>
    );
  }

  return (
    <>
      <Header />
      <main className="section flex-1 pb-24 pt-32">
        <Link href="/admin" className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted hover:text-white">
          {t("adminReferrals.backToAdmin")}
        </Link>
        <h1
          className="mt-4 text-3xl font-semibold leading-[1.12] tracking-tight sm:text-4xl"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {t("adminReferrals.title")}
        </h1>
        <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-muted">{t("adminReferrals.subtitle")}</p>

        <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Stat label={t("adminReferrals.statReferrers")} value={totals ? String(totals.referrers) : "…"} />
          <Stat label={t("adminReferrals.statReferred")} value={totals ? String(totals.referred) : "…"} />
          <Stat label={t("adminReferrals.statActive")} value={totals ? String(totals.active) : "…"} accent />
        </div>

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <input
            className="field-input max-w-sm"
            placeholder={t("adminReferrals.searchPlaceholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button
            className="btn-secondary !px-4 !py-2.5"
            disabled={!isAddress(search)}
            onClick={() => setSelected(search.toLowerCase())}
          >
            {t("adminReferrals.searchButton")}
          </button>
        </div>

        <div className="glass mt-6 overflow-x-auto rounded-2xl p-2">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-[0.12em] text-muted">
                <th className="px-4 py-3">{t("adminReferrals.colWallet")}</th>
                <th className="px-4 py-3">{t("adminReferrals.colReferred")}</th>
                <th className="px-4 py-3">{t("adminReferrals.colActive")}</th>
                <th className="px-4 py-3">{t("adminReferrals.colActivation")}</th>
                <th className="px-4 py-3">{t("adminReferrals.colVolume")}</th>
                <th className="px-4 py-3">{t("adminReferrals.colLiquidated")}</th>
                <th className="px-4 py-3">{t("adminReferrals.colLastReferral")}</th>
              </tr>
            </thead>
            <tbody>
              {overview === null && (
                <tr>
                  <td className="px-4 py-4 text-muted" colSpan={7}>
                    {t("admin.loading")}
                  </td>
                </tr>
              )}
              {overview?.length === 0 && (
                <tr>
                  <td className="px-4 py-4 text-muted" colSpan={7}>
                    {t("adminReferrals.none")}
                  </td>
                </tr>
              )}
              {overview?.map((row) => {
                const pct = row.totalReferred > 0 ? Math.round((row.activeCount / row.totalReferred) * 100) : 0;
                return (
                  <tr
                    key={row.referrer}
                    onClick={() => setSelected(row.referrer)}
                    className={`cursor-pointer border-t border-white/5 transition-colors hover:bg-white/[0.03] ${
                      selected === row.referrer ? "bg-accent/[0.05]" : ""
                    }`}
                  >
                    <td className="px-4 py-3 font-mono text-xs">{truncate(row.referrer)}</td>
                    <td className="px-4 py-3">{row.totalReferred}</td>
                    <td className="px-4 py-3">{row.activeCount}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-full px-2 py-0.5 font-mono text-[10px] ${
                          pct >= 50 ? "bg-accent/[0.12] text-accent" : "bg-white/[0.06] text-muted"
                        }`}
                      >
                        {pct}%
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs">{formatTotals(rowVolume[row.referrer] ?? {})}</td>
                    <td className="px-4 py-3 text-xs">{formatTotals(row.liquidatedByToken)}</td>
                    <td className="px-4 py-3 text-xs text-muted">
                      {new Date(row.lastReferredAt).toLocaleDateString()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {selected && detail && (
          <ReferrerDetail
            referrer={selected}
            detail={detail}
            availableChains={availableChains}
            onLiquidated={() => {
              // Refresh both the detail panel and the table's liquidated column.
              fetch(`/api/referral/stats?referrer=${selected}`).then((res) => res.json()).then(setDetail);
              fetch("/api/admin/referral-overview")
                .then((res) => res.json())
                .then((body) => setOverview(body.overview ?? []));
            }}
            t={t}
          />
        )}
      </main>
    </>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={accent ? "glass rounded-2xl border-accent/35 bg-accent/[0.06] p-5" : "glass rounded-2xl p-5"}>
      <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">{label}</span>
      <p
        className={`mt-2 text-lg font-semibold tabular-nums ${accent ? "text-accent" : "text-white/90"}`}
        style={{ fontFamily: "var(--font-display)" }}
      >
        {value}
      </p>
    </div>
  );
}

function exportCsv(referrer: string, detail: StatsResponse) {
  const header = "referred,created_at,activated_at,chain,token,total_deposited\n";
  const lines: string[] = [];
  for (const r of detail.referrals) {
    if (r.volumeByChain.length === 0) {
      lines.push(`${r.referred},${r.created_at},${r.activated_at ?? ""},,,`);
      continue;
    }
    for (const v of r.volumeByChain) {
      lines.push(
        `${r.referred},${r.created_at},${r.activated_at ?? ""},${v.chainName},${v.tokenSymbol},${v.totalDeposited}`,
      );
    }
  }
  const blob = new Blob([header + lines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `referrals-${referrer}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function ReferrerDetail({
  referrer,
  detail,
  availableChains,
  onLiquidated,
  t,
}: {
  referrer: string;
  detail: StatsResponse;
  availableChains: { id: number; name: string; stableSymbol: string }[];
  onLiquidated: () => void;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  const [amount, setAmount] = useState("");
  const [chainId, setChainId] = useState(availableChains[0]?.id ?? 0);
  const [txHash, setTxHash] = useState("");
  const [notes, setNotes] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chainDef = availableChains.find((c) => c.id === chainId) ?? availableChains[0];

  async function submitLiquidation() {
    if (!chainDef) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/referral/liquidation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          referrer,
          amount,
          tokenSymbol: chainDef.stableSymbol,
          chainId: chainDef.id,
          chainName: chainDef.name,
          txHash,
          notes: notes || undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "error");
        return;
      }
      setAmount("");
      setTxHash("");
      setNotes("");
      setConfirming(false);
      onLiquidated();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="glass mt-6 rounded-2xl p-6 sm:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-faint">
            {t("adminReferrals.detailFor")}
          </span>
          <p className="mt-1 break-all font-mono text-sm text-white/90">{referrer}</p>
        </div>
        <button className="btn-secondary !px-4 !py-2.5" onClick={() => exportCsv(referrer, detail)}>
          {t("adminReferrals.exportCsv")}
        </button>
      </div>

      <div className="mt-6 flex flex-col gap-3">
        {detail.referrals.map((r) => (
          <div key={r.id} className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="break-all font-mono text-xs text-white/80">{r.referred}</span>
              <span
                className={`rounded-full px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.12em] ${
                  r.activated_at ? "bg-accent/[0.12] text-accent" : "bg-white/[0.06] text-muted"
                }`}
              >
                {r.activated_at ? t("referrals.badgeActive") : t("referrals.badgeRegistered")}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {r.volumeByChain
                .filter((v) => v.vaultCount > 0)
                .map((v) => (
                  <span key={v.chainId} className="rounded-lg bg-black/30 px-2.5 py-1 text-xs text-white/70">
                    {v.chainName}: {v.totalDeposited.toFixed(2)} {v.tokenSymbol}
                  </span>
                ))}
            </div>
          </div>
        ))}
      </div>

      <h3 className="mt-8 font-mono text-[11px] uppercase tracking-[0.14em] text-faint">
        {t("adminReferrals.liquidationHistory")}
      </h3>
      <div className="mt-3 flex flex-col gap-2">
        {detail.liquidations.length === 0 && <p className="text-sm text-muted">{t("adminReferrals.noLiquidations")}</p>}
        {detail.liquidations.map((l) => (
          <div key={l.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-black/30 px-3 py-2 text-xs">
            <span>
              {l.amount} {l.token_symbol} · {l.chain_name}
            </span>
            <a
              href={`${getChain(l.chain_id).explorerBaseUrl}/tx/${l.tx_hash}`}
              target="_blank"
              rel="noreferrer"
              className="text-accent hover:underline"
            >
              {truncate(l.tx_hash)}
            </a>
            <span className="text-muted">{new Date(l.created_at).toLocaleDateString()}</span>
            {l.notes && <span className="w-full text-muted">{l.notes}</span>}
          </div>
        ))}
      </div>

      <div className="mt-8 border-t border-hairline pt-6">
        <h3 className="font-mono text-[11px] uppercase tracking-[0.14em] text-faint">
          {t("adminReferrals.newLiquidation")}
        </h3>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
              {t("adminReferrals.fieldAmount")}
            </span>
            <input className="field-input" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
              {t("adminReferrals.fieldChain")}
            </span>
            <select
              className="field-input"
              value={chainId}
              onChange={(e) => setChainId(Number(e.target.value))}
            >
              {availableChains.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.stableSymbol})
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5 sm:col-span-2">
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
              {t("adminReferrals.fieldTxHash")}
            </span>
            <input className="field-input" value={txHash} onChange={(e) => setTxHash(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1.5 sm:col-span-2">
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
              {t("adminReferrals.fieldNotes")}
            </span>
            <input className="field-input" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </label>
        </div>

        {error && <p className="mt-3 text-sm text-negative">{error}</p>}

        {!confirming && (
          <button
            className="btn-primary mt-4 !px-5 !py-2.5"
            disabled={!amount || !txHash || !chainDef}
            onClick={() => setConfirming(true)}
          >
            {t("adminReferrals.registerPayment")}
          </button>
        )}
        {confirming && chainDef && (
          <div className="mt-4 rounded-xl border border-accent/35 bg-accent/[0.06] p-4">
            <p className="text-sm text-white/90">
              {t("adminReferrals.confirmSummary", {
                amount,
                token: chainDef.stableSymbol,
                referrer: truncate(referrer),
                chain: chainDef.name,
              })}
            </p>
            <div className="mt-3 flex gap-3">
              <button className="btn-primary !px-4 !py-2.5" disabled={submitting} onClick={submitLiquidation}>
                {submitting ? t("adminReferrals.submitting") : t("adminReferrals.confirmButton")}
              </button>
              <button className="btn-secondary !px-4 !py-2.5" disabled={submitting} onClick={() => setConfirming(false)}>
                {t("adminReferrals.cancelButton")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
