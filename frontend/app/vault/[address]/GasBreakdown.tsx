"use client";

import { formatUnits, type Abi } from "viem";
import { useVaultGasBreakdown, type GasBreakdownByAction, type GasBreakdownEntry } from "@/lib/useVaultGasBreakdown";
import type { ChainDef } from "@/lib/chains";
import { useTranslation } from "@/lib/i18n/useTranslation";

/**
 * Breakdown of "Gas gastado" by WHICH action actually triggered the
 * reimbursement — initPosition/rebalance/reinjectIntoPosition/sweepIdleDust
 * all cost the keeper real gas and all get reimbursed the same way (see
 * useVaultGasBreakdown.ts's own docstring), but only rebalance() increments
 * the vault's own rebalanceCount — so "reembolsado en N rebalanceos" on the
 * Gas gastado stat card and the actual Rebalanceos stat can legitimately
 * differ, which is exactly what this table exists to make visible.
 */
export function GasBreakdown({
  address,
  chain,
  vaultAbi = chain.vaultAbi,
}: {
  address: `0x${string}`;
  chain: ChainDef;
  vaultAbi?: Abi;
}) {
  const { t } = useTranslation();
  const { data } = useVaultGasBreakdown(address, chain, vaultAbi);

  if (!data) return null;
  const allRows: { key: keyof GasBreakdownByAction; label: string; entry: GasBreakdownEntry }[] = [
    { key: "initPosition", label: t("gasBreakdown.actionInitPosition"), entry: data.initPosition },
    { key: "rebalance", label: t("gasBreakdown.actionRebalance"), entry: data.rebalance },
    { key: "reinjectIntoPosition", label: t("gasBreakdown.actionReinjectIntoPosition"), entry: data.reinjectIntoPosition },
    { key: "sweepIdleDust", label: t("gasBreakdown.actionSweepIdleDust"), entry: data.sweepIdleDust },
    { key: "harvestFees", label: t("gasBreakdown.actionHarvestFees"), entry: data.harvestFees },
  ];
  const rows = allRows.filter((r) => r.entry.count > 0);

  if (rows.length === 0) return null;

  const totalCount = rows.reduce((acc, r) => acc + r.entry.count, 0);
  const totalUsdRaw = rows.reduce((acc, r) => acc + r.entry.usdRaw, 0n);
  const fmtUsd = (v: bigint) => `$${Number(formatUnits(v, chain.stableDecimals)).toFixed(4)}`;

  return (
    <div className="glass mt-10 rounded-2xl p-6 sm:p-8">
      <h2 className="text-2xl font-semibold tracking-tight text-foreground" style={{ fontFamily: "var(--font-display)" }}>
        {t("gasBreakdown.title")}
      </h2>
      <p className="mt-1 text-sm text-muted">{t("gasBreakdown.subtitle")}</p>

      <div className="mt-6 overflow-x-auto">
        <table className="w-full min-w-[520px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-hairline text-left">
              <th className="whitespace-nowrap py-2 pr-4 font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-faint">
                {t("gasBreakdown.colAction")}
              </th>
              <th className="whitespace-nowrap py-2 pr-4 text-right font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-faint">
                {t("gasBreakdown.colCount")}
              </th>
              <th className="whitespace-nowrap py-2 pr-4 text-right font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-faint">
                {t("gasBreakdown.colTotal")}
              </th>
              <th className="whitespace-nowrap py-2 text-right font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-faint">
                {t("gasBreakdown.colAverage")}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-b border-hairline/60 last:border-0">
                <td className="py-3 pr-4 text-foreground/90">{r.label}</td>
                <td className="whitespace-nowrap py-3 pr-4 text-right font-mono text-foreground/90">{r.entry.count}</td>
                <td className="whitespace-nowrap py-3 pr-4 text-right font-mono font-semibold text-accent-text">
                  {fmtUsd(r.entry.usdRaw)}
                </td>
                <td className="whitespace-nowrap py-3 text-right font-mono text-faint">
                  {fmtUsd(r.entry.usdRaw / BigInt(r.entry.count))}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-hairline">
              <td className="py-3 pr-4 font-semibold text-foreground/90">{t("gasBreakdown.total")}</td>
              <td className="whitespace-nowrap py-3 pr-4 text-right font-mono font-semibold text-foreground/90">
                {totalCount}
              </td>
              <td className="whitespace-nowrap py-3 pr-4 text-right font-mono font-semibold text-accent-text">
                {fmtUsd(totalUsdRaw)}
              </td>
              <td className="whitespace-nowrap py-3 text-right font-mono text-faint">
                {totalCount > 0 ? fmtUsd(totalUsdRaw / BigInt(totalCount)) : "—"}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
