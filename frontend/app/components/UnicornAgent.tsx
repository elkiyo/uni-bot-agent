/**
 * Original geometric illustration — not Uniswap's mascot/logo (trademark
 * risk, see HACKATHON.md naming notes) — just a nod to "unicorn" built from
 * flat shapes in the site's own palette, with a small agent riding it.
 */
export function UnicornAgent({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 480 320"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <defs>
        <radialGradient id="uaGlow" cx="50%" cy="55%" r="60%">
          <stop offset="0%" stopColor="#fcff52" stopOpacity="0.22" />
          <stop offset="100%" stopColor="#fcff52" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="uaBody" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#fff7a8" />
          <stop offset="100%" stopColor="#fcff52" />
        </linearGradient>
      </defs>

      <ellipse cx="240" cy="190" rx="220" ry="140" fill="url(#uaGlow)" />

      {/* tail */}
      <path
        d="M108 168 C 78 158, 60 178, 66 210 C 70 232, 92 240, 108 226 C 96 214, 92 196, 108 168 Z"
        fill="url(#uaBody)"
        opacity="0.9"
      />

      {/* legs */}
      <rect x="140" y="222" width="18" height="62" rx="9" fill="url(#uaBody)" />
      <rect x="182" y="228" width="18" height="56" rx="9" fill="url(#uaBody)" />
      <rect x="292" y="228" width="18" height="56" rx="9" fill="url(#uaBody)" />
      <rect x="330" y="222" width="18" height="62" rx="9" fill="url(#uaBody)" />

      {/* body */}
      <ellipse cx="240" cy="205" rx="110" ry="48" fill="url(#uaBody)" />

      {/* neck + head, angled up-right */}
      <g transform="rotate(-18 320 150)">
        <rect x="300" y="110" width="56" height="110" rx="26" fill="url(#uaBody)" />
        <path d="M312 108 C 312 82, 336 66, 372 64 C 358 82, 356 100, 350 116 Z" fill="url(#uaBody)" />
        {/* horn */}
        <path d="M344 66 L 352 26 L 360 66 Z" fill="#fcff52" />
        {/* ear */}
        <path d="M320 78 L 314 54 L 332 70 Z" fill="url(#uaBody)" />
        {/* eye */}
        <circle cx="352" cy="90" r="3.5" fill="#050505" />
        {/* mane */}
        <path
          d="M304 116 L 292 106 L 300 100 L 290 90 L 300 84 L 292 74 L 304 70"
          stroke="#fcff52"
          strokeWidth="6"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
          opacity="0.85"
        />
      </g>

      {/* agent riding on the withers — same rounded-square mark as the header logo */}
      <g transform="translate(226 122)">
        <rect x="0" y="14" width="40" height="40" rx="10" fill="#050505" stroke="#fcff52" strokeWidth="2.5" />
        <circle cx="12" cy="34" r="3.5" fill="#fcff52" />
        <circle cx="28" cy="34" r="3.5" fill="#fcff52" />
        <rect x="14" y="42" width="12" height="4" rx="2" fill="#fcff52" opacity="0.7" />
        <line x1="20" y1="14" x2="20" y2="2" stroke="#fcff52" strokeWidth="2.5" strokeLinecap="round" />
        <circle cx="20" cy="0" r="4" fill="#fcff52" />
        {/* little arms holding the reins */}
        <line x1="0" y1="30" x2="-10" y2="20" stroke="#fcff52" strokeWidth="3" strokeLinecap="round" />
        <line x1="40" y1="30" x2="50" y2="24" stroke="#fcff52" strokeWidth="3" strokeLinecap="round" />
      </g>
    </svg>
  );
}
