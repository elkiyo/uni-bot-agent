// Real brand-color token marks (MIT-licensed vector data from
// @web3icons/core — https://web3icons.io) inlined directly instead of
// pulled in as a dependency, since this app only ever needs a handful of
// them (WETH on every chain, USDC/USDT/DAI on Arbitrum, USDT on Celo). Falls
// back to a plain monogram for anything else so a future token never
// renders blank.
// clipPath ids are keyed by symbol, not per-instance — every instance of
// the same symbol clips to the identical 24x24 rect, so duplicate ids
// across multiple renders of the same token on one page are harmless.
export function TokenIcon({ symbol, size = 28, className = "" }: { symbol: string; size?: number; className?: string }) {
  const s = symbol.toUpperCase();
  const clipId = `token-clip-${s}`;

  if (s === "WETH" || s === "ETH") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={`shrink-0 rounded-full ${className}`}>
        <g clipPath={`url(#${clipId})`}>
          <path fill="#000" d="M24 0H0v24h24z" />
          <path fill="#8FFCF3" d="M12 4v5.912l5 2.236z" />
          <path fill="#CABCF8" d="m12 4-5 8.148 5-2.236z" />
          <path fill="#CBA7F5" d="M12 15.98V20l5-6.92z" />
          <path fill="#74A0F3" d="M12 20v-4.02l-5-2.9z" />
          <path fill="#CBA7F5" d="m12 15.048 5-2.9-5-2.236z" />
          <path fill="#74A0F3" d="m7 12.148 5 2.9V9.912z" />
          <path
            fill="#202699"
            fillRule="evenodd"
            d="m12 15.048-5-2.9L12 4l5 8.148zm-4.668-3.136 4.588-7.476v5.436zm-.068.204 4.656-2.068v4.768zm4.816-2.068v4.768l4.652-2.7zm0-.176 4.588 2.04-4.588-7.476z"
            clipRule="evenodd"
          />
          <path
            fill="#202699"
            fillRule="evenodd"
            d="m12 15.916-5-2.84L12 20l5-6.924zm-4.44-2.34 4.36 2.48v3.56zm4.52 2.48v3.56l4.36-6.04z"
            clipRule="evenodd"
          />
        </g>
        <defs>
          <clipPath id={clipId}>
            <path fill="#fff" d="M0 0h24v24H0z" />
          </clipPath>
        </defs>
      </svg>
    );
  }

  if (s === "USDC") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={`shrink-0 rounded-full ${className}`}>
        <g clipPath={`url(#${clipId})`}>
          <path fill="#0B53BF" d="M24 0H0v24h24z" />
          <path
            fill="#fff"
            fillRule="evenodd"
            d="M12 20c4.435 0 8-3.565 8-8s-3.565-8-8-8-8 3.565-8 8 3.565 8 8 8m2.2-6.735c0-1.165-.7-1.565-2.1-1.73-1-.135-1.2-.4-1.2-.87 0-.465.335-.765 1-.765.6 0 .935.2 1.1.7.035.1.135.165.235.165h.53c.135 0 .235-.1.235-.23v-.036c-.135-.734-.735-1.434-1.5-1.5v-.734c0-.135-.1-.235-.265-.265h-.44c-.135 0-.26.1-.295.265V9c-1 .135-1.665.9-1.665 1.735 0 1.1.665 1.53 2.065 1.7.935.165 1.235.365 1.235.9 0 .53-.47.9-1.1.9-.87 0-1.17-.37-1.27-.87-.03-.13-.13-.2-.23-.2h-.57c-.13 0-.23.1-.23.235v.035c.13.83.665 1.4 1.765 1.565v.74c0 .135.1.224.265.26h.48c.13 0 .22-.09.255-.26V15c1-.165 1.7-.835 1.7-1.735m-5.566 2.49c.483.443 1.05.786 1.666 1.01.1.07.2.2.2.3v.47c0 .064 0 .1-.035.13-.03.134-.165.2-.3.134a6 6 0 0 1 0-11.435c.035-.03.1-.03.135-.03.135.03.2.13.2.265v.465c0 .17-.065.27-.2.335a4.93 4.93 0 0 0-2.965 2.965 4.965 4.965 0 0 0 1.299 5.391M13.535 6.5c.03-.135.165-.2.3-.135a6.05 6.05 0 0 1 3.9 3.935c1 3.165-.735 6.535-3.9 7.535-.035.03-.1.03-.135.03-.135-.03-.2-.13-.2-.265v-.465c0-.17.065-.27.2-.335a4.93 4.93 0 0 0 2.965-2.965 4.967 4.967 0 0 0-2.965-6.4c-.1-.07-.2-.2-.2-.335v-.465c0-.07 0-.1.035-.135"
            clipRule="evenodd"
          />
        </g>
        <defs>
          <clipPath id={clipId}>
            <path fill="#fff" d="M0 0h24v24H0z" />
          </clipPath>
        </defs>
      </svg>
    );
  }

  if (s === "DAI") {
    // Glyph path from @web3icons/core's own DAI mark (same MIT source as the
    // three icons above), fetched live 2026-07-27 — composed here with a
    // solid brand-gold background + white glyph to match this file's own
    // convention, since the source asset ships as a bare gold glyph meant to
    // stand alone rather than the "colored square + white mark" shape used
    // everywhere else in this file.
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={`shrink-0 rounded-full ${className}`}>
        <g clipPath={`url(#${clipId})`}>
          <path fill="#F5AC37" d="M24 0H0v24h24z" />
          <path
            fill="#fff"
            fillRule="evenodd"
            d="M11.675 3.871H4.742v5.226H3v2.323h1.742v1.16H3v2.323h1.742v5.226h6.933a8.17 8.17 0 0 0 7.63-5.226H21v-2.322h-1.185a8 8 0 0 0 0-1.162H21V9.098h-1.695a8.18 8.18 0 0 0-7.63-5.226m5.806 8.71q.06-.58 0-1.162H7.065v1.162h10.422zM7.065 14.904v2.903h4.482c2.207 0 4.14-1.167 5.168-2.903zm0-5.807h9.656a6 6 0 0 0-5.168-2.903H7.065z"
            clipRule="evenodd"
          />
        </g>
        <defs>
          <clipPath id={clipId}>
            <path fill="#fff" d="M0 0h24v24H0z" />
          </clipPath>
        </defs>
      </svg>
    );
  }

  if (s === "USDT") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={`shrink-0 rounded-full ${className}`}>
        <g clipPath={`url(#${clipId})`}>
          <path fill="#009393" d="M24 0H0v24h24z" />
          <path
            fill="#fff"
            d="m12 18.4-8-7.892L7.052 5.6h9.896L20 10.508zm.8-7.2v-.976c1.44.072 2.784.352 3.2.716-.484.424-2.216.732-4 .732s-3.516-.308-4-.732c.412-.364 1.76-.64 3.2-.72v.98zM8 10.936v.588c.412.364 1.756.64 3.2.72V14.4h1.6v-2.16c1.44-.072 2.788-.352 3.2-.716v-1.172c-.412-.364-1.76-.644-3.2-.72V8.8h2.4V7.6H8.8v1.2h2.4v.832c-1.444.076-2.788.356-3.2.72z"
          />
        </g>
        <defs>
          <clipPath id={clipId}>
            <path fill="#fff" d="M0 0h24v24H0z" />
          </clipPath>
        </defs>
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
