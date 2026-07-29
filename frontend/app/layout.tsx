import type { Metadata } from "next";
import { Inter, Inter_Tight } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { MobileBottomNav } from "./components/MobileBottomNav";
import { ReferralCapture } from "./components/ReferralCapture";
import { ConnectRetryPrompt } from "./components/ConnectRetryPrompt";

// Same type pairing as the reference design (hackathon.celocolombia.org):
// Inter for body, Inter Tight for display headings.
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const interTight = Inter_Tight({
  variable: "--font-inter-tight",
  subsets: ["latin"],
});

const title = "AutoRange — Vaults no-custodiales en Uniswap V3";
const description =
  "Vaults no-custodiales de liquidez concentrada en Uniswap V3, gestionados por un agente keeper. Vos depositás y retirás; el agente solo rebalancea.";

export const metadata: Metadata = {
  // Needed so Next.js can turn the file-convention OG image (opengraph-image.tsx)
  // into an absolute URL — without this, social-preview scrapers (WhatsApp,
  // Twitter, etc.) can silently fail to resolve it and fall back to the
  // browser's own favicon instead, which is what was happening here.
  metadataBase: new URL("https://autorange.xyz"),
  title,
  description,
  openGraph: { title, description, siteName: "AutoRange" },
  twitter: { card: "summary_large_image", title, description },
};

// Runs synchronously while the browser parses <head>, before first paint —
// sets data-theme on <html> from localStorage (or the OS preference as
// fallback) so there's no flash of the wrong theme. lib/useTheme.tsx reads
// the exact same two sources on mount, so React's state never disagrees
// with what's already in the DOM. See "Themes" in
// node_modules/next/dist/docs/01-app/02-guides/preventing-flash-before-hydration.md.
const THEME_INIT_SCRIPT = `(function(){try{var k="uniagent:theme";var s=localStorage.getItem(k);var t=(s==="light"||s==="dark")?s:(window.matchMedia("(prefers-color-scheme: light)").matches?"light":"dark");document.documentElement.setAttribute("data-theme",t)}catch(e){}})()`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="es"
      data-theme="dark"
      suppressHydrationWarning
      className={`${inter.variable} ${interTight.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col">
        <Providers>
          <ReferralCapture />
          {children}
          <MobileBottomNav />
          <ConnectRetryPrompt />
        </Providers>
      </body>
    </html>
  );
}
