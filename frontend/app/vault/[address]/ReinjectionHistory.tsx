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

  const reinjections = (eventLogs ?? [])
    .filter((log) => log.eventName === "FeesReinjected")
    .map((log) => {
      const args = log.args as { netFee0?: bigint; netFee1?: bigint; used0?: bigint; used1?: bigint; netFeeUsd?: bigint };
      const netFee0 = args.netFee0 ?? 0n;
      const netFee1 = args.netFee1 ?? 0n;
      const used0 = args.used0 ?? 0n;
      const used1 = args.used1 ?? 0n;
      // Route Uniswap's real token0/token1 to stable/volatile based on this
      // chain's actual pair order — same pattern used throughout this page.
      return {
        blockTimestamp: log.blockTimestamp,
        txHash: log.transactionHash,
        netFeeUsd: args.netFeeUsd ?? 0n,
        claimedStable: chain.stableIsToken0 ? netFee0 : netFee1,
        claimedVolatile: chain.stableIsToken0 ? netFee1 : netFee0,
        reinjectedStable: chain.stableIsToken0 ? used0 : used1,
        reinjectedVolatile: chain.stableIsToken0 ? used1 : used0,
      };
    })
    .sort((a, b) => b.blockTimestamp - a.blockTimestamp); // newest first

  if (reinjections.length === 0) return null;

  const fmtDate = (ts: number) =>
    new Date(ts * 1000).toLocaleString(dateLocale[locale] ?? "es", { dateStyle: "short", timeStyle: "short" });
  const fmtStable = (v: bigint) => `${formatUnits(v, chain.stableDecimals)} ${chain.stableSymbol}`;
  const fmtVolatile = (v: bigint) => `${Number(formatUnits(v, chain.volatileDecimals)).toFixed(6)} ${chain.volatileSymbol}`;

  return (
    <div className="glass mt-10 rounded-2xl p-6 sm:p-8">
      <h2 className="text-2xl font-semibold tracking-tight text-white" style={{ fontFamily: "var(--font-display)" }}>
        {t("reinjectionHistory.title")}
      </h2>
      <p className="mt-1 text-sm text-muted">{t("reinjectionHistory.subtitle")}</p>

      <ol className="mt-6 flex flex-col gap-4">
        {reinjections.map((r) => (
          <li key={`${r.txHash}`} className="rounded-xl border border-hairline p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-sm text-white/90">{fmtDate(r.blockTimestamp)}</span>
              <span className="font-mono text-sm font-semibold text-positive">
                ${Number(formatUnits(r.netFeeUsd, chain.stableDecimals)).toFixed(2)}
              </span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
                  {t("reinjectionHistory.claimed")}
                </p>
                <p className="mt-0.5 text-white/90">
                  {fmtStable(r.claimedStable)}
                  {r.claimedVolatile > 0n ? ` + ${fmtVolatile(r.claimedVolatile)}` : ""}
                </p>
              </div>
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
                  {t("reinjectionHistory.reinjected")}
                </p>
                <p className="mt-0.5 text-white/90">
                  {fmtStable(r.reinjectedStable)}
                  {r.reinjectedVolatile > 0n ? ` + ${fmtVolatile(r.reinjectedVolatile)}` : ""}
                </p>
              </div>
            </div>
            <a
              href={`${chain.explorerBaseUrl}/tx/${r.txHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-block font-mono text-[11px] text-faint underline-offset-4 hover:text-accent hover:underline"
            >
              {t("reinjectionHistory.tx", { hash: `${r.txHash.slice(0, 10)}…${r.txHash.slice(-6)}` })}
            </a>
          </li>
        ))}
      </ol>
    </div>
  );
}
