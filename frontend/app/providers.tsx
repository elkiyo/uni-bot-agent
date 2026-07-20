"use client";

import { RainbowKitProvider, darkTheme } from "@rainbow-me/rainbowkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { wagmiConfig } from "@/lib/wagmi";
import { SelectedChainProvider } from "@/lib/useSelectedChain";
import { LanguageProvider } from "@/lib/i18n/LanguageProvider";

const queryClient = new QueryClient();

const theme = darkTheme({
  accentColor: "#FCFF52",
  accentColorForeground: "#050505",
  borderRadius: "large",
  overlayBlur: "small",
});

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={theme}>
          <LanguageProvider>
            <SelectedChainProvider>{children}</SelectedChainProvider>
          </LanguageProvider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
