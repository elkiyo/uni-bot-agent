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

/** Raw token0 (USDT, 6d) / token1 (WETH, 18d) amounts a position's liquidity
 * converts to at the given current tick — the same standard Uniswap V3
 * concentrated-liquidity formula used throughout this file. */
export function estimatePositionAmounts(
  input: Pick<PositionValueInput, "liquidity" | "currentTick" | "tickLower" | "tickUpper">,
): { amount0Raw: number; amount1Raw: number } {
  const { liquidity, currentTick, tickLower, tickUpper } = input;
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
  return { amount0Raw: L * (1 / sqrtP - 1 / sqrtPb), amount1Raw: L * (sqrtP - sqrtPa) };
}

/** Estimated USD value of a Uniswap V3 position from its liquidity + range, using
 * the same standard formulas as sizeInitialSwap. Used only to size uni-lab.xyz API
 * calls (A1/B1 in /rc-rlp-rebalance) — not consulted by the contract. */
export function estimatePositionValueUsd(input: PositionValueInput): number {
  const { amount0Raw, amount1Raw } = estimatePositionAmounts(input);
  return amount0Raw * 1e-6 + amount1Raw * 1e-18 * input.ethPriceUsd;
}

/** Target amount1Raw/amount0Raw ratio a range needs at a given tick, for
 * liquidity=1 (scale-invariant — valid for any total amount). Exposed so
 * callers that need the real numeric raw-unit ratio itself, not a
 * value-based swap size — e.g. correcting a swap against a real quote's
 * price impact instead of the pre-swap spot price — don't have to
 * re-derive Uniswap's own tick math themselves. 0 below the range (all
 * token0), Infinity above it (all token1), same convention as
 * sizeInitialSwap/sizeRebalanceSwap. */
export function targetRawRatio(input: { currentTick: number; tickLower: number; tickUpper: number }): number {
  const { currentTick, tickLower, tickUpper } = input;
  if (currentTick <= tickLower) return 0;
  if (currentTick >= tickUpper) return Infinity;
  const sqrtP = sqrtPriceAtTick(currentTick);
  const sqrtPa = sqrtPriceAtTick(tickLower);
  const sqrtPb = sqrtPriceAtTick(tickUpper);
  return ((sqrtP - sqrtPa) * sqrtP * sqrtPb) / (sqrtPb - sqrtP);
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

export interface RebalanceSwapInput {
  currentTick: number;
  /** The NEW range the position is about to be minted into — not the range
   * being closed. */
  newTickLower: number;
  newTickUpper: number;
  /** Whatever's actually sitting in the vault right now (raw units), e.g. after
   * decreaseLiquidity+collect recovers a mix of both tokens from the closed
   * position — unlike sizeInitialSwap, this does NOT assume an all-token0 start. */
  availableToken0Raw: bigint;
  availableToken1Raw: bigint;
  ethPriceUsd: number;
}

export interface RebalanceSwapResult {
  /** true: swap token0 (USDT) -> token1 (WETH). false: swap token1 (WETH) -> token0 (USDT). */
  token0ToToken1: boolean;
  amountIn: bigint;
}

/**
 * Sizes the swap needed to rearrange the vault's recovered (possibly mixed)
 * token0/token1 balance toward the ratio the NEW range actually needs at the
 * current price, before minting. Without this, rebalance() mints with
 * whatever ratio happened to come out of the OLD position — if that doesn't
 * match the new range (routine, since ranges shift every cycle), the
 * mismatched side sits as unminted dust in the vault, invisible to
 * `investableUsdt` accounting for token1. This was confirmed happening live:
 * a position minted ~100% USDT (price sitting at the top of the range, per
 * uni-lab's own pool_setup breakdown) left ~$9.78 of recovered WETH unused.
 */
export function sizeRebalanceSwap(input: RebalanceSwapInput): RebalanceSwapResult {
  const { currentTick, newTickLower, newTickUpper, availableToken0Raw, availableToken1Raw, ethPriceUsd } = input;

  const value0Usd = Number(availableToken0Raw) * 1e-6;
  const value1Usd = Number(availableToken1Raw) * 1e-18 * ethPriceUsd;
  const totalUsd = value0Usd + value1Usd;

  let targetFraction0: number; // target share of total value that should end up as token0
  if (currentTick <= newTickLower) {
    targetFraction0 = 1;
  } else if (currentTick >= newTickUpper) {
    targetFraction0 = 0;
  } else {
    const sqrtP = sqrtPriceAtTick(currentTick);
    const sqrtPa = sqrtPriceAtTick(newTickLower);
    const sqrtPb = sqrtPriceAtTick(newTickUpper);
    const rawRatio = ((sqrtP - sqrtPa) * sqrtP * sqrtPb) / (sqrtPb - sqrtP); // amount1_raw / amount0_raw
    const valueRatio = rawRatio * ethPriceUsd * 1e-12; // USD value of token1 per USD value of token0
    targetFraction0 = 1 / (1 + valueRatio);
  }

  const targetValue0Usd = totalUsd * targetFraction0;
  const delta0Usd = value0Usd - targetValue0Usd; // positive: excess token0, swap some to token1

  // Dust-sized rebalances (<$0.01 off target) aren't worth a swap's gas/slippage.
  if (Math.abs(delta0Usd) < 0.01) {
    return { token0ToToken1: true, amountIn: 0n };
  }

  if (delta0Usd > 0) {
    const amountIn = BigInt(Math.floor(delta0Usd * 1e6));
    return { token0ToToken1: true, amountIn };
  }
  const amountIn = BigInt(Math.floor((-delta0Usd / ethPriceUsd) * 1e18));
  return { token0ToToken1: false, amountIn };
}

/**
 * Adjusts a rebalance swap so at least `feeRaw` (token0/USDT, 6 decimals)
 * survives past it — rebalance() pays the platform fee out of token0 right
 * after this swap runs, and reverts with InsufficientInvestableBalance if
 * there isn't enough. Without this, a range whose ideal ratio is
 * legitimately (or close to) 100% token1 sizes a swap that sends away every
 * last drop of token0, leaving nothing for the fee — confirmed root cause of
 * a real stuck vault in production, 2026-07-16 (vault 0x721e1B69...C94C37).
 * A small deviation from the position's ideal ratio (the fee is usually
 * cents) is worth guaranteeing the tx doesn't revert outright.
 */
export function ensureFeeCoverage(
  swap: RebalanceSwapResult,
  availableToken0Raw: bigint,
  feeRaw: bigint,
  ethPriceUsd: number,
): RebalanceSwapResult {
  if (feeRaw === 0n) return swap;

  if (swap.token0ToToken1) {
    // This swap sends token0 away — cap it so at least `feeRaw` remains.
    const remaining = availableToken0Raw - swap.amountIn;
    if (remaining >= feeRaw) return swap;
    const shortfall = feeRaw - remaining;
    return { ...swap, amountIn: swap.amountIn > shortfall ? swap.amountIn - shortfall : 0n };
  }

  // This swap ADDS token0 (converting token1) — only bump it if the
  // resulting balance would still fall short, which only happens when
  // availableToken0Raw alone is already thinner than the fee.
  const approxOutputRaw = BigInt(Math.floor(Number(swap.amountIn) * ethPriceUsd * 1e-12));
  const remaining = availableToken0Raw + approxOutputRaw;
  if (remaining >= feeRaw) return swap;
  const shortfallUsd = Number(feeRaw - remaining) * 1e-6;
  const extraToken1Raw = BigInt(Math.ceil((shortfallUsd / ethPriceUsd) * 1e18));
  return { ...swap, amountIn: swap.amountIn + extraToken1Raw };
}
