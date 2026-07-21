"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { wagmiConfig } from "@/lib/wagmi";
import { SelectedChainProvider } from "@/lib/useSelectedChain";
import { LanguageProvider } from "@/lib/i18n/LanguageProvider";

const queryClient = new QueryClient();

// No RainbowKitProvider anymore — AppKit's connect modal isn't a JSX
// provider, it's a web component registered as a side effect of the
// createAppKit() call in lib/wagmi.ts (theming lives there too).
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <LanguageProvider>
          <SelectedChainProvider>{children}</SelectedChainProvider>
        </LanguageProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
