const Q = 1.0001;

/** WETH price in USD from the pool's current tick. token0=USDT(6d), token1=WETH(18d).
 * Mirrors agent/src/priceMath.ts — kept in sync manually, it's small and pure. */
export function ethPriceFromTick(tick: number): number {
  const rawRatio = Q ** tick;
  const humanRatio = rawRatio * 1e-12;
  return 1 / humanRatio;
}

export function tickFromEthPrice(priceUsd: number): number {
  const humanRatio = 1 / priceUsd;
  const rawRatio = humanRatio * 1e12;
  return Math.log(rawRatio) / Math.log(Q);
}

export function alignToTickSpacing(tick: number, tickSpacing: number): number {
  return Math.round(tick / tickSpacing) * tickSpacing;
}
