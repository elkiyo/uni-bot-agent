"use client";

import Link from "next/link";
import { ConnectButton } from "@rainbow-me/rainbowkit";

export function Header() {
  return (
    <header className="border-b border-black/10 dark:border-white/10">
      <div className="mx-auto max-w-5xl flex items-center justify-between px-6 py-4">
        <nav className="flex items-center gap-6">
          <Link href="/" className="font-semibold">
            uni-bot-agent
          </Link>
          <Link href="/" className="text-sm opacity-80 hover:opacity-100">
            Mis vaults
          </Link>
          <Link href="/create" className="text-sm opacity-80 hover:opacity-100">
            Crear vault
          </Link>
          <Link href="/admin" className="text-sm opacity-80 hover:opacity-100">
            Admin
          </Link>
        </nav>
        <ConnectButton />
      </div>
    </header>
  );
}
