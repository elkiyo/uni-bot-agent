"use client";

import { useState } from "react";
import { formatUnits, type Abi } from "viem";
import { useVaultCapitalLedger } from "@/lib/useVaultCumulativeInvestment";
import type { ChainDef } from "@/lib/chains";
import { useTranslation } from "@/lib/i18n/useTranslation";

const dateLocale: Record<string, string> = { es: "es", en: "en-US", pt: "pt-BR", zh: "zh-CN" };

// t()'s key type is a literal union derived from the dictionary shape, so a
// dynamic `capitalLedger.${string}` template doesn't type-check — this maps
// each raw event name straight to its own literal t() call instead.
function eventLabel(t: ReturnType<typeof useTranslation>["t"], eventName: string): string {
  switch (eventName) {
    case "Deposited":
      return t("capitalLedger.eventDeposited");
    case "PositionIncreased":
      return t("capitalLedger.eventPositionIncreased");
    case "Rebalanced":
      return t("capitalLedger.eventRebalanced");
    case "IdleDustSwept":
      return t("capitalLedger.eventIdleDustSwept");
    case "ReinjectedIntoPosition":
      return t("capitalLedger.eventReinjectedIntoPosition");
    case "FeesReinjected":
      return t("capitalLedger.eventFeesReinjected");
    case "Withdrawn":
      return t("capitalLedger.eventWithdrawn");
    case "EmergencyWithdraw":
      return t("capitalLedger.eventEmergencyWithdraw");
    default:
      return eventName;
  }
}

/**
 * Dashboard de control de capital: cada evento on-chain que movió B1 (todo lo
 * que el owner puso, más lo que se reinyectó de reserva/comisiones, menos lo
 * retirado), en orden, con el saldo B1 acumulado justo después de cada uno —
 * ver useVaultCumulativeInvestment.ts's walkCapitalLedger para la única
 * fuente de verdad de estas reglas (kept in sync por diseño con esa función
 * y con rebalancer.ts's getCumulativeInvestmentUsd del lado del servidor).
 *
 * A1 NO aparece acá con un valor por fila a propósito: a diferencia de B1
 * (que es una suma acumulada de eventos), A1 es el valor EN VIVO de la
 * posición ahora mismo (ver PositionNFT.tsx) — no algo que estos eventos
 * pasados sumen. Mostrar "A1 en ese momento" para cada fila requeriría una
 * lectura on-chain histórica por fila (nodo archive), para un número que
 * solo tiene sentido "ahora". Lo que SÍ se muestra una sola vez, arriba de
 * la tabla, es el par A1 (en vivo)/B1 (la última fila de este mismo ledger)
 * — mismos números que las Stat cards del header de VaultDetail.tsx
 * (a1Usd/cumulativeInvestmentUsd), pasados como prop en vez de recalculados
 * acá, para que nunca puedan desincronizarse entre las dos vistas.
 */
export function CapitalLedger({
  address,
  chain,
  vaultAbi = chain.vaultAbi,
  a1Usd,
  b1Usd,
}: {
  address: `0x${string}`;
  chain: ChainDef;
  vaultAbi?: Abi;
  a1Usd?: number;
  b1Usd?: number;
}) {
  const { t, locale } = useTranslation();
  const { data: entries } = useVaultCapitalLedger(address, chain, vaultAbi);
  const [expanded, setExpanded] = useState(false);

  if (!entries || entries.length === 0) return null;

  const fmtDate = (ts: number) =>
    new Date(ts * 1000).toLocaleString(dateLocale[locale] ?? "es", { dateStyle: "short", timeStyle: "short" });
  const fmtUsd = (v: bigint) => `$${Number(formatUnits(v, chain.stableDecimals)).toFixed(2)}`;
  const deltaUsd = a1Usd !== undefined && b1Usd !== undefined ? a1Usd - b1Usd : undefined;

  // Newest first — same convention as ActivityFeed/PositionHistory.
  const rows = [...entries].reverse();

  return (
    <div className="glass mt-10 rounded-2xl p-6 sm:p-8">
      <h2 className="text-2xl font-semibold tracking-tight text-foreground" style={{ fontFamily: "var(--font-display)" }}>
        {t("capitalLedger.title")}
      </h2>
      <p className="mt-1 text-sm text-muted">{t("capitalLedger.subtitle")}</p>

      {(a1Usd !== undefined || b1Usd !== undefined) && (
        <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-hairline bg-surface-1 p-3">
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">{t("capitalLedger.summaryA1")}</p>
            <p className="mt-1 font-mono text-lg font-semibold text-accent-text">
              {a1Usd !== undefined ? `$${a1Usd.toFixed(2)}` : "—"}
            </p>
          </div>
          <div className="rounded-xl border border-hairline bg-surface-1 p-3">
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">{t("capitalLedger.summaryB1")}</p>
            <p className="mt-1 font-mono text-lg font-semibold text-foreground/90">
              {b1Usd !== undefined ? `$${b1Usd.toFixed(2)}` : "—"}
            </p>
          </div>
          <div className="rounded-xl border border-hairline bg-surface-1 p-3">
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">{t("capitalLedger.summaryDelta")}</p>
            <p className={`mt-1 font-mono text-lg font-semibold ${deltaUsd !== undefined && deltaUsd < 0 ? "text-negative" : "text-positive"}`}>
              {deltaUsd !== undefined ? `${deltaUsd >= 0 ? "+" : ""}${deltaUsd.toFixed(2)}` : "—"}
            </p>
          </div>
        </div>
      )}

      {expanded ? (
        <>
          <div className="mt-6 overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-hairline text-left">
                  <th className="whitespace-nowrap py-2 pr-4 font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-faint">
                    {t("capitalLedger.colDate")}
                  </th>
                  <th className="whitespace-nowrap py-2 pr-4 font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-faint">
                    {t("capitalLedger.colEvent")}
                  </th>
                  <th className="whitespace-nowrap py-2 pr-4 font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-faint">
                    {t("capitalLedger.colAmount")}
                  </th>
                  <th className="whitespace-nowrap py-2 font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-faint">
                    {t("capitalLedger.colRunningB1")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => {
                  const isNegative = e.deltaRaw < 0n;
                  return (
                    <tr key={`${e.txHash}-${e.blockNumber}`} className="border-b border-hairline/60 last:border-0">
                      <td className="whitespace-nowrap py-3 pr-4">
                        <div className="font-mono text-xs text-foreground/90">{fmtDate(e.timestamp)}</div>
                        <a
                          href={`${chain.explorerBaseUrl}/tx/${e.txHash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-mono text-[11px] text-faint underline-offset-4 hover:text-accent-text hover:underline"
                        >
                          {e.txHash.slice(0, 8)}…{e.txHash.slice(-6)} ↗
                        </a>
                      </td>
                      <td className="py-3 pr-4 text-foreground/90">{eventLabel(t, e.eventName)}</td>
                      <td className="whitespace-nowrap py-3 pr-4">
                        <span className={`font-mono font-semibold ${isNegative ? "text-negative" : "text-positive"}`}>
                          {isNegative ? "−" : "+"}
                          {fmtUsd(isNegative ? -e.deltaRaw : e.deltaRaw)}
                        </span>
                      </td>
                      <td className="whitespace-nowrap py-3 font-mono text-foreground/90">{fmtUsd(e.runningB1Raw)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="mt-4 rounded-full border border-hairline px-4 py-1.5 font-mono text-[11px] uppercase tracking-[0.1em] text-muted transition-colors hover:border-border-medium hover:text-foreground"
          >
            {t("capitalLedger.hideTable")}
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-5 rounded-full border border-accent-fill-border bg-accent-fill-bg px-4 py-1.5 font-mono text-[11px] uppercase tracking-[0.1em] text-accent-fill-text transition-opacity hover:opacity-90"
        >
          {t("capitalLedger.showTable")}
        </button>
      )}
    </div>
  );
}
