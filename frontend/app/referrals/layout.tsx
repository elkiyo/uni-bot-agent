import type { ReactNode } from "react";
import { AuthSessionProvider } from "@/lib/auth/AuthSessionProvider";

/**
 * AuthSessionProvider (SIWE session) is scoped to /referrals only — it's the
 * only page that consumes useAuthSession(). Previously mounted globally (see
 * app/providers.tsx's history), which meant connecting a wallet ANYWHERE in
 * the app (creating a vault, browsing the dashboard, nothing referrals-
 * related) auto-triggered a second wallet round-trip to sign a SIWE message.
 * On an installed PWA (manifest.ts's display: "standalone"), each such
 * wallet-app handoff is a place the connection can silently hang — stacking
 * a second one on top of the wallet-connect handoff made that measurably
 * more likely, and looked to users like "the wallet just doesn't connect."
 */
export default function ReferralsLayout({ children }: { children: ReactNode }) {
  return <AuthSessionProvider>{children}</AuthSessionProvider>;
}
