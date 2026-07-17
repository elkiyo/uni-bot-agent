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
 *
 * Everything below works in STABLE/VOLATILE terms (business meaning), not raw
 * token0/token1 (Uniswap's address-sorted slots) — the two only coincide on
 * Celo (USDT<WETH). On Arbitrum, WETH<USDC, so token0 is the VOLATILE leg.
 * Callers convert to/from real token0/token1 (which mint()/increaseLiquidity()
 * and SwapInstruction.token0ToToken1 require) via `chain.stableIsToken0` —
 * see rebalancer.ts's `toSwapInstruction()`. Confirmed in production
 * 2026-07-17: code that assumed token0=stable unconditionally sized swaps in
 * the wrong direction and computed investableUsdt from the wrong raw balance
 * on Arbitrum — see RangeVault.sol's class docstring for the on-chain half.
 */

const Q = 1.0001;

function sqrtPriceAtTick(tick: number): number {
  return Math.sqrt(Q ** tick);
}

export interface SwapSizingInput {
  currentTick: number;
  tickLower: number;
  tickUpper: number;
  /** Stable-token (6 decimals) currently sitting in the vault, available to deploy. */
  availableStableRaw: bigint;
  /** Live WETH price in USD, e.g. from the pool's own slot0 — used only to convert
   * the raw token1/token0 ratio into a USD value ratio. */
  ethPriceUsd: number;
}

export interface SwapSizingResult {
  /** true: sell the stable leg for the volatile leg; this heuristic never
   * suggests the reverse for an all-stable starting balance, which is the
   * only case it's used for. */
  sellStable: true;
  /** Raw stable-token (6 decimals) amount to swap into the volatile leg. */
  amountIn: bigint;
}

export interface PositionValueInput {
  liquidity: bigint;
  currentTick: number;
  tickLower: number;
  tickUpper: number;
  ethPriceUsd: number;
}

/** Raw token0/token1 amounts a position's liquidity converts to at the given
 * current tick — the same standard Uniswap V3 concentrated-liquidity formula
 * used throughout this file. Deliberately in real token0/token1 terms (not
 * stable/volatile) since that's what Uniswap's own math operates on; callers
 * map to stable/volatile themselves via stableIsToken0. */
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
export function estimatePositionValueUsd(input: PositionValueInput & { stableIsToken0: boolean }): number {
  const { amount0Raw, amount1Raw } = estimatePositionAmounts(input);
  const stableRaw = input.stableIsToken0 ? amount0Raw : amount1Raw;
  const volatileRaw = input.stableIsToken0 ? amount1Raw : amount0Raw;
  return stableRaw * 1e-6 + volatileRaw * 1e-18 * input.ethPriceUsd;
}

/** Target fraction of TOTAL VALUE that should end up as the stable leg, for a
 * range [tickLower, tickUpper] at currentTick — 1 below the range (all
 * stable), 0 above it (all volatile), the standard ratio formula in between.
 * `stableIsToken0` only affects which side of the raw token1/token0 ratio the
 * ethPriceUsd multiplier applies to; the underlying Uniswap math is the same
 * either way. */
function targetStableFraction(input: {
  currentTick: number;
  tickLower: number;
  tickUpper: number;
  ethPriceUsd: number;
  stableIsToken0: boolean;
}): number {
  const { currentTick, tickLower, tickUpper, ethPriceUsd, stableIsToken0 } = input;
  let fraction0: number; // fraction of value that should be real-token0
  if (currentTick <= tickLower) {
    fraction0 = 1;
  } else if (currentTick >= tickUpper) {
    fraction0 = 0;
  } else {
    const sqrtP = sqrtPriceAtTick(currentTick);
    const sqrtPa = sqrtPriceAtTick(tickLower);
    const sqrtPb = sqrtPriceAtTick(tickUpper);
    const rawRatio = ((sqrtP - sqrtPa) * sqrtP * sqrtPb) / (sqrtPb - sqrtP); // amount1_raw / amount0_raw
    const decimalsExp = stableIsToken0 ? 6 - 18 : 18 - 6;
    const price0 = stableIsToken0 ? 1 : ethPriceUsd;
    const price1 = stableIsToken0 ? ethPriceUsd : 1;
    const valueRatio = rawRatio * 10 ** decimalsExp * (price1 / price0); // value1Usd / value0Usd
    fraction0 = 1 / (1 + valueRatio);
  }
  return stableIsToken0 ? fraction0 : 1 - fraction0;
}

/** Target amount1Raw/amount0Raw ratio a range needs at a given tick, for
 * liquidity=1 (scale-invariant — valid for any total amount). Exposed so
 * callers that need the real numeric raw-unit ratio itself, not a
 * value-based swap size — e.g. correcting a swap against a real quote's
 * price impact instead of the pre-swap spot price — don't have to
 * re-derive Uniswap's own tick math themselves. 0 below the range (all
 * token0), Infinity above it (all token1), same convention as
 * sizeInitialSwap/sizeRebalanceSwap. Real token0/token1 terms, independent
 * of stableIsToken0. */
export function targetRawRatio(input: { currentTick: number; tickLower: number; tickUpper: number }): number {
  const { currentTick, tickLower, tickUpper } = input;
  if (currentTick <= tickLower) return 0;
  if (currentTick >= tickUpper) return Infinity;
  const sqrtP = sqrtPriceAtTick(currentTick);
  const sqrtPa = sqrtPriceAtTick(tickLower);
  const sqrtPb = sqrtPriceAtTick(tickUpper);
  return ((sqrtP - sqrtPa) * sqrtP * sqrtPb) / (sqrtPb - sqrtP);
}

export function sizeInitialSwap(input: SwapSizingInput & { stableIsToken0: boolean }): SwapSizingResult {
  const { currentTick, tickLower, tickUpper, availableStableRaw, ethPriceUsd, stableIsToken0 } = input;
  const targetStable = targetStableFraction({ currentTick, tickLower, tickUpper, ethPriceUsd, stableIsToken0 });
  // Starting 100% stable — swap away whatever fraction shouldn't end up stable.
  const amountIn = BigInt(Math.floor(Number(availableStableRaw) * (1 - targetStable)));
  return { sellStable: true, amountIn };
}

export interface RebalanceSwapInput {
  currentTick: number;
  /** The NEW range the position is about to be minted into — not the range
   * being closed. */
  newTickLower: number;
  newTickUpper: number;
  /** Whatever's actually sitting in the vault right now (raw units), e.g. after
   * decreaseLiquidity+collect recovers a mix of both tokens from the closed
   * position — unlike sizeInitialSwap, this does NOT assume an all-stable start. */
  availableStableRaw: bigint;
  availableVolatileRaw: bigint;
  ethPriceUsd: number;
  stableIsToken0: boolean;
}

export interface RebalanceSwapResult {
  /** true: sell the stable leg for the volatile leg. false: sell volatile for stable. */
  sellStable: boolean;
  amountIn: bigint;
}

/**
 * Sizes the swap needed to rearrange the vault's recovered (possibly mixed)
 * stable/volatile balance toward the ratio the NEW range actually needs at
 * the current price, before minting. Without this, rebalance() mints with
 * whatever ratio happened to come out of the OLD position — if that doesn't
 * match the new range (routine, since ranges shift every cycle), the
 * mismatched side sits as unminted dust in the vault, invisible to
 * `investableUsdt` accounting for the volatile leg. This was confirmed
 * happening live: a position minted ~100% stable (price sitting at the top
 * of the range, per uni-lab's own pool_setup breakdown) left ~$9.78 of
 * recovered WETH unused.
 */
export function sizeRebalanceSwap(input: RebalanceSwapInput): RebalanceSwapResult {
  const { currentTick, newTickLower, newTickUpper, availableStableRaw, availableVolatileRaw, ethPriceUsd, stableIsToken0 } =
    input;

  const valueStableUsd = Number(availableStableRaw) * 1e-6;
  const valueVolatileUsd = Number(availableVolatileRaw) * 1e-18 * ethPriceUsd;
  const totalUsd = valueStableUsd + valueVolatileUsd;

  const targetFractionStable = targetStableFraction({
    currentTick,
    tickLower: newTickLower,
    tickUpper: newTickUpper,
    ethPriceUsd,
    stableIsToken0,
  });

  const targetValueStableUsd = totalUsd * targetFractionStable;
  const deltaStableUsd = valueStableUsd - targetValueStableUsd; // positive: excess stable, swap some to volatile

  // Dust-sized rebalances (<$0.01 off target) aren't worth a swap's gas/slippage.
  if (Math.abs(deltaStableUsd) < 0.01) {
    return { sellStable: true, amountIn: 0n };
  }

  if (deltaStableUsd > 0) {
    const amountIn = BigInt(Math.floor(deltaStableUsd * 1e6));
    return { sellStable: true, amountIn };
  }
  const amountIn = BigInt(Math.floor((-deltaStableUsd / ethPriceUsd) * 1e18));
  return { sellStable: false, amountIn };
}

/**
 * Adjusts a rebalance swap so at least `feeRaw` (stable leg, 6 decimals)
 * survives past it. Only still matters for vaults cloned from an
 * implementation that predates the 2026-07-16 removal of the flat
 * rebalanceFee — those still charge it inside rebalance() and revert with
 * InsufficientInvestableBalance if there isn't enough stable left after the
 * swap (confirmed root cause of a real stuck vault in production,
 * 2026-07-16, vault 0x721e1B69...C94C37). Vaults cloned after that removal
 * pass feeRaw=0 here (see currentRebalanceFee's fallback in rebalancer.ts)
 * and this is a no-op. A small deviation from the position's ideal ratio
 * (the old fee was usually cents) is worth guaranteeing the tx doesn't
 * revert outright on the vaults that still need it.
 */
export function ensureFeeCoverage(
  swap: RebalanceSwapResult,
  availableStableRaw: bigint,
  feeRaw: bigint,
  ethPriceUsd: number,
): RebalanceSwapResult {
  if (feeRaw === 0n) return swap;

  if (swap.sellStable) {
    // This swap sends stable away — cap it so at least `feeRaw` remains.
    const remaining = availableStableRaw - swap.amountIn;
    if (remaining >= feeRaw) return swap;
    const shortfall = feeRaw - remaining;
    return { ...swap, amountIn: swap.amountIn > shortfall ? swap.amountIn - shortfall : 0n };
  }

  // This swap ADDS stable (converting volatile) — only bump it if the
  // resulting balance would still fall short, which only happens when
  // availableStableRaw alone is already thinner than the fee.
  const approxOutputRaw = BigInt(Math.floor(Number(swap.amountIn) * ethPriceUsd * 1e-12));
  const remaining = availableStableRaw + approxOutputRaw;
  if (remaining >= feeRaw) return swap;
  const shortfallUsd = Number(feeRaw - remaining) * 1e-6;
  const extraVolatileRaw = BigInt(Math.ceil((shortfallUsd / ethPriceUsd) * 1e18));
  return { ...swap, amountIn: swap.amountIn + extraVolatileRaw };
}
