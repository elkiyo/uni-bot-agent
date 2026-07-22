import { celo, arbitrum } from "viem/chains";

// Small brand-colored badges so vault cards are tellable apart from each
// other at a glance without reading the "CELO"/"ARBITRUM" text label —
// Celo's signature yellow ring mark, Arbitrum's navy-and-cyan arrow mark.
function CeloGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden="true">
      <circle cx="8" cy="8" r="7" fill="#FCFF52" />
      <circle cx="8" cy="8" r="7" fill="none" stroke="#000" strokeOpacity="0.15" strokeWidth="1" />
      <circle cx="6.1" cy="8" r="3.1" fill="none" stroke="#000" strokeWidth="1.3" />
      <circle cx="9.9" cy="8" r="3.1" fill="none" stroke="#000" strokeWidth="1.3" />
    </svg>
  );
}

function ArbitrumGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden="true">
      <circle cx="8" cy="8" r="7" fill="#213147" />
      <path d="M5.6 10.6 8 4.9l2.4 5.7" fill="none" stroke="#12AAFF" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M6.6 10.6h2.8" fill="none" stroke="#fff" strokeWidth="1.1" />
    </svg>
  );
}

export function ChainIcon({ chainId, className = "h-4 w-4" }: { chainId: number; className?: string }) {
  if (chainId === celo.id) return <CeloGlyph className={className} />;
  if (chainId === arbitrum.id) return <ArbitrumGlyph className={className} />;
  return null;
}
