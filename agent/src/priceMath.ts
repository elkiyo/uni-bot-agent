const Q = 1.0001;

/** WETH price in USD from the pool's current tick. token0=USDT(6d), token1=WETH(18d). */
export function ethPriceFromTick(tick: number): number {
  const rawRatio = Q ** tick; // token1_raw per token0_raw
  const humanRatio = rawRatio * 1e-12; // WETH per USDT
  return 1 / humanRatio;
}

/** Inverse of ethPriceFromTick — the tick whose implied ETH price is `priceUsd`. */
export function tickFromEthPrice(priceUsd: number): number {
  const humanRatio = 1 / priceUsd; // WETH per USDT
  const rawRatio = humanRatio * 1e12;
  return Math.log(rawRatio) / Math.log(Q);
}

export function alignToTickSpacing(tick: number, tickSpacing: number): number {
  return Math.round(tick / tickSpacing) * tickSpacing;
}
