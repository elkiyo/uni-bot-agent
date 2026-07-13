const Q = 1.0001;

function sqrtPriceAtTick(tick: number): number {
  return Math.sqrt(Q ** tick);
}

/**
 * Raw token0/token1 amounts a Uniswap V3 position currently holds, given its
 * liquidity and range, at the pool's live tick. Standard concentrated-liquidity
 * formulas (mirrors agent/src/swapMath.ts's estimatePositionValueUsd, extended
 * to return the per-token split Uniswap's own UI shows instead of just USD).
 */
export function positionAmounts(
  liquidity: bigint,
  currentTick: number,
  tickLower: number,
  tickUpper: number,
): { amount0Raw: number; amount1Raw: number } {
  const L = Number(liquidity);
  const sqrtP = sqrtPriceAtTick(currentTick);
  const sqrtPa = sqrtPriceAtTick(tickLower);
  const sqrtPb = sqrtPriceAtTick(tickUpper);

  if (currentTick <= tickLower) {
    return { amount0Raw: L * (1 / sqrtPa - 1 / sqrtPb), amount1Raw: 0 };
  }
  if (currentTick >= tickUpper) {
    return { amount0Raw: 0, amount1Raw: L * (sqrtPb - sqrtPa) };
  }
  return {
    amount0Raw: L * (1 / sqrtP - 1 / sqrtPb),
    amount1Raw: L * (sqrtP - sqrtPa),
  };
}
