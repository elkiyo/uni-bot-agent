import type { Metadata } from "next";
import { Inter, Inter_Tight } from "next/font/google";
import "@rainbow-me/rainbowkit/styles.css";
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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es" className={`${inter.variable} ${interTight.variable} h-full antialiased`}>
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
