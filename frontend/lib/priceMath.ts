const Q = 1.0001;

// USDT/USDC are 6-decimal, WETH is 18-decimal, on every chain this platform
// currently supports — true regardless of which one Uniswap calls token0.
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
export function ethPriceFromTick(tick: number, stableIsToken0: boolean): number {
  const rawRatio = Q ** tick; // raw token1 per raw token0
  const decimalsExp = stableIsToken0 ? STABLE_DECIMALS - VOLATILE_DECIMALS : VOLATILE_DECIMALS - STABLE_DECIMALS;
  const humanRatio = rawRatio * 10 ** decimalsExp; // human token1 per human token0
  // stableIsToken0: humanRatio is WETH-per-USD — invert to get USD-per-WETH.
  // !stableIsToken0: humanRatio is already USD(stable)-per-WETH directly.
  return stableIsToken0 ? 1 / humanRatio : humanRatio;
}

/** Inverse of ethPriceFromTick — the tick whose implied ETH price is `priceUsd`. */
export function tickFromEthPrice(priceUsd: number, stableIsToken0: boolean): number {
  const humanRatio = stableIsToken0 ? 1 / priceUsd : priceUsd;
  const decimalsExp = stableIsToken0 ? VOLATILE_DECIMALS - STABLE_DECIMALS : STABLE_DECIMALS - VOLATILE_DECIMALS;
  const rawRatio = humanRatio * 10 ** decimalsExp;
  return Math.log(rawRatio) / Math.log(Q);
}

export function alignToTickSpacing(tick: number, tickSpacing: number): number {
  return Math.round(tick / tickSpacing) * tickSpacing;
}
