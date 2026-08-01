const Q = 1.0001;

// USDT/USDC are 6-decimal, WETH is 18-decimal — true for every pair this
// platform supported before multi-pair. Kept as defaults (not removed) so
// every existing call site keeps working unchanged; pass a vault's own
// resolved decimals (see lib/keeper/pairInfo.ts) for any other pair.
const STABLE_DECIMALS = 6;
const VOLATILE_DECIMALS = 18;

/**
 * WETH price in USD from the pool's current tick.
 *
 * Uniswap V3's tick always encodes raw_token1_per_raw_token0 = 1.0001^tick —
 * but WHICH of token0/token1 is the stablecoin is decided by address sort
 * order, not by the platform: true stableIsToken0 on Celo (USDT < WETH),
 * false on Arbitrum (WETH < USDC). Confirmed in production 2026-07-17: code
 * that assumed Celo's order unconditionally computed a target range on the
 * opposite side of the real price for an Arbitrum vault, which could never
 * open a position. See RangeVault.sol's class docstring for the on-chain half
 * of this same fix.
 */
export function ethPriceFromTick(
  tick: number,
  stableIsToken0: boolean,
  stableDecimals: number = STABLE_DECIMALS,
  volatileDecimals: number = VOLATILE_DECIMALS,
): number {
  const rawRatio = Q ** tick; // raw token1 per raw token0
  const decimalsExp = stableIsToken0 ? stableDecimals - volatileDecimals : volatileDecimals - stableDecimals;
  const humanRatio = rawRatio * 10 ** decimalsExp; // human token1 per human token0
  // stableIsToken0: humanRatio is WETH-per-USD — invert to get USD-per-WETH.
  // !stableIsToken0: humanRatio is already USD(stable)-per-WETH directly.
  return stableIsToken0 ? 1 / humanRatio : humanRatio;
}

/** Inverse of ethPriceFromTick — the tick whose implied ETH price is `priceUsd`. */
export function tickFromEthPrice(
  priceUsd: number,
  stableIsToken0: boolean,
  stableDecimals: number = STABLE_DECIMALS,
  volatileDecimals: number = VOLATILE_DECIMALS,
): number {
  const humanRatio = stableIsToken0 ? 1 / priceUsd : priceUsd;
  const decimalsExp = stableIsToken0 ? volatileDecimals - stableDecimals : stableDecimals - volatileDecimals;
  const rawRatio = humanRatio * 10 ** decimalsExp;
  return Math.log(rawRatio) / Math.log(Q);
}

export function alignToTickSpacing(tick: number, tickSpacing: number): number {
  return Math.round(tick / tickSpacing) * tickSpacing;
}

/**
 * Same rounding as alignToTickSpacing, but biased outward (away from
 * currentTick) instead of to the nearest multiple — used for the CEILING
 * side of a uni-lab rebalance range (rebalancer.ts's computeRebalanceParams),
 * where landing even slightly short of uni-lab's own continuous price can
 * mean a hair less capital recovered than its RC calibration intended.
 * alignToTickSpacing's round-to-nearest lands on the "wrong" (nearer) side
 * about half the time — confirmed live 2026-08-01 (vault 0x7186CE90...
 * 4D78c7's first ownerRebalance()). Comparing raw tick distance (not price)
 * works regardless of stableIsToken0 — ethPriceFromTick/tickFromEthPrice are
 * monotonic in tick either way, just in opposite directions depending on
 * token order, so "farther in tick space" and "farther in price space" are
 * always the same comparison.
 */
export function alignTickOutward(tick: number, tickSpacing: number, currentTick: number): number {
  const lower = Math.floor(tick / tickSpacing) * tickSpacing;
  const upper = Math.ceil(tick / tickSpacing) * tickSpacing;
  if (lower === upper) return lower;
  return Math.abs(lower - currentTick) > Math.abs(upper - currentTick) ? lower : upper;
}
