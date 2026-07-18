"use client";

import { useMemo } from "react";
import { useReadContract, useReadContracts } from "wagmi";
import { formatUnits } from "viem";
import { positionManagerAbi, uniswapV3PoolAbi } from "@/lib/contracts";
import { ethPriceFromTick } from "@/lib/priceMath";
import { positionAmounts, uncollectedFeesRaw } from "@/lib/positionMath";
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

  const position = reads?.[0]?.result as
    | readonly [bigint, string, string, string, number, number, number, bigint, bigint, bigint, bigint, bigint]
    | undefined;
  const slot0 = reads?.[1]?.result as readonly unknown[] | undefined;

  // Stage 2, gated on the position's own range being known: the extra state
  // needed to compute LIVE uncollected fees (see positionMath.ts's
  // uncollectedFeesRaw) — positions()'s own tokensOwed0/1 only gets
  // checkpointed on a mint/burn/collect call, so it sits stale (often zero)
  // between rebalances even while the position is actively earning.
  const { data: feeReads } = useReadContracts({
    contracts: [
      { address: chain.pool, abi: uniswapV3PoolAbi, functionName: "feeGrowthGlobal0X128", chainId: chain.id },
      { address: chain.pool, abi: uniswapV3PoolAbi, functionName: "feeGrowthGlobal1X128", chainId: chain.id },
      {
        address: chain.pool,
        abi: uniswapV3PoolAbi,
        functionName: "ticks",
        args: [position?.[5] ?? 0],
        chainId: chain.id,
      },
      {
        address: chain.pool,
        abi: uniswapV3PoolAbi,
        functionName: "ticks",
        args: [position?.[6] ?? 0],
        chainId: chain.id,
      },
    ],
    query: { enabled: Boolean(position), refetchInterval: 15_000 },
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

  if (!position) return null;

  const [, , , , , tickLower, tickUpper, liquidity, feeGrowthInside0LastX128, feeGrowthInside1LastX128, tokensOwed0, tokensOwed1] =
    position;
  const currentTick = slot0 ? Number(slot0[1]) : undefined;

  // token1/token0 raw price rises with tick, so USD-per-ETH *falls* as the tick
  // rises — the USD range bounds come out swapped and need min/max.
  const priceA = ethPriceFromTick(tickLower, chain.stableIsToken0);
  const priceB = ethPriceFromTick(tickUpper, chain.stableIsToken0);
  const rangeLow = Math.min(priceA, priceB);
  const rangeHigh = Math.max(priceA, priceB);
  const ethPrice = currentTick !== undefined ? ethPriceFromTick(currentTick, chain.stableIsToken0) : undefined;
  const inRange = currentTick !== undefined && currentTick >= tickLower && currentTick <= tickUpper;

  // Same standard concentrated-liquidity formulas Uniswap's own UI uses to
  // show "how much of each token is my position worth right now". amount0Raw/
  // amount1Raw are Uniswap's real token0/token1 — route to stable/volatile
  // based on this chain's actual order (WETH is token0 on Arbitrum, token1 on Celo).
  const amounts =
    currentTick !== undefined ? positionAmounts(liquidity, currentTick, tickLower, tickUpper) : undefined;
  const stableRaw = amounts ? (chain.stableIsToken0 ? amounts.amount0Raw : amounts.amount1Raw) : 0;
  const volatileRaw = amounts ? (chain.stableIsToken0 ? amounts.amount1Raw : amounts.amount0Raw) : 0;
  const usdtAmount = stableRaw / 1e6;
  const wethAmount = volatileRaw / 1e18;
  const usdtValue = usdtAmount; // the stable leg (USDT/USDC) ~= $1
  const wethValue = ethPrice !== undefined ? wethAmount * ethPrice : 0;
  const totalValue = usdtValue + wethValue;
  const wethPct = totalValue > 0 ? (wethValue / totalValue) * 100 : 0;
  const usdtPct = totalValue > 0 ? 100 - wethPct : 0;

  // feeGrowthGlobal0/1X128 + ticks(tickLower/tickUpper) — falls back to the
  // position's own (possibly stale) tokensOwed0/1 until stage 2 loads.
  const feeGrowthGlobal0X128 = feeReads?.[0]?.result as bigint | undefined;
  const feeGrowthGlobal1X128 = feeReads?.[1]?.result as bigint | undefined;
  const tickLowerData = feeReads?.[2]?.result as readonly [bigint, bigint, bigint, bigint, ...unknown[]] | undefined;
  const tickUpperData = feeReads?.[3]?.result as readonly [bigint, bigint, bigint, bigint, ...unknown[]] | undefined;

  let tokensOwed0Live = tokensOwed0;
  let tokensOwed1Live = tokensOwed1;
  if (
    currentTick !== undefined &&
    feeGrowthGlobal0X128 !== undefined &&
    feeGrowthGlobal1X128 !== undefined &&
    tickLowerData &&
    tickUpperData
  ) {
    const live = uncollectedFeesRaw({
      liquidity,
      tokensOwed0,
      tokensOwed1,
      feeGrowthInside0LastX128,
      feeGrowthInside1LastX128,
      feeGrowthGlobal0X128,
      feeGrowthGlobal1X128,
      tickLowerOutside0X128: tickLowerData[2],
      tickLowerOutside1X128: tickLowerData[3],
      tickUpperOutside0X128: tickUpperData[2],
      tickUpperOutside1X128: tickUpperData[3],
      currentTick,
      tickLower,
      tickUpper,
    });
    tokensOwed0Live = BigInt(Math.max(0, Math.floor(live.fees0Raw)));
    tokensOwed1Live = BigInt(Math.max(0, Math.floor(live.fees1Raw)));
  }

  const tokensOwedStable = chain.stableIsToken0 ? tokensOwed0Live : tokensOwed1Live;
  const tokensOwedVolatile = chain.stableIsToken0 ? tokensOwed1Live : tokensOwed0Live;
  const feesUsdtAmount = Number(formatUnits(tokensOwedStable, 6));
  const feesWethAmount = Number(formatUnits(tokensOwedVolatile, 18));
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
              Comisiones acumuladas en tiempo real, calculadas igual que lo hace Uniswap — se
              cobran recién cuando el vault rebalancea o se retira.
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
