/**
 * Approximate swap sizing for building/rebalancing a Uniswap V3 position.
 *
 * This is a *heuristic* used only to size the keeper's SwapInstruction — the
 * contract doesn't trust it, it just enforces the slippage floor the keeper also
 * supplies (see RangeVault.rebalance/initPosition). A bit of imprecision here
 * shows up as small leftover dust (tracked as investableUsdt), not a safety
 * issue. Plain floating point is fine at this precision; nothing here is
 * consensus-critical.
 *
 * Math: for a Uniswap V3 range [tickLower, tickUpper] at current tick, the ratio
 * of token1 to token0 needed for a balanced (non-wasteful) deposit is the
 * standard concentrated-liquidity ratio:
 *   amount1/amount0 = (sqrtP - sqrtPa) * sqrtP * sqrtPb / (sqrtPb - sqrtP)
 * clamped to the all-token0 / all-token1 cases when price is outside the range.
 */

const Q = 1.0001;

function sqrtPriceAtTick(tick: number): number {
  return Math.sqrt(Q ** tick);
}

/** token0 = USDT (6 decimals), token1 = WETH (18 decimals). */
export interface SwapSizingInput {
  currentTick: number;
  tickLower: number;
  tickUpper: number;
  /** USDT (raw, 6 decimals) currently sitting in the vault, available to deploy. */
  availableToken0Raw: bigint;
  /** Live WETH price in USD, e.g. from the pool's own slot0 — used only to convert
   * the raw token1/token0 ratio into a USD value ratio. */
  ethPriceUsd: number;
}

export interface SwapSizingResult {
  /** true: swap token0 (USDT) for token1 (WETH); this heuristic never suggests the
   * reverse for an all-token0 starting balance, which is the only case it's used for. */
  token0ToToken1: true;
  /** Raw USDT (6 decimals) to swap into WETH. */
  amountIn: bigint;
}

export interface PositionValueInput {
  liquidity: bigint;
  currentTick: number;
  tickLower: number;
  tickUpper: number;
  ethPriceUsd: number;
}

/** Estimated USD value of a Uniswap V3 position from its liquidity + range, using
 * the same standard formulas as sizeInitialSwap. Used only to size uni-lab.xyz API
 * calls (A1/B1 in /rc-rlp-rebalance) — not consulted by the contract. */
export function estimatePositionValueUsd(input: PositionValueInput): number {
  const { liquidity, currentTick, tickLower, tickUpper, ethPriceUsd } = input;
  const L = Number(liquidity);
  const sqrtP = sqrtPriceAtTick(currentTick);
  const sqrtPa = sqrtPriceAtTick(tickLower);
  const sqrtPb = sqrtPriceAtTick(tickUpper);

  let amount0Raw: number;
  let amount1Raw: number;
  if (currentTick <= tickLower) {
    amount0Raw = L * (1 / sqrtPa - 1 / sqrtPb);
    amount1Raw = 0;
  } else if (currentTick >= tickUpper) {
    amount0Raw = 0;
    amount1Raw = L * (sqrtPb - sqrtPa);
  } else {
    amount0Raw = L * (1 / sqrtP - 1 / sqrtPb);
    amount1Raw = L * (sqrtP - sqrtPa);
  }

  return amount0Raw * 1e-6 + amount1Raw * 1e-18 * ethPriceUsd;
}

export function sizeInitialSwap(input: SwapSizingInput): SwapSizingResult {
  const { currentTick, tickLower, tickUpper, availableToken0Raw, ethPriceUsd } = input;

  if (currentTick <= tickLower) {
    // Price below range: a balanced position here is 100% token0. No swap needed.
    return { token0ToToken1: true, amountIn: 0n };
  }
  if (currentTick >= tickUpper) {
    // Price above range: a balanced position is 100% token1. Swap (almost) everything.
    return { token0ToToken1: true, amountIn: availableToken0Raw };
  }

  const sqrtP = sqrtPriceAtTick(currentTick);
  const sqrtPa = sqrtPriceAtTick(tickLower);
  const sqrtPb = sqrtPriceAtTick(tickUpper);

  const rawRatio = ((sqrtP - sqrtPa) * sqrtP * sqrtPb) / (sqrtPb - sqrtP); // amount1_raw / amount0_raw
  const valueRatio = rawRatio * ethPriceUsd * 1e-12; // USD value of token1 per USD value of token0

  // Solve s / (X - s) = valueRatio for s, where X = total value (all in token0 today).
  const fraction = valueRatio / (1 + valueRatio);
  const amountIn = BigInt(Math.floor(Number(availableToken0Raw) * fraction));

  return { token0ToToken1: true, amountIn };
}
