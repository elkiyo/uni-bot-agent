import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { celo } from "wagmi/chains";

// RainbowKit's getDefaultConfig throws at instantiation (including at build time)
// if projectId is empty — it's not optional the way the rest of the WalletConnect
// integration is. This placeholder lets the app build/run; injected wallets
// (MetaMask, Rabby, etc.) work fine with it, but get a real free id at
// https://cloud.walletconnect.com before relying on the WalletConnect QR/mobile flow.
const walletConnectProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "00000000000000000000000000000000";

export const wagmiConfig = getDefaultConfig({
  appName: "uni-bot-agent",
  projectId: walletConnectProjectId,
  chains: [celo],
  ssr: true,
});
