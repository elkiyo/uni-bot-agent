import type { Metadata } from "next";
import { Inter, Inter_Tight } from "next/font/google";
import "@rainbow-me/rainbowkit/styles.css";
import "./globals.css";
import { Providers } from "./providers";

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

export const metadata: Metadata = {
  title: "uni-bot-agent — Vaults no-custodiales en Celo",
  description:
    "Vaults no-custodiales de liquidez concentrada en Uniswap V3 (Celo), gestionados por un agente keeper. Vos depositás y retirás; el agente solo rebalancea.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es" className={`${inter.variable} ${interTight.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
