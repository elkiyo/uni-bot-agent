"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { formatUnits, parseEventLogs, type Log } from "viem";
import { getLogsChunked } from "@/lib/getLogsChunked";
import type { ChainDef } from "@/lib/chains";
import { useTranslation } from "@/lib/i18n/useTranslation";

const dateLocale: Record<string, string> = { es: "es", en: "en-US", pt: "pt-BR", zh: "zh-CN" };

interface FeedItem {
  txHash: string;
  blockNumber: bigint;
  timestamp?: number;
  title: string;
  detail: string;
  kind: "money" | "agent" | "config";
}

/**
 * Live on-chain activity feed for a vault. Everything the agent does emits an
 * event (PositionInitialized, Rebalanced, LpFeesPaidToOwner, ...), so the
 * feed is reconstructed straight from the RPC — no backend, and it shows the
 * keeper acting in real time (10s polling) during a demo.
 */
export function ActivityFeed({ address, chain }: { address: `0x${string}`; chain: ChainDef }) {
  const publicClient = usePublicClient({ chainId: chain.id });
  const { t, locale } = useTranslation();

  const { data: items } = useQuery({
    queryKey: ["vault-activity", chain.id, address, locale],
    enabled: Boolean(publicClient),
    refetchInterval: 10_000,
    queryFn: async (): Promise<FeedItem[]> => {
      if (!publicClient) return [];
      const logs = await getLogsChunked(publicClient, {
        address,
        fromBlock: chain.factoryDeployBlock,
        toBlock: "latest",
      });
      const parsed = parseEventLogs({ abi: chain.vaultAbi, logs: logs as Log[] });

      const feed: FeedItem[] = [];
      for (const log of parsed) {
        const item = describe(t, log.eventName, log.args as Record<string, unknown>, chain);
        if (!item) continue;
        feed.push({
          txHash: log.transactionHash ?? "",
          blockNumber: log.blockNumber ?? 0n,
          ...item,
        });
      }

      // Timestamps: one getBlock per distinct block, newest 25 events only.
      feed.sort((a, b) => (a.blockNumber > b.blockNumber ? -1 : 1));
      const recent = feed.slice(0, 25);
      const blocks = [...new Set(recent.map((f) => f.blockNumber))];
      const stamps = new Map<bigint, number>();
      await Promise.all(
        blocks.map(async (bn) => {
          const block = await publicClient.getBlock({ blockNumber: bn });
          stamps.set(bn, Number(block.timestamp));
        }),
      );
      for (const f of recent) f.timestamp = stamps.get(f.blockNumber);
      return recent;
    },
  });

  if (!items || items.length === 0) return null;

  return (
    <div className="glass mt-10 rounded-2xl p-6 sm:p-8">
      <div className="flex items-center gap-3">
        <h2
          className="text-xl font-semibold tracking-tight"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {t("activity.feedTitle")}
        </h2>
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-positive opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-positive" />
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">{t("activity.live")}</span>
      </div>
      <p className="mt-1 text-sm text-muted">{t("activity.feedSubtitle")}</p>

      <ol className="mt-6 flex flex-col">
        {items.map((item, i) => (
          <li
            key={`${item.txHash}-${i}`}
            className="flex gap-4 border-l border-hairline pb-6 pl-5 last:pb-0"
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span
                  className={`font-mono text-[10px] uppercase tracking-[0.14em] ${
                    item.kind === "agent"
                      ? "text-accent"
                      : item.kind === "money"
                        ? "text-positive"
                        : "text-muted"
                  }`}
                >
                  {item.kind === "agent" ? t("activity.kindAgent") : item.kind === "money" ? t("activity.kindMoney") : t("activity.kindConfig")}
                </span>
                <span className="font-medium text-white/90">{item.title}</span>
              </div>
              <p className="mt-1 text-sm text-muted">{item.detail}</p>
              <div className="mt-1.5 flex flex-wrap gap-x-4 font-mono text-[11px] text-faint">
                {item.timestamp && (
                  <span>
                    {new Date(item.timestamp * 1000).toLocaleString(dateLocale[locale] ?? "es", {
                      dateStyle: "short",
                      timeStyle: "medium",
                    })}
                  </span>
                )}
                <a
                  href={`${chain.explorerBaseUrl}/tx/${item.txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline-offset-4 hover:text-accent hover:underline"
                >
                  {item.txHash.slice(0, 10)}…{item.txHash.slice(-6)} ↗
                </a>
              </div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function describe(
  t: ReturnType<typeof useTranslation>["t"],
  eventName: string,
  args: Record<string, unknown>,
  chain: ChainDef,
): Omit<FeedItem, "txHash" | "blockNumber" | "timestamp"> | null {
  const usdt = (v: unknown) => `${formatUnits((v as bigint) ?? 0n, 6)} ${chain.stableSymbol}`;
  const weth = (v: unknown) => `${Number(formatUnits((v as bigint) ?? 0n, 18)).toFixed(6)} ${chain.volatileSymbol}`;
  switch (eventName) {
    case "Deposited":
      return {
        kind: "money",
        title: t("activity.depositTitle"),
        detail: t("activity.depositDetail", {
          investable: usdt(args.investableAmount),
          reserve: usdt(args.reserveAmount),
          gasClause:
            args.gasReserveAmount !== undefined
              ? t("activity.depositGasClause", { gas: usdt(args.gasReserveAmount) })
              : "",
        }),
      };
    case "CreationFeeCharged":
      return {
        kind: "money",
        title: t("activity.creationFeeTitle"),
        detail: t("activity.creationFeeDetail", { amount: usdt(args.amount) }),
      };
    case "TargetConfigured":
      return {
        kind: "config",
        title: t("activity.targetConfiguredTitle"),
        detail: t("activity.targetConfiguredDetail", {
          lower: String(args.targetTickLower),
          upper: String(args.targetTickUpper),
          maxRebalances: String(args.maxRebalances),
          reinjection: usdt(args.reinjectionAmount),
          hours: Number(args.periodicRebalanceInterval) / 3600,
          recenterMargin: Number((args.recenterMarginBps as bigint) ?? 0n) / 100,
          topMargin: Number((args.exitTopCeilingMarginBps as bigint) ?? 0n) / 100,
        }),
      };
    case "RiskParamsUpdated":
      return {
        kind: "config",
        title: t("activity.riskParamsTitle"),
        detail: t("activity.riskParamsDetail", {
          slippage: Number(args.maxSlippageBps) / 100,
          deviation: String(args.maxRangeDeviationBps),
        }),
      };
    case "PositionInitialized":
      return {
        kind: "agent",
        title: t("activity.positionInitTitle", { tokenId: String(args.tokenId) }),
        detail: t("activity.positionInitDetail", { amount0: usdt(args.amount0), amount1: weth(args.amount1) }),
      };
    case "Rebalanced": {
      const reinjectedAmount = (args.reinjectedAmount as bigint) ?? 0n;
      return {
        kind: "agent",
        title: t("activity.rebalancedTitle", { tokenId: String(args.newTokenId) }),
        detail:
          reinjectedAmount > 0n
            ? t("activity.rebalancedDetailReinjected", {
                lower: String(args.tickLower),
                upper: String(args.tickUpper),
                amount: usdt(reinjectedAmount),
              })
            : t("activity.rebalancedDetailNoReinjection", {
                lower: String(args.tickLower),
                upper: String(args.tickUpper),
              }),
      };
    }
    case "LpFeesPaidToOwner": {
      const amount1 = (args.amount1 as bigint) ?? 0n;
      return {
        kind: "money",
        title: t("activity.lpFeesTitle"),
        detail: t("activity.lpFeesDetail", {
          amounts: `${usdt(args.amount0)}${amount1 > 0n ? ` + ${weth(amount1)}` : ""}`,
        }),
      };
    }
    case "FeesCollected": {
      const amount1 = (args.amount1 as bigint) ?? 0n;
      return {
        kind: "money",
        title: t("activity.feesCollectedTitle"),
        detail: t("activity.feesCollectedDetail", {
          amounts: `${usdt(args.amount0)}${amount1 > 0n ? ` + ${weth(amount1)}` : ""}`,
        }),
      };
    }
    case "PerformanceFeeCollected": {
      const amount1 = (args.amount1 as bigint) ?? 0n;
      return {
        kind: "money",
        title: t("activity.performanceFeeTitle"),
        detail: t("activity.performanceFeeDetail", {
          amounts: `${usdt(args.amount0)}${amount1 > 0n ? ` + ${weth(amount1)}` : ""}`,
        }),
      };
    }
    case "KeeperGasReimbursed":
      return {
        kind: "agent",
        title: t("activity.gasReimbursedTitle"),
        detail: t("activity.gasReimbursedDetail", { amount: usdt(args.amountUsd) }),
      };
    case "Withdrawn":
      return {
        kind: "money",
        title: t("activity.withdrawnTitle"),
        detail: t("activity.withdrawnDetail", { amount0: usdt(args.amount0), amount1: weth(args.amount1) }),
      };
    case "PositionIncreased":
      return {
        kind: "money",
        title: t("activity.positionIncreasedTitle"),
        detail: t("activity.positionIncreasedDetail", { deposited: usdt(args.usdtAmount), used: usdt(args.used0) }),
      };
    case "ReinjectedIntoPosition":
      return {
        kind: "agent",
        title: t("activity.reinjectedTitle"),
        detail: t("activity.reinjectedDetail", { amount: usdt(args.amount), used: usdt(args.used0) }),
      };
    case "IdleDustSwept": {
      const used1 = (args.used1 as bigint) ?? 0n;
      return {
        kind: "agent",
        title: t("activity.dustSweptTitle"),
        detail: t("activity.dustSweptDetail", {
          amounts: `${usdt(args.used0)}${used1 > 0n ? ` + ${weth(used1)}` : ""}`,
        }),
      };
    }
    case "EmergencyWithdraw":
      return {
        kind: "money",
        title: t("activity.emergencyWithdrawTitle"),
        detail: t("activity.emergencyWithdrawDetail", { amount0: usdt(args.amount0), amount1: weth(args.amount1) }),
      };
    case "OperatorUpdated":
      return {
        kind: "config",
        title: t("activity.operatorUpdatedTitle"),
        detail: String(args.newOperator),
      };
    case "PausedSet":
      return {
        kind: "config",
        title: args.isPaused ? t("activity.pausedTitleOn") : t("activity.pausedTitleOff"),
        detail: args.isPaused ? t("activity.pausedDetailOn") : t("activity.pausedDetailOff"),
      };
    default:
      return null;
  }
}
