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

const Q128 = 1n << 128n;
const Q256 = 1n << 256n;

// feeGrowth values are Solidity uint256 counters that wrap on overflow by
// design (Uniswap V3 relies on unchecked subtraction wrapping correctly in
// 256-bit space) — plain BigInt subtraction can go negative, so every
// difference here has to be re-wrapped into u256 range explicitly.
function wrap256(x: bigint): bigint {
  return ((x % Q256) + Q256) % Q256;
}

/**
 * feeGrowthInside for a range at the CURRENT pool tick — same three-way split
 * (below/inside/above) as Uniswap V3's Tick.getFeeGrowthInside. `outside`
 * values come from the pool's own ticks(tickLower)/ticks(tickUpper) reads.
 */
function feeGrowthInside(
  feeGrowthGlobalX128: bigint,
  feeGrowthOutsideLowerX128: bigint,
  feeGrowthOutsideUpperX128: bigint,
  currentTick: number,
  tickLower: number,
  tickUpper: number,
): bigint {
  const feeGrowthBelow = currentTick >= tickLower ? feeGrowthOutsideLowerX128 : wrap256(feeGrowthGlobalX128 - feeGrowthOutsideLowerX128);
  const feeGrowthAbove = currentTick < tickUpper ? feeGrowthOutsideUpperX128 : wrap256(feeGrowthGlobalX128 - feeGrowthOutsideUpperX128);
  return wrap256(feeGrowthGlobalX128 - feeGrowthBelow - feeGrowthAbove);
}

/**
 * Fees a live position has actually earned right now, INCLUDING what's
 * accrued since its last mint/burn/collect — unlike the position's own
 * tokensOwed0/tokensOwed1 (from positionManager.positions()), which only
 * gets checkpointed on a liquidity-changing call and otherwise sits frozen,
 * often at zero, between rebalances (confirmed in production 2026-07-18: a
 * freshly-minted position showed $0.0000 fees despite the pool actively
 * trading through its range). This is exactly the calculation Uniswap's own
 * app does client-side to show "unclaimed fees" without requiring a
 * transaction first — see Position.update()/Tick.getFeeGrowthInside in the
 * V3 core contracts.
 */
export function uncollectedFeesRaw(params: {
  liquidity: bigint;
  tokensOwed0: bigint;
  tokensOwed1: bigint;
  feeGrowthInside0LastX128: bigint;
  feeGrowthInside1LastX128: bigint;
  feeGrowthGlobal0X128: bigint;
  feeGrowthGlobal1X128: bigint;
  tickLowerOutside0X128: bigint;
  tickLowerOutside1X128: bigint;
  tickUpperOutside0X128: bigint;
  tickUpperOutside1X128: bigint;
  currentTick: number;
  tickLower: number;
  tickUpper: number;
}): { fees0Raw: number; fees1Raw: number } {
  const feeGrowthInside0X128 = feeGrowthInside(
    params.feeGrowthGlobal0X128,
    params.tickLowerOutside0X128,
    params.tickUpperOutside0X128,
    params.currentTick,
    params.tickLower,
    params.tickUpper,
  );
  const feeGrowthInside1X128 = feeGrowthInside(
    params.feeGrowthGlobal1X128,
    params.tickLowerOutside1X128,
    params.tickUpperOutside1X128,
    params.currentTick,
    params.tickLower,
    params.tickUpper,
  );

  const owed0 =
    params.tokensOwed0 + (wrap256(feeGrowthInside0X128 - params.feeGrowthInside0LastX128) * params.liquidity) / Q128;
  const owed1 =
    params.tokensOwed1 + (wrap256(feeGrowthInside1X128 - params.feeGrowthInside1LastX128) * params.liquidity) / Q128;

  return { fees0Raw: Number(owed0), fees1Raw: Number(owed1) };
}
