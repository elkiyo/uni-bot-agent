"use client";

import { formatUnits, type Abi } from "viem";
import { useVaultEventLogs } from "@/lib/useVaultEventLogs";
import type { ChainDef } from "@/lib/chains";
import { useTranslation } from "@/lib/i18n/useTranslation";

const dateLocale: Record<string, string> = { es: "es", en: "en-US", pt: "pt-BR", zh: "zh-CN" };

/**
 * Every fee payout that actually left the vault for the owner's wallet —
 * LpFeesPaidToOwner (keeper-triggered, during a rebalance/auto-claim) and
 * FeesCollected (owner's own manual "Cobrar comisiones" click). The sibling
 * to ReinjectionHistory.tsx's FeesReinjected table: that one covers fees
 * that STAYED in the vault (compound mode), this one covers fees that left
 * it — the two are mutually exclusive per transaction (autoCompoundFees
 * picks one path or the other), so a row here never double-counts a row
 * there.
 *
 * PerformanceFeeCollected (the platform's own cut) fires in the SAME
 * transaction as either payout event — matched here by tx_hash, same
 * pattern ReinjectionHistory uses for KeeperGasReimbursed — to show the
 * full picture (gross fee = what you got + what the platform took) without
 * a second event type needing its own row.
 */
export function FeesPayoutHistory({
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
  for (const log of eventLogs ?? []) {
    if (log.eventName !== "PerformanceFeeCollected") continue;
    const args = log.args as { amount0?: bigint; amount1?: bigint };
    const amount0 = args.amount0 ?? 0n;
    const amount1 = args.amount1 ?? 0n;
    platformFeeByTxHash.set(log.transactionHash, {
      stable: chain.stableIsToken0 ? amount0 : amount1,
      volatile: chain.stableIsToken0 ? amount1 : amount0,
    });
  }

  const payouts = (eventLogs ?? [])
    .filter((log) => log.eventName === "LpFeesPaidToOwner" || log.eventName === "FeesCollected")
    .map((log) => {
      const args = log.args as { amount0?: bigint; amount1?: bigint };
      const amount0 = args.amount0 ?? 0n;
      const amount1 = args.amount1 ?? 0n;
      return {
        blockTimestamp: log.blockTimestamp,
        txHash: log.transactionHash,
        manual: log.eventName === "FeesCollected",
        claimedStable: chain.stableIsToken0 ? amount0 : amount1,
        claimedVolatile: chain.stableIsToken0 ? amount1 : amount0,
        usdValue: log.usdValue,
        platformFee: platformFeeByTxHash.get(log.transactionHash),
      };
    })
    .sort((a, b) => b.blockTimestamp - a.blockTimestamp); // newest first

  if (payouts.length === 0) return null;

  const fmtDate = (ts: number) =>
    new Date(ts * 1000).toLocaleString(dateLocale[locale] ?? "es", { dateStyle: "short", timeStyle: "short" });
  const fmtStable = (v: bigint) => `${formatUnits(v, chain.stableDecimals)} ${chain.stableSymbol}`;
  const fmtVolatile = (v: bigint) => `${Number(formatUnits(v, chain.volatileDecimals)).toFixed(6)} ${chain.volatileSymbol}`;

  const totalUsd = payouts.reduce((sum, p) => sum + (p.usdValue ?? 0), 0);

  return (
    <div className="glass mt-10 rounded-2xl p-6 sm:p-8">
      <h2 className="text-2xl font-semibold tracking-tight text-foreground" style={{ fontFamily: "var(--font-display)" }}>
        {t("feesPayoutHistory.title")}
      </h2>
      <p className="mt-1 text-sm text-muted">
        {t("feesPayoutHistory.subtitle", { total: `$${totalUsd.toFixed(2)}`, count: payouts.length })}
      </p>

      <div className="mt-6 overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-hairline text-left">
              <th className="whitespace-nowrap py-2 pr-4 font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-faint">
                {t("feesPayoutHistory.colDate")}
              </th>
              <th className="whitespace-nowrap py-2 pr-4 font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-faint">
                {t("feesPayoutHistory.colSource")}
              </th>
              <th className="whitespace-nowrap py-2 pr-4 font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-faint">
                {t("feesPayoutHistory.colReceived")}
              </th>
              <th className="whitespace-nowrap py-2 pr-4 font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-faint">
                {t("feesPayoutHistory.colPlatformFee")}
              </th>
              <th className="whitespace-nowrap py-2 font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-faint">
                {t("feesPayoutHistory.colTx")}
              </th>
            </tr>
          </thead>
          <tbody>
            {payouts.map((p) => (
              <tr key={p.txHash} className="border-b border-hairline/60 last:border-0">
                <td className="whitespace-nowrap py-3 pr-4 font-mono text-xs text-foreground/90">
                  {fmtDate(p.blockTimestamp)}
                </td>
                <td className="whitespace-nowrap py-3 pr-4">
                  <span className="eyebrow !px-2 !py-0.5 !text-[10px]">
                    {p.manual ? t("feesPayoutHistory.sourceManual") : t("feesPayoutHistory.sourceAuto")}
                  </span>
                </td>
                <td className="py-3 pr-4">
                  <span className="font-mono font-semibold text-positive">
                    {p.usdValue !== null ? `$${p.usdValue.toFixed(4)}` : "—"}
                  </span>
                  <div className="mt-0.5 text-xs text-muted">
                    {fmtStable(p.claimedStable)}
                    {p.claimedVolatile > 0n ? ` + ${fmtVolatile(p.claimedVolatile)}` : ""}
                  </div>
                </td>
                <td className="whitespace-nowrap py-3 pr-4 font-mono text-foreground/80">
                  {p.platformFee
                    ? `${fmtStable(p.platformFee.stable)}${p.platformFee.volatile > 0n ? ` + ${fmtVolatile(p.platformFee.volatile)}` : ""}`
                    : t("feesPayoutHistory.platformFeeUnknown")}
                </td>
                <td className="whitespace-nowrap py-3">
                  <a
                    href={`${chain.explorerBaseUrl}/tx/${p.txHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-[11px] text-faint underline-offset-4 hover:text-accent-text hover:underline"
                  >
                    {p.txHash.slice(0, 8)}…{p.txHash.slice(-6)} ↗
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
