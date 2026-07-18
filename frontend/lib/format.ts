/** "$54.86M", "$39.05K", "$820.00" — compact USD for dashboard-style stats
 * where a raw number (or the previous e+notation) is harder to scan than a
 * rounded magnitude. Always 2 decimals so figures stay vertically aligned in
 * a list. Negative values keep the sign in front of "$", not the digits. */
export function formatUsdCompact(value: number): string {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(2)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}
