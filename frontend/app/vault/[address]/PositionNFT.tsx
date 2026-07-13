"use client";

import { useMemo } from "react";
import { useReadContract, useReadContracts } from "wagmi";
import { formatUnits } from "viem";
import { positionManagerAbi, uniswapV3PoolAbi } from "@/lib/contracts";
import { POSITION_MANAGER, POOL } from "@/lib/addresses";
import { ethPriceFromTick } from "@/lib/priceMath";

/**
 * Renders the actual Uniswap V3 position NFT — the SVG art is generated fully
 * on-chain by the NonfungiblePositionManager and shipped inside tokenURI() as
 * base64 JSON — alongside the live position data (range in USD, current price,
 * in/out-of-range status, liquidity, last-recorded uncollected fees).
 */
export function PositionNFT({ tokenId }: { tokenId: bigint }) {
  const { data: uri } = useReadContract({
    address: POSITION_MANAGER,
    abi: positionManagerAbi,
    functionName: "tokenURI",
    args: [tokenId],
  });

  const { data: reads } = useReadContracts({
    contracts: [
      { address: POSITION_MANAGER, abi: positionManagerAbi, functionName: "positions", args: [tokenId] },
      { address: POOL, abi: uniswapV3PoolAbi, functionName: "slot0" },
    ],
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
  const currentPrice = currentTick !== undefined ? ethPriceFromTick(currentTick) : undefined;
  const inRange =
    currentTick !== undefined && currentTick >= tickLower && currentTick <= tickUpper;

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
          <span className="eyebrow !border-positive/40 !text-positive">En rango · generando fees</span>
        ) : (
          <span className="eyebrow !border-negative/40 !text-negative">Fuera de rango</span>
        )}
      </div>
      <p className="mt-1 text-sm text-muted">
        Arte generado 100% on-chain por el contrato de Uniswap V3 — el NFT vive dentro del
        vault, nunca en la wallet del operador.
      </p>

      <div className="mt-6 grid gap-8 sm:grid-cols-[280px_1fr]">
        {/* On-chain NFT art */}
        <div className="mx-auto w-full max-w-70">
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
        </div>

        {/* Position data */}
        <dl className="flex flex-col gap-3 self-center text-sm">
          <InfoRow k="Rango de precio" v={`$${rangeLow.toFixed(2)} – $${rangeHigh.toFixed(2)}`} strong />
          <InfoRow
            k="Precio actual ETH"
            v={currentPrice !== undefined ? `$${currentPrice.toFixed(2)}` : "…"}
          />
          <InfoRow k="Ticks" v={`[${tickLower}, ${tickUpper}]`} mono />
          <div className="my-1 border-t border-hairline" />
          <InfoRow k="Liquidez (L)" v={liquidity.toString()} mono />
          <InfoRow
            k="Fees sin cobrar (últ. registro)"
            v={`${formatUnits(tokensOwed0, 6)} USDT · ${Number(formatUnits(tokensOwed1, 18)).toFixed(6)} WETH`}
          />
          <div className="my-1 border-t border-hairline" />
          <InfoRow k="Par" v="USDT / WETH · 0.3%" />
          <a
            href={`https://celoscan.io/nft/${POSITION_MANAGER}/${String(tokenId)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 font-mono text-[11px] uppercase tracking-[0.14em] text-muted underline-offset-4 hover:text-accent hover:underline"
          >
            Ver NFT en Celoscan →
          </a>
        </dl>
      </div>
    </div>
  );
}

function InfoRow({ k, v, strong, mono }: { k: string; v: string; strong?: boolean; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-muted">{k}</dt>
      <dd
        className={`text-right ${strong ? "font-semibold text-accent" : "text-white/90"} ${mono ? "font-mono text-xs" : ""}`}
      >
        {v}
      </dd>
    </div>
  );
}
