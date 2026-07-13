"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { formatUnits, parseEventLogs, type Log } from "viem";
import { rangeVaultAbi } from "@/lib/contracts";
import { FACTORY_DEPLOY_BLOCK } from "@/lib/addresses";

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
 * event (UniLabFeePaid, PositionInitialized, Rebalanced, ...), so the feed is
 * reconstructed straight from the RPC — no backend, and it shows the keeper
 * acting in real time (10s polling) during a demo.
 */
export function ActivityFeed({ address }: { address: `0x${string}` }) {
  const publicClient = usePublicClient();

  const { data: items } = useQuery({
    queryKey: ["vault-activity", address],
    enabled: Boolean(publicClient),
    refetchInterval: 10_000,
    queryFn: async (): Promise<FeedItem[]> => {
      if (!publicClient) return [];
      const logs = await publicClient.getLogs({
        address,
        fromBlock: FACTORY_DEPLOY_BLOCK,
        toBlock: "latest",
      });
      const parsed = parseEventLogs({ abi: rangeVaultAbi, logs: logs as Log[] });

      const feed: FeedItem[] = [];
      for (const log of parsed) {
        const item = describe(log.eventName, log.args as Record<string, unknown>);
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
          Actividad on-chain
        </h2>
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-positive opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-positive" />
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">en vivo</span>
      </div>
      <p className="mt-1 text-sm text-muted">
        Cada acción del agente y del owner, leída directo de los eventos del contrato.
      </p>

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
                  {item.kind === "agent" ? "agente" : item.kind === "money" ? "fondos" : "config"}
                </span>
                <span className="font-medium text-white/90">{item.title}</span>
              </div>
              <p className="mt-1 text-sm text-muted">{item.detail}</p>
              <div className="mt-1.5 flex flex-wrap gap-x-4 font-mono text-[11px] text-faint">
                {item.timestamp && (
                  <span>{new Date(item.timestamp * 1000).toLocaleString("es", { dateStyle: "short", timeStyle: "medium" })}</span>
                )}
                <a
                  href={`https://celoscan.io/tx/${item.txHash}`}
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
  eventName: string,
  args: Record<string, unknown>,
): Omit<FeedItem, "txHash" | "blockNumber" | "timestamp"> | null {
  const usdt = (v: unknown) => `${formatUnits((v as bigint) ?? 0n, 6)} USDT`;
  switch (eventName) {
    case "Deposited":
      return {
        kind: "money",
        title: "Depósito del owner",
        detail: `Invertible ${usdt(args.investableAmount)} · presupuesto uni-lab ${usdt(args.usdtBudgetAmount)} · reserva ${usdt(args.reserveAmount)}`,
      };
    case "TargetConfigured":
      return {
        kind: "config",
        title: "Configuración del agente",
        detail: `Rango objetivo [${args.targetTickLower}, ${args.targetTickUpper}] · máx. ${args.maxRebalances} rebalanceos · reinyección ${usdt(args.reinjectionAmount)} · periódico cada ${Number(args.periodicRebalanceInterval) / 3600}h`,
      };
    case "RiskParamsUpdated":
      return {
        kind: "config",
        title: "Límites de riesgo",
        detail: `Slippage máx. ${Number(args.maxSlippageBps) / 100}% · desviación de rango máx. ${args.maxRangeDeviationBps} ticks`,
      };
    case "UniLabFeePaid":
      return {
        kind: "agent",
        title: "Consulta pagada a uni-lab.xyz",
        detail: `0.5 USDT transferidos on-chain desde el vault · presupuesto restante ${usdt(args.remainingBudget)}`,
      };
    case "PositionInitialized":
      return {
        kind: "agent",
        title: `Posición creada — NFT #${args.tokenId}`,
        detail: `El agente armó la posición con ${usdt(args.amount0)} + ${Number(formatUnits((args.amount1 as bigint) ?? 0n, 18)).toFixed(6)} WETH`,
      };
    case "Rebalanced":
      return {
        kind: "agent",
        title: `Rebalanceo — nueva posición #${args.newTokenId}`,
        detail: `Nuevo rango [${args.tickLower}, ${args.tickUpper}] · ${args.reinjected ? "con reinyección" : "sin reinyección"} · fee al operador ${usdt(args.feePaid)}`,
      };
    case "Withdrawn":
      return {
        kind: "money",
        title: "Retiro del owner",
        detail: `${usdt(args.amount0)} + ${Number(formatUnits((args.amount1 as bigint) ?? 0n, 18)).toFixed(6)} WETH devueltos al owner`,
      };
    case "EmergencyWithdraw":
      return {
        kind: "money",
        title: "Retiro de emergencia",
        detail: `${usdt(args.amount0)} + ${Number(formatUnits((args.amount1 as bigint) ?? 0n, 18)).toFixed(6)} WETH devueltos al owner (vault pausado)`,
      };
    case "OperatorUpdated":
      return {
        kind: "config",
        title: "Operador actualizado",
        detail: String(args.newOperator),
      };
    case "PausedSet":
      return {
        kind: "config",
        title: args.isPaused ? "Vault pausado" : "Vault reanudado",
        detail: args.isPaused
          ? "El agente no puede operar hasta que el owner reanude"
          : "El agente puede volver a operar",
      };
    default:
      return null;
  }
}
