import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { celo, arbitrum } from "wagmi/chains";

// RainbowKit's getDefaultConfig throws at instantiation (including at build time)
// if projectId is empty — it's not optional the way the rest of the WalletConnect
// integration is. This placeholder lets the app build/run; injected wallets
// (MetaMask, Rabby, etc.) work fine with it, but get a real free id at
// https://cloud.walletconnect.com before relying on the WalletConnect QR/mobile flow.
const walletConnectProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "00000000000000000000000000000000";

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
  ssr: true,
});
