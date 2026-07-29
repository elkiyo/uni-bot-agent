"use client";

import { formatUnits, type Abi } from "viem";
import { useVaultEventLogs } from "@/lib/useVaultEventLogs";
import type { ChainDef } from "@/lib/chains";
import { useTranslation } from "@/lib/i18n/useTranslation";

const dateLocale: Record<string, string> = { es: "es", en: "en-US", pt: "pt-BR", zh: "zh-CN" };

/**
 * Every FeesReinjected event a compound vault has ever emitted (see
 * RangeVaultArbCompound.sol's own docstring on that event) — compound-only,
 * absent from the standard ABI entirely, so this renders nothing for a
 * standard vault. Shows both sides of what the contract's own
 * _reinjectFees does: netFee0/netFee1 (the real claimed fee, after the
 * platform's performance-fee cut, in whichever raw token0/token1 ratio
 * Uniswap happened to collect it in) vs used0/used1 (what actually landed
 * in the position after _executeSwap rebalanced that ratio to fit the
 * current range) — the gap between the two IS the swap's effect, without
 * needing a separate reconstruction of the pool's own Swap event. Same
 * "reconstructed straight from chain events, no backend" pattern as
 * PositionHistory.tsx/ActivityFeed.tsx.
 *
 * Gas cost per row is read from KeeperGasReimbursed — a SEPARATE event the
 * same transaction ALSO emits whenever the keeper is the one triggering the
 * auto-claim/reinject cycle (see RangeVaultArbCompound.sol's
 * _reimburseKeeperGas, called right after _reinjectFees in every public
 * entry point that can reach it) — matched here purely by tx_hash, already
 * present in the same eventLogs fetch, no extra RPC call needed. A manual,
 * owner-triggered "Cobrar comisiones" with auto-compound on has no such
 * event (the owner paid their own real gas directly, nothing to reimburse),
 * so that case just shows no gas figure rather than guessing one.
 */
export function ReinjectionHistory({
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

  // Which position (tokenId) was actually open at each reinjection — a
  // rebalance's own fee (netFee0/netFee1) belongs to the POSITION THAT JUST
  // CLOSED in that same tx, while the reinjection itself lands in the BRAND
  // NEW position that tx just opened; a manual collectFees()/harvestFees()
  // call, on the other hand, reinjects into whatever position was ALREADY
  // open. Either way, tagging each entry with the position it landed in
  // (found by the latest PositionInitialized/Rebalanced at or before this
  // event's own block) avoids the confusing "why doesn't this match the
  // closed position I was just looking at" read — a reinjection here is
  // rarely about the position directly above it in Historial de posiciones,
  // since that section shows the position that CLOSED, not the one a later,
  // independent fee-collection cycle reinjected into.
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

  const gasByTxHash = new Map<string, bigint>();
  for (const log of eventLogs ?? []) {
    if (log.eventName !== "KeeperGasReimbursed") continue;
    const amountUsd = (log.args as { amountUsd?: bigint }).amountUsd ?? 0n;
    gasByTxHash.set(log.transactionHash, amountUsd);
  }

  const reinjections = (eventLogs ?? [])
    .filter((log) => log.eventName === "FeesReinjected")
    .map((log) => {
      const args = log.args as { netFee0?: bigint; netFee1?: bigint; used0?: bigint; used1?: bigint; netFeeUsd?: bigint };
      const netFee0 = args.netFee0 ?? 0n;
      const netFee1 = args.netFee1 ?? 0n;
      const used0 = args.used0 ?? 0n;
      const used1 = args.used1 ?? 0n;
      const netFeeUsd = args.netFeeUsd ?? 0n;
      const gasUsd = gasByTxHash.get(log.transactionHash);
      // Both already raw stable-token (6-decimal) amounts — plain integer
      // ratio gives the same % a human-dollar division would, without a
      // float round-trip through formatUnits first.
      const gasPct = gasUsd !== undefined && netFeeUsd > 0n ? (Number(gasUsd) / Number(netFeeUsd)) * 100 : undefined;
      // Route Uniswap's real token0/token1 to stable/volatile based on this
      // chain's actual pair order — same pattern used throughout this page.
      return {
        blockTimestamp: log.blockTimestamp,
        txHash: log.transactionHash,
        netFeeUsd,
        claimedStable: chain.stableIsToken0 ? netFee0 : netFee1,
        claimedVolatile: chain.stableIsToken0 ? netFee1 : netFee0,
        reinjectedStable: chain.stableIsToken0 ? used0 : used1,
        reinjectedVolatile: chain.stableIsToken0 ? used1 : used0,
        positionId: positionAt(log.blockNumber),
        gasUsd,
        gasPct,
      };
    })
    .sort((a, b) => b.blockTimestamp - a.blockTimestamp); // newest first

  if (reinjections.length === 0) return null;

  const fmtDate = (ts: number) =>
    new Date(ts * 1000).toLocaleString(dateLocale[locale] ?? "es", { dateStyle: "short", timeStyle: "short" });
  const fmtStable = (v: bigint) => `${formatUnits(v, chain.stableDecimals)} ${chain.stableSymbol}`;
  const fmtVolatile = (v: bigint) => `${Number(formatUnits(v, chain.volatileDecimals)).toFixed(6)} ${chain.volatileSymbol}`;
  const fmtUsd4 = (v: bigint) => `$${Number(formatUnits(v, chain.stableDecimals)).toFixed(4)}`;

  return (
    <div className="glass mt-10 rounded-2xl p-6 sm:p-8">
      <h2 className="text-2xl font-semibold tracking-tight text-foreground" style={{ fontFamily: "var(--font-display)" }}>
        {t("reinjectionHistory.title")}
      </h2>
      <p className="mt-1 text-sm text-muted">{t("reinjectionHistory.subtitle")}</p>

      <div className="mt-6 overflow-x-auto">
        <table className="w-full min-w-[820px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-hairline text-left">
              <th className="whitespace-nowrap py-2 pr-4 font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-faint">
                {t("reinjectionHistory.colDate")}
              </th>
              <th className="whitespace-nowrap py-2 pr-4 font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-faint">
                {t("reinjectionHistory.claimed")}
              </th>
              <th className="whitespace-nowrap py-2 pr-4 font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-faint">
                {t("reinjectionHistory.reinjected")}
              </th>
              <th className="whitespace-nowrap py-2 pr-4 font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-faint">
                {t("reinjectionHistory.colGasCost")}
              </th>
              <th className="whitespace-nowrap py-2 pr-4 font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-faint">
                {t("reinjectionHistory.colProfitability")}
              </th>
              <th className="whitespace-nowrap py-2 font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-faint">
                {t("reinjectionHistory.colTx")}
              </th>
            </tr>
          </thead>
          <tbody>
            {reinjections.map((r) => {
              // >=100% means gas alone cost as much as (or more than) the
              // whole reinjected amount — a real loss, not just a thin
              // margin. Under that, still flag anything eating a big slice
              // (>=25%) as marginal rather than cleanly profitable.
              const unprofitable = r.gasPct !== undefined && r.gasPct >= 100;
              const marginal = r.gasPct !== undefined && r.gasPct >= 25 && r.gasPct < 100;
              return (
                <tr key={r.txHash} className="border-b border-hairline/60 last:border-0">
                  <td className="whitespace-nowrap py-3 pr-4">
                    <div className="font-mono text-xs text-foreground/90">{fmtDate(r.blockTimestamp)}</div>
                    {r.positionId !== undefined && (
                      <span className="eyebrow mt-1 inline-block !px-2 !py-0.5 !text-[10px]">
                        {t("reinjectionHistory.positionLabel", { id: r.positionId.toString() })}
                      </span>
                    )}
                  </td>
                  <td className="py-3 pr-4 text-foreground/90">
                    {fmtStable(r.claimedStable)}
                    {r.claimedVolatile > 0n ? ` + ${fmtVolatile(r.claimedVolatile)}` : ""}
                  </td>
                  <td className="py-3 pr-4">
                    <span className="font-mono font-semibold text-positive">{fmtUsd4(r.netFeeUsd)}</span>
                    <div className="mt-0.5 text-xs text-muted">
                      {fmtStable(r.reinjectedStable)}
                      {r.reinjectedVolatile > 0n ? ` + ${fmtVolatile(r.reinjectedVolatile)}` : ""}
                    </div>
                  </td>
                  <td className="whitespace-nowrap py-3 pr-4 font-mono text-foreground/80">
                    {r.gasUsd !== undefined ? fmtUsd4(r.gasUsd) : t("reinjectionHistory.gasUnknown")}
                  </td>
                  <td className="whitespace-nowrap py-3 pr-4">
                    {r.gasPct === undefined ? (
                      <span className="text-muted">—</span>
                    ) : (
                      <span
                        className={`font-mono font-semibold ${
                          unprofitable ? "text-negative" : marginal ? "text-accent-text" : "text-positive"
                        }`}
                        title={t("reinjectionHistory.profitabilityHint")}
                      >
                        {r.gasPct.toFixed(1)}%{unprofitable ? ` ${t("reinjectionHistory.unprofitable")}` : ""}
                      </span>
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
