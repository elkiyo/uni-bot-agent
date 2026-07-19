"use client";

import { useEffect, useState } from "react";
import type { Address } from "viem";
import { usePublicClient } from "wagmi";
import { fetchMintVolumeEvents, type MintVolumeEvent } from "@/lib/dashboard/mintVolume";
import type { ChainDef } from "@/lib/chains";

type Granularity = "day" | "week" | "month" | "year";
type VolumeEvent = MintVolumeEvent;

/**
 * "Volumen movido por el agente" — the USD value of every position the
 * agent built for this vault list, one entry per initPosition()/rebalance()
 * (each mints a fresh position). See lib/dashboard/mintVolume.ts (shared
 * with the protocol-wide dashboard) for how each mint's value is
 * reconstructed as of its own block.
 */
export function VolumeChart({ vaultAddresses, chain }: { vaultAddresses: Address[]; chain: ChainDef }) {
  const publicClient = usePublicClient({ chainId: chain.id });
  const [events, setEvents] = useState<VolumeEvent[] | null>(null);
  const [granularity, setGranularity] = useState<Granularity>("day");

  useEffect(() => {
    if (!publicClient || vaultAddresses.length === 0) return;
    let cancelled = false;

    fetchMintVolumeEvents(publicClient, chain, vaultAddresses)
      .then((results) => {
        if (!cancelled) setEvents(results);
      })
      .catch((err) => console.error("volume chart scan failed", err));

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- vaultAddresses is a derived array, re-created every render; length is enough here
  }, [publicClient, vaultAddresses.length, chain.factoryDeployBlock]);

  return (
    <div className="glass mt-8 rounded-2xl p-6 sm:p-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight" style={{ fontFamily: "var(--font-display)" }}>
            Volumen movido por el <span className="text-accent">agente</span>
          </h2>
          <p className="mt-1 text-sm text-muted">
            Valor de cada posición armada — cada apertura y cada rebalanceo mueve capital real.
          </p>
        </div>
        <div className="flex gap-1.5 rounded-full border border-hairline p-1">
          {(["day", "week", "month", "year"] as const).map((g) => (
            <button
              key={g}
              onClick={() => setGranularity(g)}
              className={
                granularity === g
                  ? "rounded-full bg-accent px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.1em] text-background"
                  : "rounded-full px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.1em] text-muted hover:text-white"
              }
            >
              {{ day: "Diario", week: "Semanal", month: "Mensual", year: "Anual" }[g]}
            </button>
          ))}
        </div>
      </div>

      {events === null && (
        <p className="mt-8 font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
          Escaneando eventos on-chain…
        </p>
      )}
      {events && events.length === 0 && (
        <p className="mt-8 text-sm text-muted">Todavía no hay posiciones armadas para graficar.</p>
      )}
      {events && events.length > 0 && <BarChart events={events} granularity={granularity} />}
    </div>
  );
}

function bucketKey(ts: number, granularity: Granularity): { key: string; label: string; sortKey: number } {
  const d = new Date(ts * 1000);
  if (granularity === "day") {
    const key = d.toISOString().slice(0, 10);
    return { key, label: `${d.getDate()}/${d.getMonth() + 1}`, sortKey: d.setHours(0, 0, 0, 0) };
  }
  if (granularity === "week") {
    const monday = new Date(d);
    const dow = (d.getDay() + 6) % 7; // 0 = Monday
    monday.setDate(d.getDate() - dow);
    monday.setHours(0, 0, 0, 0);
    return { key: monday.toISOString().slice(0, 10), label: `${monday.getDate()}/${monday.getMonth() + 1}`, sortKey: monday.getTime() };
  }
  if (granularity === "month") {
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const labels = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
    return { key, label: labels[d.getMonth()], sortKey: new Date(d.getFullYear(), d.getMonth(), 1).getTime() };
  }
  const key = String(d.getFullYear());
  return { key, label: key, sortKey: new Date(d.getFullYear(), 0, 1).getTime() };
}

function BarChart({ events, granularity }: { events: VolumeEvent[]; granularity: Granularity }) {
  const buckets = new Map<string, { label: string; sortKey: number; usd: number }>();
  for (const e of events) {
    const { key, label, sortKey } = bucketKey(e.timestamp, granularity);
    const existing = buckets.get(key);
    if (existing) existing.usd += e.usd;
    else buckets.set(key, { label, sortKey, usd: e.usd });
  }

  const maxPoints = { day: 14, week: 12, month: 12, year: 6 }[granularity];
  const sorted = Array.from(buckets.values())
    .sort((a, b) => a.sortKey - b.sortKey)
    .slice(-maxPoints);

  const max = Math.max(...sorted.map((b) => b.usd), 1);
  const total = sorted.reduce((sum, b) => sum + b.usd, 0);

  return (
    <div className="mt-8">
      <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-faint">
        Total del período mostrado: <span className="text-accent">${total.toFixed(2)}</span>
      </p>
      <div className="mt-4 flex items-end gap-2 overflow-x-auto pb-2" style={{ minHeight: 180 }}>
        {sorted.map((b) => (
          <div key={b.label + b.sortKey} className="flex min-w-[36px] flex-1 flex-col items-center gap-2">
            <span className="font-mono text-[10px] tabular-nums text-white/70">
              {b.usd > 0 ? `$${b.usd < 10 ? b.usd.toFixed(1) : Math.round(b.usd)}` : ""}
            </span>
            <div
              className="w-full rounded-t-md bg-accent/80 transition-all"
              style={{ height: `${Math.max((b.usd / max) * 140, b.usd > 0 ? 3 : 0)}px` }}
            />
            <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-faint">{b.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
