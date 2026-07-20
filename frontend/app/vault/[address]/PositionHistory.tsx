"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { formatUnits } from "viem";
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
 */
export function PositionHistory({ address, chain }: { address: `0x${string}`; chain: ChainDef }) {
  const publicClient = usePublicClient({ chainId: chain.id });
  const { t, locale } = useTranslation();
  const { data: eventLogs } = useVaultEventLogs(address, chain);

  const { data: positions } = useQuery({
    queryKey: ["vault-position-history", chain.id, address, eventLogs?.length],
    enabled: Boolean(publicClient && eventLogs),
    queryFn: async (): Promise<PositionRecord[]> => {
      if (!publicClient || !eventLogs) return [];
      const parsed = eventLogs;

      const targetConfigs: Array<{ tickLower: number; tickUpper: number; blockNumber: bigint }> = [];
      const rebalances: OpenEvent[] = [];
      const feesByTx = new Map<string, { amount0: bigint; amount1: bigint }>();
      let initEvent: { tokenId: bigint; blockNumber: bigint; txHash: string } | undefined;

      for (const log of parsed) {
        const args = log.args as Record<string, unknown>;
        const blockNumber = log.blockNumber ?? 0n;
        const txHash = log.transactionHash ?? "";
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
          });
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
          isOpen: !next,
        };
      });

      const blocks = [...new Set(records.flatMap((r) => [r.createdBlock, r.closedBlock].filter(Boolean) as bigint[]))];
      const stamps = new Map<bigint, number>();
      await Promise.all(
        blocks.map(async (bn) => {
          const block = await publicClient.getBlock({ blockNumber: bn });
          stamps.set(bn, Number(block.timestamp));
        }),
      );

      return records
        .map((r) => ({
          ...r,
          createdAt: stamps.get(r.createdBlock),
          closedAt: r.closedBlock ? stamps.get(r.closedBlock) : undefined,
        }))
        .reverse(); // newest first
    },
  });

  if (!positions || positions.length === 0) return null;

  const fmtDate = (ts?: number) =>
    ts ? new Date(ts * 1000).toLocaleString(dateLocale[locale] ?? "es", { dateStyle: "short", timeStyle: "short" }) : "—";

  return (
    <div className="glass mt-10 rounded-2xl p-6 sm:p-8">
      <h2 className="text-xl font-semibold tracking-tight" style={{ fontFamily: "var(--font-display)" }}>
        {t("positionHistory.title")}
      </h2>
      <p className="mt-1 text-sm text-muted">{t("positionHistory.subtitle")}</p>

      <ol className="mt-6 flex flex-col gap-4">
        {positions.map((p) => (
          <li key={p.tokenId.toString()} className="rounded-xl border border-hairline p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-sm text-white/90">
                {t("positionHistory.positionLabel", {
                  id: p.tokenId.toString(),
                  min: p.minPrice.toFixed(2),
                  max: p.maxPrice.toFixed(2),
                })}
              </span>
              {p.isOpen ? (
                <span className="eyebrow !border-positive/40 !px-3 !py-1 !text-positive">{t("positionHistory.active")}</span>
              ) : (
                <span className="eyebrow !px-3 !py-1">{t("positionHistory.closed")}</span>
              )}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">{t("positionHistory.created")}</p>
                <p className="mt-0.5 text-white/90">{fmtDate(p.createdAt)}</p>
              </div>
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">{t("positionHistory.closedLabel")}</p>
                <p className="mt-0.5 text-white/90">{p.isOpen ? "—" : fmtDate(p.closedAt)}</p>
              </div>
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
                  {t("positionHistory.feesEarned")}
                </p>
                <p className="mt-0.5 text-positive">
                  {p.isOpen
                    ? t("positionHistory.inProgress")
                    : `${formatUnits(p.feesUsdt, 6)} ${chain.stableSymbol}${p.feesWeth > 0n ? ` + ${Number(formatUnits(p.feesWeth, 18)).toFixed(6)} ${chain.volatileSymbol}` : ""}`}
                </p>
              </div>
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">{t("positionHistory.reinjectionOnOpen")}</p>
                <p className="mt-0.5 text-white/90">
                  {p.reinjectedUsdt > 0n
                    ? `${formatUnits(p.reinjectedUsdt, 6)} ${chain.stableSymbol}`
                    : t("positionHistory.noReinjection")}
                </p>
              </div>
            </div>
            <a
              href={`${chain.explorerBaseUrl}/tx/${p.createdTxHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-block font-mono text-[11px] text-faint underline-offset-4 hover:text-accent hover:underline"
            >
              {t("positionHistory.openingTx", { hash: `${p.createdTxHash.slice(0, 10)}…${p.createdTxHash.slice(-6)}` })}
            </a>
          </li>
        ))}
      </ol>
    </div>
  );
}
