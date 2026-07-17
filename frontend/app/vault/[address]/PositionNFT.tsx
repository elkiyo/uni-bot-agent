"use client";

import { useMemo } from "react";
import { useReadContract, useReadContracts } from "wagmi";
import { formatUnits } from "viem";
import { positionManagerAbi, uniswapV3PoolAbi } from "@/lib/contracts";
import { ethPriceFromTick } from "@/lib/priceMath";
import { positionAmounts } from "@/lib/positionMath";
import type { ChainDef } from "@/lib/chains";

/**
 * Renders the actual Uniswap V3 position NFT — the SVG art is generated fully
 * on-chain by the NonfungiblePositionManager and shipped inside tokenURI() as
 * base64 JSON — plus a composition breakdown styled after Uniswap's own
 * position page (value + volatile/stable split bar, fees-earned card).
 */
export function PositionNFT({ tokenId, chain }: { tokenId: bigint; chain: ChainDef }) {
  const { data: uri } = useReadContract({
    address: chain.positionManager,
    abi: positionManagerAbi,
    functionName: "tokenURI",
    args: [tokenId],
    chainId: chain.id,
  });

  const { data: reads } = useReadContracts({
    contracts: [
      {
        address: chain.positionManager,
        abi: positionManagerAbi,
        functionName: "positions",
        args: [tokenId],
        chainId: chain.id,
      },
      { address: chain.pool, abi: uniswapV3PoolAbi, functionName: "slot0", chainId: chain.id },
    ],
    query: { refetchInterval: 15_000 },
  });

  const image = useMemo(() => {
    if (!uri) return undefined;
    try {
      const json = JSON.parse(atob((uri as string).split(",")[1]));
      return json.image as string;
    } catch {
      return undefined;
    }
  }, [uri]);

  const position = reads?.[0]?.result as
    | readonly [bigint, string, string, string, number, number, number, bigint, bigint, bigint, bigint, bigint]
    | undefined;
  const slot0 = reads?.[1]?.result as readonly unknown[] | undefined;

  if (!position) return null;

  const [, , , , , tickLower, tickUpper, liquidity, , , tokensOwed0, tokensOwed1] = position;
  const currentTick = slot0 ? Number(slot0[1]) : undefined;

  // token1/token0 raw price rises with tick, so USD-per-ETH *falls* as the tick
  // rises — the USD range bounds come out swapped and need min/max.
  const priceA = ethPriceFromTick(tickLower);
  const priceB = ethPriceFromTick(tickUpper);
  const rangeLow = Math.min(priceA, priceB);
  const rangeHigh = Math.max(priceA, priceB);
  const ethPrice = currentTick !== undefined ? ethPriceFromTick(currentTick) : undefined;
  const inRange = currentTick !== undefined && currentTick >= tickLower && currentTick <= tickUpper;

  // Same standard concentrated-liquidity formulas Uniswap's own UI uses to
  // show "how much of each token is my position worth right now".
  const amounts =
    currentTick !== undefined ? positionAmounts(liquidity, currentTick, tickLower, tickUpper) : undefined;
  const usdtAmount = amounts ? amounts.amount0Raw / 1e6 : 0;
  const wethAmount = amounts ? amounts.amount1Raw / 1e18 : 0;
  const usdtValue = usdtAmount; // the stable leg (USDT/USDC) ~= $1
  const wethValue = ethPrice !== undefined ? wethAmount * ethPrice : 0;
  const totalValue = usdtValue + wethValue;
  const wethPct = totalValue > 0 ? (wethValue / totalValue) * 100 : 0;
  const usdtPct = totalValue > 0 ? 100 - wethPct : 0;

  const feesUsdtAmount = Number(formatUnits(tokensOwed0, 6));
  const feesWethAmount = Number(formatUnits(tokensOwed1, 18));
  const feesUsdtValue = feesUsdtAmount;
  const feesWethValue = ethPrice !== undefined ? feesWethAmount * ethPrice : 0;
  const feesTotal = feesUsdtValue + feesWethValue;
  const feesWethPct = feesTotal > 0 ? (feesWethValue / feesTotal) * 100 : 50;
  const feesUsdtPct = feesTotal > 0 ? 100 - feesWethPct : 50;

  return (
    <div className="glass mt-10 rounded-2xl p-6 sm:p-8">
      <div className="flex flex-wrap items-center gap-3">
        <h2
          className="text-xl font-semibold tracking-tight"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Posición NFT #{String(tokenId)}
        </h2>
        {inRange ? (
          <span className="eyebrow !border-positive/40 !text-positive">Dentro del rango</span>
        ) : (
          <span className="eyebrow !border-negative/40 !text-negative">Fuera de rango</span>
        )}
        <span className="eyebrow">
          {chain.stableSymbol} / {chain.volatileSymbol} · {chain.feeTier / 10_000}%
        </span>
      </div>
      <p className="mt-1 text-sm text-muted">
        Arte generado 100% on-chain por el contrato de Uniswap V3 — el NFT vive dentro del
        vault, nunca en la wallet del operador.
      </p>

      <div className="mt-6 grid gap-8 lg:grid-cols-[260px_1fr]">
        {/* On-chain NFT art */}
        <div className="mx-auto w-full max-w-64">
          {image ? (
            // eslint-disable-next-line @next/next/no-img-element -- data: URI SVG from chain, next/image can't optimize it
            <img
              src={image}
              alt={`Uniswap V3 position #${String(tokenId)}`}
              className="w-full rounded-2xl border border-hairline"
            />
          ) : (
            <div className="grid aspect-[290/500] w-full place-items-center rounded-2xl border border-hairline bg-white/[0.02]">
              <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-faint">
                Cargando NFT…
              </span>
            </div>
          )}
          <a
            href={`${chain.explorerBaseUrl}/nft/${chain.positionManager}/${String(tokenId)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 block text-center font-mono text-[11px] uppercase tracking-[0.14em] text-muted underline-offset-4 hover:text-accent hover:underline"
          >
            Ver NFT en el explorer →
          </a>
        </div>

        {/* Uniswap-style breakdown */}
        <div className="flex flex-col gap-4">
          <div className="glass rounded-2xl p-5">
            <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">Posición</span>
            <p
              className="mt-1 text-2xl font-semibold tabular-nums"
              style={{ fontFamily: "var(--font-display)" }}
            >
              ${totalValue.toFixed(2)}
            </p>
            <CompositionBar leftPct={wethPct} />
            <div className="mt-3 flex flex-col gap-2 text-sm">
              <TokenRow
                label={chain.volatileSymbol}
                pct={wethPct}
                usd={wethValue}
                native={`${wethAmount.toFixed(4)} ${chain.volatileSymbol}`}
              />
              <TokenRow
                label={chain.stableSymbol}
                pct={usdtPct}
                usd={usdtValue}
                native={`${usdtAmount.toFixed(2)} ${chain.stableSymbol}`}
              />
            </div>
          </div>

          <div className="glass rounded-2xl p-5">
            <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">
              Comisiones ganadas
            </span>
            <p
              className="mt-1 text-2xl font-semibold tabular-nums text-accent"
              style={{ fontFamily: "var(--font-display)" }}
            >
              ${feesTotal.toFixed(4)}
            </p>
            <CompositionBar leftPct={feesWethPct} />
            <div className="mt-3 flex flex-col gap-2 text-sm">
              <TokenRow
                label={chain.volatileSymbol}
                pct={feesWethPct}
                usd={feesWethValue}
                native={`${feesWethAmount.toFixed(6)} ${chain.volatileSymbol}`}
              />
              <TokenRow
                label={chain.stableSymbol}
                pct={feesUsdtPct}
                usd={feesUsdtValue}
                native={`${feesUsdtAmount.toFixed(4)} ${chain.stableSymbol}`}
              />
            </div>
            <p className="mt-3 text-xs text-faint">
              Se acredita al cerrar la posición en cada rebalanceo — puede no reflejar fees
              acumuladas desde el último evento en tiempo real.
            </p>
          </div>

          <div className="glass rounded-2xl p-5">
            <div className="flex items-baseline justify-between">
              <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">
                Rango de precio
              </span>
              <span className="font-mono text-[11px] text-faint">ticks [{tickLower}, {tickUpper}]</span>
            </div>
            <div className="mt-2 flex items-baseline justify-between text-sm">
              <span className="text-white/90">
                Mín. <span className="font-semibold">${rangeLow.toFixed(2)}</span>
              </span>
              <span className="text-white/90">
                Máx. <span className="font-semibold">${rangeHigh.toFixed(2)}</span>
              </span>
            </div>
            {ethPrice !== undefined && (
              <p className="mt-2 text-xs text-faint">
                Precio actual: ${ethPrice.toFixed(2)} · {chain.stableSymbol}/{chain.volatileSymbol}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function CompositionBar({ leftPct }: { leftPct: number }) {
  return (
    <div className="mt-3 flex h-1.5 w-full overflow-hidden rounded-full bg-white/10">
      <div className="h-full bg-accent" style={{ width: `${Math.min(100, Math.max(0, leftPct))}%` }} />
      <div className="h-full flex-1 bg-white/25" />
    </div>
  );
}

function TokenRow({
  label,
  pct,
  usd,
  native,
}: {
  label: string;
  pct: number;
  usd: number;
  native: string;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted">
        {label} <span className="text-faint">· {pct.toFixed(1)}%</span>
      </span>
      <span className="text-right text-white/90">
        ${usd.toFixed(2)} <span className="text-faint">· {native}</span>
      </span>
    </div>
  );
}
