"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { formatUnits, parseEventLogs, type Log } from "viem";
import { rangeVaultAbi } from "@/lib/contracts";
import { FACTORY_DEPLOY_BLOCK } from "@/lib/addresses";
import { ethPriceFromTick } from "@/lib/priceMath";
import { getLogsChunked } from "@/lib/getLogsChunked";

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
export function PositionHistory({ address }: { address: `0x${string}` }) {
  const publicClient = usePublicClient();

  const { data: positions } = useQuery({
    queryKey: ["vault-position-history", address],
    enabled: Boolean(publicClient),
    refetchInterval: 20_000,
    queryFn: async (): Promise<PositionRecord[]> => {
      if (!publicClient) return [];
      const logs = await getLogsChunked(publicClient, { address, fromBlock: FACTORY_DEPLOY_BLOCK, toBlock: "latest" });
      const parsed = parseEventLogs({ abi: rangeVaultAbi, logs: logs as Log[] });

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
        const priceA = ethPriceFromTick(e.tickLower);
        const priceB = ethPriceFromTick(e.tickUpper);
        return {
          tokenId: e.tokenId,
          minPrice: Math.min(priceA, priceB),
          maxPrice: Math.max(priceA, priceB),
          reinjectedUsdt: e.reinjectedUsdt,
          createdBlock: e.blockNumber,
          createdTxHash: e.txHash,
          closedBlock: next?.blockNumber,
          closedTxHash: next?.txHash,
          feesUsdt: fees?.amount0 ?? 0n,
          feesWeth: fees?.amount1 ?? 0n,
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

  const fmtDate = (t?: number) =>
    t ? new Date(t * 1000).toLocaleString("es", { dateStyle: "short", timeStyle: "short" }) : "—";

  return (
    <div className="glass mt-10 rounded-2xl p-6 sm:p-8">
      <h2 className="text-xl font-semibold tracking-tight" style={{ fontFamily: "var(--font-display)" }}>
        Historial de posiciones
      </h2>
      <p className="mt-1 text-sm text-muted">
        Cada posición NFT que el agente armó en este vault, con su rango y las comisiones que generó antes de
        cerrarse.
      </p>

      <ol className="mt-6 flex flex-col gap-4">
        {positions.map((p) => (
          <li key={p.tokenId.toString()} className="rounded-xl border border-hairline p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-sm text-white/90">
                Posición #{p.tokenId.toString()} · ${p.minPrice.toFixed(2)} – ${p.maxPrice.toFixed(2)}
              </span>
              {p.isOpen ? (
                <span className="eyebrow !border-positive/40 !px-3 !py-1 !text-positive">Activa</span>
              ) : (
                <span className="eyebrow !px-3 !py-1">Cerrada</span>
              )}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">Creada</p>
                <p className="mt-0.5 text-white/90">{fmtDate(p.createdAt)}</p>
              </div>
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">Cerrada</p>
                <p className="mt-0.5 text-white/90">{p.isOpen ? "—" : fmtDate(p.closedAt)}</p>
              </div>
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
                  Comisiones ganadas
                </p>
                <p className="mt-0.5 text-positive">
                  {p.isOpen
                    ? "en curso"
                    : `${formatUnits(p.feesUsdt, 6)} USDT${p.feesWeth > 0n ? ` + ${Number(formatUnits(p.feesWeth, 18)).toFixed(6)} WETH` : ""}`}
                </p>
              </div>
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">Reinyección al abrir</p>
                <p className="mt-0.5 text-white/90">
                  {p.reinjectedUsdt > 0n ? `${formatUnits(p.reinjectedUsdt, 6)} USDT` : "sin reinyección"}
                </p>
              </div>
            </div>
            <a
              href={`https://celoscan.io/tx/${p.createdTxHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-block font-mono text-[11px] text-faint underline-offset-4 hover:text-accent hover:underline"
            >
              tx de apertura: {p.createdTxHash.slice(0, 10)}…{p.createdTxHash.slice(-6)} ↗
            </a>
          </li>
        ))}
      </ol>
    </div>
  );
}
