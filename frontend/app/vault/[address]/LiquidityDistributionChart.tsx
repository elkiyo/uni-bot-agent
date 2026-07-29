"use client";

import { useMemo } from "react";
import { ResponsiveContainer, ComposedChart, Area, XAxis, YAxis, Tooltip, ReferenceLine, CartesianGrid } from "recharts";
import { positionAmounts } from "@/lib/positionMath";
import { ethPriceFromTick } from "@/lib/priceMath";
import { useTranslation } from "@/lib/i18n/useTranslation";

const SAMPLE_POINTS = 90;
// How far past each edge of the position's own range to keep sampling, as a
// fraction of the range's own width — lets the chart show the position
// already fully one-sided a bit before/after Min/Max (same as Uniswap's own
// position-creation preview), instead of the curve stopping dead at the
// boundary with no visual context for "what happens if price keeps moving".
const PADDING_FRACTION = 0.35;

/**
 * Real Uniswap V3 concentrated-liquidity composition curve for THIS position
 * — not a generic illustration. Reuses positionAmounts (the same standard
 * formula PositionNFT's own "$XX.XX" figure is built from) sampled across a
 * range of hypothetical ticks instead of just the pool's live one, so the
 * owner can see exactly how many of each token they'd end up holding at any
 * price between (and a bit past) their own Min/Max — including the two
 * limits explicitly, which is what "con cuántos tokens saldría por cada uno
 * de los límites" asks for.
 */
export function LiquidityDistributionChart({
  liquidity,
  tickLower,
  tickUpper,
  currentTick,
  stableIsToken0,
  stableDecimals,
  volatileDecimals,
  stableSymbol,
  volatileSymbol,
}: {
  liquidity: bigint;
  tickLower: number;
  tickUpper: number;
  currentTick: number;
  stableIsToken0: boolean;
  stableDecimals: number;
  volatileDecimals: number;
  stableSymbol: string;
  volatileSymbol: string;
}) {
  const { t } = useTranslation();

  const { curve, rangeLow, rangeHigh, currentPrice, atLow, atHigh } = useMemo(() => {
    const toStableVolatile = (amount0Raw: number, amount1Raw: number) => ({
      volatile: (stableIsToken0 ? amount1Raw : amount0Raw) / 10 ** volatileDecimals,
      stable: (stableIsToken0 ? amount0Raw : amount1Raw) / 10 ** stableDecimals,
    });

    const width = tickUpper - tickLower;
    const padding = Math.max(width * PADDING_FRACTION, 1);
    const fromTick = tickLower - padding;
    const toTick = tickUpper + padding;
    const step = (toTick - fromTick) / SAMPLE_POINTS;

    const points: { price: number; volatile: number; stable: number }[] = [];
    for (let i = 0; i <= SAMPLE_POINTS; i++) {
      const tick = fromTick + step * i;
      const { amount0Raw, amount1Raw } = positionAmounts(liquidity, tick, tickLower, tickUpper);
      const { volatile, stable } = toStableVolatile(amount0Raw, amount1Raw);
      const price = ethPriceFromTick(tick, stableIsToken0, stableDecimals, volatileDecimals);
      points.push({ price, volatile, stable });
    }
    // ethPriceFromTick's direction flips with stableIsToken0 — recharts
    // needs the X series sorted ascending or the curve draws zig-zagged.
    points.sort((a, b) => a.price - b.price);

    const priceA = ethPriceFromTick(tickLower, stableIsToken0, stableDecimals, volatileDecimals);
    const priceB = ethPriceFromTick(tickUpper, stableIsToken0, stableDecimals, volatileDecimals);
    const lowTickAmounts = positionAmounts(liquidity, tickLower, tickLower, tickUpper);
    const highTickAmounts = positionAmounts(liquidity, tickUpper, tickLower, tickUpper);
    const lowAmounts = toStableVolatile(lowTickAmounts.amount0Raw, lowTickAmounts.amount1Raw);
    const highAmounts = toStableVolatile(highTickAmounts.amount0Raw, highTickAmounts.amount1Raw);
    // Whichever of tickLower/tickUpper is numerically lower isn't necessarily
    // the LOW price — same tick/price inversion as everywhere else in this
    // file (stableIsToken0 flips which direction price moves with tick).
    const lowIsLowerTick = priceA <= priceB;

    return {
      curve: points,
      rangeLow: Math.min(priceA, priceB),
      rangeHigh: Math.max(priceA, priceB),
      currentPrice: ethPriceFromTick(currentTick, stableIsToken0, stableDecimals, volatileDecimals),
      atLow: lowIsLowerTick ? lowAmounts : highAmounts,
      atHigh: lowIsLowerTick ? highAmounts : lowAmounts,
    };
  }, [currentTick, liquidity, stableDecimals, stableIsToken0, tickLower, tickUpper, volatileDecimals]);

  return (
    <div className="glass mt-4 rounded-2xl p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">
          {t("positionNft.liquidityDistribution")}
        </span>
        <div className="flex items-center gap-4 text-xs">
          <span className="flex items-center gap-1.5 text-muted">
            <span className="inline-block h-2 w-2 rounded-full bg-accent" /> {volatileSymbol}
          </span>
          <span className="flex items-center gap-1.5 text-muted">
            <span className="inline-block h-2 w-2 rounded-full bg-[#5ee6ff]" /> {stableSymbol}
          </span>
        </div>
      </div>
      <div className="mt-3" style={{ width: "100%", height: 240 }}>
        <ResponsiveContainer minWidth={200} minHeight={200}>
          <ComposedChart data={curve} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1b1b1b" />
            <XAxis
              dataKey="price"
              type="number"
              domain={["dataMin", "dataMax"]}
              stroke="#71717a"
              fontSize={11}
              tickLine={false}
              tickFormatter={(v) => `$${Number(v).toFixed(0)}`}
            />
            <YAxis
              yAxisId="volatile"
              orientation="left"
              stroke="#fcff52"
              fontSize={11}
              tickLine={false}
              tickFormatter={(v) => Number(v).toFixed(3)}
            />
            <YAxis
              yAxisId="stable"
              orientation="right"
              stroke="#5ee6ff"
              fontSize={11}
              tickLine={false}
              tickFormatter={(v) => `$${Number(v).toFixed(0)}`}
            />
            <Tooltip
              contentStyle={{ background: "#0a0a0a", border: "1px solid #1b1b1b", borderRadius: 8, fontSize: 12 }}
              labelFormatter={(v) => `${t("positionNft.currentPriceLabel")}: $${Number(v).toFixed(2)}`}
              formatter={(value: unknown, name: unknown) =>
                name === volatileSymbol
                  ? [`${Number(value).toFixed(6)} ${volatileSymbol}`, volatileSymbol]
                  : [`$${Number(value).toFixed(2)}`, stableSymbol]
              }
            />
            <ReferenceLine x={rangeLow} yAxisId="volatile" stroke="#8b8b8b" strokeDasharray="4 4" />
            <ReferenceLine x={rangeHigh} yAxisId="volatile" stroke="#8b8b8b" strokeDasharray="4 4" />
            <ReferenceLine
              x={currentPrice}
              yAxisId="volatile"
              stroke="#ffffff"
              strokeWidth={1.5}
              label={{ value: t("positionNft.currentLabel"), position: "top", fill: "#ffffff", fontSize: 11 }}
            />
            <Area
              yAxisId="volatile"
              type="stepAfter"
              dataKey="volatile"
              name={volatileSymbol}
              stroke="#fcff52"
              fill="#fcff52"
              fillOpacity={0.15}
              strokeWidth={2}
            />
            <Area
              yAxisId="stable"
              type="stepAfter"
              dataKey="stable"
              name={stableSymbol}
              stroke="#5ee6ff"
              fill="#5ee6ff"
              fillOpacity={0.12}
              strokeWidth={2}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
        <div className="rounded-xl border border-hairline bg-white/[0.02] p-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
            {t("positionNft.atLowerLimit", { price: rangeLow.toFixed(2) })}
          </p>
          <p className="mt-1 tabular-nums text-white/90">
            {atLow.volatile.toFixed(6)} {volatileSymbol}
          </p>
          <p className="tabular-nums text-white/60">
            {atLow.stable.toFixed(2)} {stableSymbol}
          </p>
        </div>
        <div className="rounded-xl border border-hairline bg-white/[0.02] p-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
            {t("positionNft.atUpperLimit", { price: rangeHigh.toFixed(2) })}
          </p>
          <p className="mt-1 tabular-nums text-white/90">
            {atHigh.volatile.toFixed(6)} {volatileSymbol}
          </p>
          <p className="tabular-nums text-white/60">
            {atHigh.stable.toFixed(2)} {stableSymbol}
          </p>
        </div>
      </div>
    </div>
  );
}
