import { getDefaultConfig } from "@rainbow-me/rainbowkit";
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
const transports = {
  [celo.id]: fallback([http("https://forno.celo.org"), http("https://rpc.ankr.com/celo")]),
  [arbitrum.id]: fallback([http("https://arb1.arbitrum.io/rpc"), http("https://rpc.ankr.com/arbitrum")]),
};

// Both chains listed here regardless of whether Arbitrum's contracts are
// deployed yet — this only controls which networks the WALLET can connect
// to/switch between (RainbowKit's own network UI, used by the
// switch-network-before-write guard). Which chain's DATA is shown while
// browsing is a separate, independent selection — see useSelectedChain.tsx —
// and is further gated by chains.ts's deployedChains() so an undeployed
// chain never appears as a viewing option even though the wallet could
// still technically connect to it.
export const wagmiConfig = getDefaultConfig({
  appName: "UniAgent",
  projectId: walletConnectProjectId,
  chains: [celo, arbitrum],
  transports,
  ssr: true,
});
