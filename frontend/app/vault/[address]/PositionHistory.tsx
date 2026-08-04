"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatUnits, type Abi } from "viem";
import { ethPriceFromTick } from "@/lib/priceMath";
import { useVaultEventLogs } from "@/lib/useVaultEventLogs";
import type { ChainDef } from "@/lib/chains";
import { useTranslation } from "@/lib/i18n/useTranslation";

const dateLocale: Record<string, string> = { es: "es", en: "en-US", pt: "pt-BR", zh: "zh-CN" };

interface OpenEvent {
  tokenId: bigint;
  tickLower: number;
  tickUpper: number;
  reinjectedUsdt: bigint;
  blockNumber: bigint;
  txHash: string;
}

interface PositionRecord {
  tokenId: bigint;
  minPrice: number;
  maxPrice: number;
  reinjectedUsdt: bigint;
  createdBlock: bigint;
  createdTxHash: string;
  closedBlock?: bigint;
  closedTxHash?: string;
  feesUsdt: bigint;
  feesWeth: bigint;
  feesUsd: number | null;
  openGasUsd: number | null;
  closeGasUsd: number | null;
  /** (openGasUsd + closeGasUsd) ÷ feesUsd, as a % — what share of this
   * position's own earnings got eaten by the gas needed to open AND close
   * it. Only computed once both figures are known (closed position, and at
   * least one gas figure available) — see the render for how a missing gas
   * side (Celo, or an owner-triggered manual action) is still handled. */
  gasPct: number | null;
  isOpen: boolean;
  createdAt?: number;
  closedAt?: number;
}

/**
 * Every position a vault has ever held, reconstructed straight from chain
 * events (no backend) — same pattern as ActivityFeed.tsx / useVaultFeesSummary.
 * A vault mints a brand new NFT on every initPosition()/rebalance(), closing
 * the previous one in the same tx, so "history" here means: for each
 * PositionInitialized/Rebalanced event, pair it with the NEXT such event
 * (its close) and whatever LpFeesPaidToOwner fired in that same closing tx.
 *
 * openGasUsd/closeGasUsd come from KeeperGasReimbursed — a separate event
 * the SAME transaction also emits whenever the keeper (not the owner
 * manually) is the one calling initPosition()/rebalance() — matched here by
 * tx_hash, already present in the same eventLogs fetch, no extra RPC call.
 * Both null on a chain/vault without gas-reserve support (chain.
 * supportsGasReserve — Celo's plain RangeVault.sol never had this) or for
 * an owner-triggered manual action (nothing to reimburse, no event fires).
 * Since rebalance() closes the OLD position and opens the NEW one in ONE
 * atomic transaction, a position's own "close" cost and the NEXT position's
 * "open" cost are the exact same figure — not a bug, just what a single
 * rebalance() call really costs.
 */
export function PositionHistory({
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
  const [expanded, setExpanded] = useState(false);

  const { data: positions } = useQuery({
    queryKey: ["vault-position-history", chain.id, address, eventLogs?.length],
    enabled: Boolean(eventLogs),
    queryFn: (): PositionRecord[] => {
      if (!eventLogs) return [];
      const parsed = eventLogs;

      const targetConfigs: Array<{ tickLower: number; tickUpper: number; blockNumber: bigint }> = [];
      const rebalances: OpenEvent[] = [];
      const feesByTx = new Map<string, { amount0: bigint; amount1: bigint; usdValue: number | null }>();
      const gasByTx = new Map<string, number>();
      let initEvent: { tokenId: bigint; blockNumber: bigint; txHash: string } | undefined;
      const timestampByBlock = new Map<bigint, number>();

      for (const log of parsed) {
        const args = log.args;
        const blockNumber = log.blockNumber;
        const txHash = log.transactionHash;
        timestampByBlock.set(blockNumber, log.blockTimestamp);
        if (log.eventName === "TargetConfigured") {
          targetConfigs.push({
            tickLower: Number(args.targetTickLower),
            tickUpper: Number(args.targetTickUpper),
            blockNumber,
          });
        } else if (log.eventName === "PositionInitialized" && !initEvent) {
          initEvent = { tokenId: args.tokenId as bigint, blockNumber, txHash };
        } else if (log.eventName === "Rebalanced") {
          rebalances.push({
            tokenId: args.newTokenId as bigint,
            tickLower: Number(args.tickLower),
            tickUpper: Number(args.tickUpper),
            reinjectedUsdt: (args.reinjectedAmount as bigint) ?? 0n,
            blockNumber,
            txHash,
          });
        } else if (log.eventName === "LpFeesPaidToOwner") {
          feesByTx.set(txHash, {
            amount0: (args.amount0 as bigint) ?? 0n,
            amount1: (args.amount1 as bigint) ?? 0n,
            usdValue: log.usdValue,
          });
        } else if (log.eventName === "KeeperGasReimbursed") {
          const amountUsdRaw = (args.amountUsd as bigint) ?? 0n;
          gasByTx.set(txHash, Number(formatUnits(amountUsdRaw, chain.stableDecimals)));
        }
      }

      const openEvents: OpenEvent[] = [];
      if (initEvent) {
        // The range initPosition() actually minted into: the latest
        // configureTarget() that landed before (or in) the init block.
        const range = [...targetConfigs]
          .filter((c) => c.blockNumber <= initEvent!.blockNumber)
          .sort((a, b) => (a.blockNumber > b.blockNumber ? -1 : 1))[0];
        if (range) {
          openEvents.push({
            tokenId: initEvent.tokenId,
            tickLower: range.tickLower,
            tickUpper: range.tickUpper,
            reinjectedUsdt: 0n,
            blockNumber: initEvent.blockNumber,
            txHash: initEvent.txHash,
          });
        }
      }
      openEvents.push(...rebalances.sort((a, b) => (a.blockNumber > b.blockNumber ? 1 : -1)));

      const records: PositionRecord[] = openEvents.map((e, i) => {
        const next = openEvents[i + 1];
        const fees = next ? feesByTx.get(next.txHash) : undefined;
        const priceA = ethPriceFromTick(e.tickLower, chain.stableIsToken0);
        const priceB = ethPriceFromTick(e.tickUpper, chain.stableIsToken0);
        // fees.amount0/amount1 are Uniswap's real token0/token1 — route to
        // stable/volatile based on this chain's actual order.
        const feesStable = chain.stableIsToken0 ? fees?.amount0 : fees?.amount1;
        const feesVolatile = chain.stableIsToken0 ? fees?.amount1 : fees?.amount0;
        const openGasUsd = gasByTx.get(e.txHash) ?? null;
        const closeGasUsd = next ? (gasByTx.get(next.txHash) ?? null) : null;
        const feesUsd = fees?.usdValue ?? null;
        // Only meaningful for a CLOSED position with at least one gas figure
        // known — an open position hasn't paid its close cost yet, and with
        // neither gas figure available (Celo, or a manual owner action)
        // there's nothing real to compare fees against.
        const gasPct =
          next && feesUsd !== null && feesUsd > 0 && (openGasUsd !== null || closeGasUsd !== null)
            ? (((openGasUsd ?? 0) + (closeGasUsd ?? 0)) / feesUsd) * 100
            : null;
        return {
          tokenId: e.tokenId,
          minPrice: Math.min(priceA, priceB),
          maxPrice: Math.max(priceA, priceB),
          reinjectedUsdt: e.reinjectedUsdt,
          createdBlock: e.blockNumber,
          createdTxHash: e.txHash,
          closedBlock: next?.blockNumber,
          closedTxHash: next?.txHash,
          feesUsdt: feesStable ?? 0n,
          feesWeth: feesVolatile ?? 0n,
          feesUsd,
          openGasUsd,
          closeGasUsd,
          gasPct,
          isOpen: !next,
        };
      });

      return records
        .map((r) => ({
          ...r,
          createdAt: timestampByBlock.get(r.createdBlock),
          closedAt: r.closedBlock ? timestampByBlock.get(r.closedBlock) : undefined,
        }))
        .reverse(); // newest first
    },
  });

  if (!positions || positions.length === 0) return null;

  const fmtDate = (ts?: number) =>
    ts ? new Date(ts * 1000).toLocaleString(dateLocale[locale] ?? "es", { dateStyle: "short", timeStyle: "short" }) : "—";

  const fmtUsd = (v: number) => `$${v.toFixed(v < 0.01 && v > 0 ? 4 : 2)}`;

  return (
    <div className="glass mt-10 rounded-2xl p-6 sm:p-8">
      <h2 className="text-2xl font-semibold tracking-tight text-foreground" style={{ fontFamily: "var(--font-display)" }}>
        {t("positionHistory.title")}
      </h2>
      <p className="mt-1 text-sm text-muted">{t("positionHistory.subtitle")}</p>

      {expanded ? (
        <>
      <div className="mt-6 overflow-x-auto">
        <table className="w-full min-w-[860px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-hairline text-left">
              <th className="whitespace-nowrap py-2 pr-4 font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-faint">
                {t("positionHistory.colPosition")}
              </th>
              <th className="whitespace-nowrap py-2 pr-4 font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-faint">
                {t("positionHistory.created")}
              </th>
              <th className="whitespace-nowrap py-2 pr-4 font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-faint">
                {t("positionHistory.closedLabel")}
              </th>
              <th className="whitespace-nowrap py-2 pr-4 font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-faint">
                {t("positionHistory.feesEarned")}
              </th>
              <th className="whitespace-nowrap py-2 pr-4 font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-faint">
                {t("positionHistory.colGasCost")}
              </th>
              <th className="whitespace-nowrap py-2 pr-4 font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-faint">
                {t("positionHistory.colProfitability")}
              </th>
              <th className="whitespace-nowrap py-2 pr-4 font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-faint">
                {t("positionHistory.reinjectionOnOpen")}
              </th>
              <th className="whitespace-nowrap py-2 font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-faint">
                {t("positionHistory.colTx")}
              </th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => (
              <tr key={p.tokenId.toString()} className="border-b border-hairline/60 last:border-0">
                <td className="py-3 pr-4">
                  <span className="font-mono text-xs text-foreground/90">
                    {t("positionHistory.positionLabel", {
                      id: p.tokenId.toString(),
                      min: p.minPrice.toFixed(2),
                      max: p.maxPrice.toFixed(2),
                    })}
                  </span>
                  <div className="mt-1">
                    {p.isOpen ? (
                      <span className="eyebrow !border-positive/40 !px-2 !py-0.5 !text-[10px] !text-positive">
                        {t("positionHistory.active")}
                      </span>
                    ) : (
                      <span className="eyebrow !px-2 !py-0.5 !text-[10px]">{t("positionHistory.closed")}</span>
                    )}
                  </div>
                </td>
                <td className="whitespace-nowrap py-3 pr-4 font-mono text-xs text-foreground/90">{fmtDate(p.createdAt)}</td>
                <td className="whitespace-nowrap py-3 pr-4 font-mono text-xs text-foreground/90">
                  {p.isOpen ? "—" : fmtDate(p.closedAt)}
                </td>
                <td className="py-3 pr-4">
                  {p.isOpen ? (
                    <span className="text-muted">{t("positionHistory.inProgress")}</span>
                  ) : (
                    <>
                      {p.feesUsd !== null && (
                        <span className="font-mono font-semibold text-positive">{fmtUsd(p.feesUsd)}</span>
                      )}
                      <div className="mt-0.5 text-xs text-muted">
                        {formatUnits(p.feesUsdt, chain.stableDecimals)} {chain.stableSymbol}
                        {p.feesWeth > 0n ? ` + ${Number(formatUnits(p.feesWeth, chain.volatileDecimals)).toFixed(6)} ${chain.volatileSymbol}` : ""}
                      </div>
                    </>
                  )}
                </td>
                <td className="whitespace-nowrap py-3 pr-4 font-mono text-xs">
                  <div className="text-foreground/80">
                    {t("positionHistory.gasOpen")}: {p.openGasUsd !== null ? fmtUsd(p.openGasUsd) : "—"}
                  </div>
                  <div className="mt-0.5 text-muted">
                    {t("positionHistory.gasClose")}: {p.closeGasUsd !== null ? fmtUsd(p.closeGasUsd) : "—"}
                  </div>
                </td>
                <td className="whitespace-nowrap py-3 pr-4">
                  {p.gasPct === null ? (
                    <span className="text-muted">—</span>
                  ) : (
                    <span
                      className={`font-mono font-semibold ${
                        p.gasPct >= 100 ? "text-negative" : p.gasPct >= 25 ? "text-accent-text" : "text-positive"
                      }`}
                      title={t("positionHistory.profitabilityHint")}
                    >
                      {p.gasPct.toFixed(1)}%{p.gasPct >= 100 ? ` ${t("positionHistory.unprofitable")}` : ""}
                    </span>
                  )}
                </td>
                <td className="whitespace-nowrap py-3 pr-4 text-foreground/90">
                  {p.reinjectedUsdt > 0n
                    ? `${formatUnits(p.reinjectedUsdt, chain.stableDecimals)} ${chain.stableSymbol}`
                    : t("positionHistory.noReinjection")}
                </td>
                <td className="whitespace-nowrap py-3">
                  <a
                    href={`${chain.explorerBaseUrl}/tx/${p.createdTxHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-[11px] text-faint underline-offset-4 hover:text-accent-text hover:underline"
                  >
                    {p.createdTxHash.slice(0, 8)}…{p.createdTxHash.slice(-6)} ↗
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="mt-4 rounded-full border border-hairline px-4 py-1.5 font-mono text-[11px] uppercase tracking-[0.1em] text-muted transition-colors hover:border-border-medium hover:text-foreground"
          >
            {t("positionHistory.hideTable")}
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-5 rounded-full border border-accent-fill-border bg-accent-fill-bg px-4 py-1.5 font-mono text-[11px] uppercase tracking-[0.1em] text-accent-fill-text transition-opacity hover:opacity-90"
        >
          {t("positionHistory.showTable")}
        </button>
      )}
    </div>
  );
}
