import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import {
  metaMaskWallet,
  rabbyWallet,
  rainbowWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { createConfig } from "wagmi";
import { fallback, http } from "viem";
import { celo, arbitrum } from "wagmi/chains";

// RainbowKit's getDefaultConfig throws at instantiation (including at build time)
// if projectId is empty — it's not optional the way the rest of the WalletConnect
// integration is. This placeholder lets the app build/run; injected wallets
// (MetaMask, Rabby, etc.) work fine with it, but get a real free id at
// https://cloud.walletconnect.com before relying on the WalletConnect QR/mobile flow.
const walletConnectProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "00000000000000000000000000000000";

// Each chain's own default public RPC, with a second public RPC as fallback.
// Confirmed live 2026-07-18: arb1.arbitrum.io intermittently serves a
// malformed CORS header (Cloudflare edge inconsistency — a preflight request
// sometimes comes back with a duplicate access-control-allow-origin, which
// browsers reject as ERR_FAILED before the request is even sent, no amount
// of client-side retrying fixes that specific failure) — this is what made
// the dashboard's numbers intermittently come back looking like confirmed
// zeros instead of real data. viem's fallback() transport automatically
// retries against the second URL when the first errors, rather than every
// read on this app depending on a single third-party RPC's uptime.
//
// A NodeReal-backed proxy was tried here 2026-07-19 but reverted the same
// day — that specific key's Arbitrum Nitro product was rate-limited
// (-32005 max CUPS) well below what the dashboard's read volume needs, even
// though the same key's Ethereum product worked fine.
//
// Now backed by Alchemy (2026-07-19), same server-side-proxy shape: the
// browser talks to OUR OWN /api/rpc/arbitrum route (see that file), which
// forwards to Alchemy server-side using ARBITRUM_RPC_URL — never directly,
// so the key never ships in the client bundle. Note: Alchemy's Free tier
// caps eth_getLogs at a 10-block range on Arbitrum (Pay As You Go removes
// that cap) — until the account is upgraded, large-range getLogs calls
// (vault discovery, fee/rebalance event history, activity feed) will error
// out of this transport and fall through to the public RPCs below, same as
// before Alchemy was added; only the multicall/eth_call-style reads
// (ledgers, positions, pool state) are guaranteed to benefit on Free.
//
// Only wired up in the browser: during SSR there's no same-origin base to
// resolve a relative URL against, and no wagmi hook actually reads through
// this transport server-side anyway (every consumer is a "use client" hook).
const arbitrumProxyUrl = typeof window !== "undefined" ? "/api/rpc/arbitrum" : undefined;
const transports = {
  [celo.id]: fallback([http("https://forno.celo.org"), http("https://rpc.ankr.com/celo")]),
  [arbitrum.id]: fallback([
    ...(arbitrumProxyUrl ? [http(arbitrumProxyUrl)] : []),
    http("https://arb1.arbitrum.io/rpc"),
    http("https://rpc.ankr.com/arbitrum"),
  ]),
};

// appUrl/appIcon/appDescription feed WalletConnect's pairing metadata — a
// mobile wallet uses `appUrl` to know where to deep-link/redirect back to
// after the user approves. Left unset before, WalletConnect fell back to
// auto-detecting it from window.location at connect time, which is exactly
// where an installed PWA (display: "standalone" in manifest.ts) diverges
// from a normal browser tab: standalone mode's window.location/referrer
// behavior is inconsistent across mobile WebKit/Chrome, so the auto-detected
// URL could end up wrong or unstable — the wallet approves the connection,
// but the redirect-back never lands where the pairing session is actually
// listening, so the PWA just hangs on "connecting" forever. Hardcoding it to
// the same canonical origin used in layout.tsx's metadataBase removes that
// ambiguity regardless of which display mode the page was opened in.
//
// Must be the domain the browser actually ends up on, not just "the"
// domain — Vercel 308-redirects the bare apex to www, so the real origin at
// connect time is always https://www.autorange.xyz. Pointing appUrl at the
// apex caused a host mismatch WalletConnect logs as "the configured
// metadata.url differs from the actual page url" (confirmed live
// 2026-07-20) and wallets treat that mismatch as a legitimate phishing
// signal — approving the connection and then immediately tearing the
// session down, which is exactly the "conecta y se desconecta al toque"
// symptom reported on mobile.
const walletConnectMetadata = {
  appName: "AutoRange",
  appDescription: "Vaults no-custodiales de liquidez concentrada en Uniswap V3, gestionados por un agente keeper.",
  appUrl: "https://www.autorange.xyz",
  appIcon: "https://www.autorange.xyz/brand/logo-mark-256.png",
  projectId: walletConnectProjectId,
};

// Explicit wallet list (replaces RainbowKit's getDefaultConfig/auto-detected
// list) so Rabby shows up as its own named tile next to MetaMask instead of
// only being reachable through the generic "WalletConnect" fallback tile —
// confirmed 2026-07-20 that the generic WalletConnect tile itself fails to
// load for at least one real user/device, while named-wallet tiles (which
// deep-link directly instead of going through that generic flow) work fine.
//
// RainbowKit's mobile connect sheet only shows 4 tiles inline — a 5th
// (coinbaseWallet) got silently dropped even though it was in this array,
// confirmed live 2026-07-20. Dropped coinbaseWallet rather than rabbyWallet
// to keep Rabby visible, since that's the one actually being requested here.
// walletConnectWallet is kept as the catch-all for any wallet not explicitly
// listed — RainbowKit bumps it to the front labeled "Reciente" once a
// visitor has used it before, which is expected/fine.
const connectors = connectorsForWallets(
  [
    {
      groupName: "Popular",
      wallets: [metaMaskWallet, rabbyWallet, rainbowWallet, walletConnectWallet],
    },
  ],
  walletConnectMetadata,
);

// Both chains listed here regardless of whether Arbitrum's contracts are
// deployed yet — this only controls which networks the WALLET can connect
// to/switch between (RainbowKit's own network UI, used by the
// switch-network-before-write guard). Which chain's DATA is shown while
// browsing is a separate, independent selection — see useSelectedChain.tsx —
// and is further gated by chains.ts's deployedChains() so an undeployed
// chain never appears as a viewing option even though the wallet could
// still technically connect to it.
export const wagmiConfig = createConfig({
  connectors,
  chains: [celo, arbitrum],
  transports,
  ssr: true,
});
