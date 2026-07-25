// Small inline SVG badges for the handful of tokens this app ever deals
// with (WETH on every chain, USDC on Arbitrum, USDT on Celo) — colored to
// match each token's well-known brand color, not a pixel-accurate
// reproduction of the official mark. Falls back to a plain monogram for
// anything else so a future token never renders blank.
export function TokenIcon({ symbol, size = 28, className = "" }: { symbol: string; size?: number; className?: string }) {
  const s = symbol.toUpperCase();

  if (s === "WETH" || s === "ETH") {
    return (
      <svg width={size} height={size} viewBox="0 0 32 32" className={`shrink-0 rounded-full ${className}`}>
        <circle cx="16" cy="16" r="16" fill="#627EEA" />
        <path d="M16.3 4.5 L16.3 13.15 L23.65 16.45 Z" fill="#C0CBF6" />
        <path d="M16.3 4.5 L8.95 16.45 L16.3 13.15 Z" fill="#FFFFFF" />
        <path d="M16.3 21.7 L16.3 27.5 L23.65 17.85 Z" fill="#C0CBF6" />
        <path d="M16.3 27.5 L16.3 21.7 L8.95 17.85 Z" fill="#FFFFFF" />
        <path d="M16.3 20.35 L23.65 16.45 L16.3 13.16 Z" fill="#8198EE" />
        <path d="M8.95 16.45 L16.3 20.35 L16.3 13.16 Z" fill="#C0CBF6" />
      </svg>
    );
  }

  if (s === "USDC") {
    return (
      <svg width={size} height={size} viewBox="0 0 32 32" className={`shrink-0 rounded-full ${className}`}>
        <circle cx="16" cy="16" r="16" fill="#2775CA" />
        <path
          d="M13.2 24.4c-4.3-1.2-7-4.8-7-8.4s2.7-7.2 7-8.4V5c-5.8 1.3-10 6-10 11s4.2 9.7 10 11v-2.6ZM18.8 7.6v2.6c4.3 1.2 7 4.8 7 8.4s-2.7 7.2-7 8.4v2.6c5.8-1.3 10-6 10-11S24.6 8.9 18.8 7.6Z"
          fill="#FFFFFF"
        />
        <path
          d="M16.9 21.6c-2.9 0-4.5-1.4-4.7-3.4h2.1c.2 1 .9 1.7 2.6 1.7 1.3 0 2.2-.6 2.2-1.6 0-1-.6-1.4-2.5-1.8-2.6-.5-4.1-1.3-4.1-3.4 0-1.9 1.5-3.1 3.7-3.3v-1.9h1.7v1.9c2.1.3 3.5 1.5 3.7 3.3h-2.1c-.2-.9-.9-1.5-2.2-1.5-1.3 0-2 .6-2 1.4 0 .9.6 1.3 2.4 1.7 2.8.6 4.2 1.4 4.2 3.5 0 2-1.5 3.2-3.9 3.5v1.9h-1.7v-1.9Z"
          fill="#FFFFFF"
        />
      </svg>
    );
  }

  if (s === "USDT") {
    return (
      <svg width={size} height={size} viewBox="0 0 32 32" className={`shrink-0 rounded-full ${className}`}>
        <circle cx="16" cy="16" r="16" fill="#26A17B" />
        <path
          d="M17.9 17.3v-.01c-.11.01-.68.04-1.94.04-1 0-1.71-.03-1.96-.04v.01c-3.24-.14-5.66-.71-5.66-1.39s2.42-1.25 5.66-1.4v2.23c.25.02.98.06 1.98.06 1.2 0 1.81-.05 1.92-.06v-2.22c3.23.14 5.64.71 5.64 1.39s-2.41 1.25-5.64 1.39Zm0-3.02v-1.99h4.51V9.3H9.63v3.01h4.51v1.99c-3.67.17-6.43.9-6.43 1.77s2.76 1.6 6.43 1.77v6.35h1.96v-6.35c3.66-.17 6.42-.9 6.42-1.77s-2.76-1.6-6.42-1.77Z"
          fill="#FFFFFF"
        />
      </svg>
    );
  }

  return (
    <div
      className={`flex shrink-0 items-center justify-center rounded-full bg-white/10 font-mono uppercase text-faint ${className}`}
      style={{ width: size, height: size, fontSize: size * 0.32 }}
    >
      {s.slice(0, 2)}
    </div>
  );
}

// Overlapping icon cluster for a pair — volatile leg in front, stable leg
// peeking out behind it, matching the classic Uniswap pool-list look.
export function PairIcon({ volatileSymbol, stableSymbol, size = 32 }: { volatileSymbol: string; stableSymbol: string; size?: number }) {
  return (
    <div className="flex shrink-0 items-center">
      <TokenIcon symbol={volatileSymbol} size={size} className="ring-2 ring-background" />
      <TokenIcon symbol={stableSymbol} size={size} className="-ml-3 ring-2 ring-background" />
    </div>
  );
}
