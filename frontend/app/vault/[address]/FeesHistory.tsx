"use client";

import { formatUnits, type Abi } from "viem";
import { useVaultEventLogs } from "@/lib/useVaultEventLogs";
import type { ChainDef } from "@/lib/chains";
import { useTranslation } from "@/lib/i18n/useTranslation";

const dateLocale: Record<string, string> = { es: "es", en: "en-US", pt: "pt-BR", zh: "zh-CN" };

type RowKind = "manual" | "auto" | "reinjected";

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
  gasUsd?: bigint;
}

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

  const platformFeeByTxHash = new Map<string, { stable: bigint; volatile: bigint }>();
  const gasByTxHash = new Map<string, bigint>();
  let totalPlatformUsd = 0;
  for (const log of eventLogs ?? []) {
    if (log.eventName === "PerformanceFeeCollected") {
      const args = log.args as { amount0?: bigint; amount1?: bigint };
      const amount0 = args.amount0 ?? 0n;
      const amount1 = args.amount1 ?? 0n;
      platformFeeByTxHash.set(log.transactionHash, {
        stable: chain.stableIsToken0 ? amount0 : amount1,
        volatile: chain.stableIsToken0 ? amount1 : amount0,
      });
      totalPlatformUsd += log.usdValue ?? 0;
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

  const rows: Row[] = [];
  let totalManualUsd = 0;
  let totalAutoUsd = 0;
  let totalReinjectedUsd = 0;

  for (const log of eventLogs ?? []) {
    if (log.eventName === "LpFeesPaidToOwner" || log.eventName === "FeesCollected") {
      const args = log.args as { amount0?: bigint; amount1?: bigint };
      const amount0 = args.amount0 ?? 0n;
      const amount1 = args.amount1 ?? 0n;
      const kind: RowKind = log.eventName === "FeesCollected" ? "manual" : "auto";
      if (kind === "manual") totalManualUsd += log.usdValue ?? 0;
      else totalAutoUsd += log.usdValue ?? 0;
      rows.push({
        blockTimestamp: log.blockTimestamp,
        txHash: log.transactionHash,
        kind,
        amountStable: chain.stableIsToken0 ? amount0 : amount1,
        amountVolatile: chain.stableIsToken0 ? amount1 : amount0,
        usdValue: log.usdValue,
        platformFee: platformFeeByTxHash.get(log.transactionHash),
        gasUsd: gasByTxHash.get(log.transactionHash),
      });
    } else if (log.eventName === "FeesReinjected") {
      const args = log.args as { netFee0?: bigint; netFee1?: bigint; used0?: bigint; used1?: bigint; netFeeUsd?: bigint };
      const netFee0 = args.netFee0 ?? 0n;
      const netFee1 = args.netFee1 ?? 0n;
      const used0 = args.used0 ?? 0n;
      const used1 = args.used1 ?? 0n;
      const netFeeUsd = Number(formatUnits(args.netFeeUsd ?? 0n, chain.stableDecimals));
      totalReinjectedUsd += netFeeUsd;
      rows.push({
        blockTimestamp: log.blockTimestamp,
        txHash: log.transactionHash,
        kind: "reinjected",
        amountStable: chain.stableIsToken0 ? netFee0 : netFee1,
        amountVolatile: chain.stableIsToken0 ? netFee1 : netFee0,
        usdValue: netFeeUsd,
        reinjectedStable: chain.stableIsToken0 ? used0 : used1,
        reinjectedVolatile: chain.stableIsToken0 ? used1 : used0,
        positionId: positionAt(log.blockNumber),
        platformFee: platformFeeByTxHash.get(log.transactionHash),
        gasUsd: gasByTxHash.get(log.transactionHash),
      });
    }
  }

  rows.sort((a, b) => b.blockTimestamp - a.blockTimestamp); // newest first

  if (rows.length === 0) return null;

  const grandTotalUsd = totalManualUsd + totalAutoUsd + totalReinjectedUsd + totalPlatformUsd;

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

  return (
    <div className="glass mt-10 rounded-2xl p-6 sm:p-8">
      <h2 className="text-2xl font-semibold tracking-tight text-foreground" style={{ fontFamily: "var(--font-display)" }}>
        {t("feesHistory.title")}
      </h2>
      <p className="mt-1 text-sm text-muted">{t("feesHistory.subtitle")}</p>

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
    </div>
  );
}
