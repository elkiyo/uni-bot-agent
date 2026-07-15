"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ConnectButton } from "@rainbow-me/rainbowkit";

const links = [
  { href: "/vaults", label: "Mis vaults" },
  { href: "/create", label: "Crear vault" },
  { href: "/admin", label: "Admin" },
];

export function Header() {
  const pathname = usePathname();

  return (
    <header className="fixed inset-x-0 top-0 z-50 border-b border-hairline bg-background/80 backdrop-blur-xl">
      <div className="section flex h-16 items-center justify-between">
        <div className="flex items-center gap-8">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="relative grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent font-mono text-sm font-bold text-background">
              U
            </span>
            <span className="flex flex-col leading-none">
              <span className="text-[12.5px] font-semibold tracking-tight text-white">
                UniAgent
              </span>
              <span className="mt-1 font-mono text-[9px] uppercase tracking-[0.18em] text-muted">
                Vaults · Celo
              </span>
            </span>
          </Link>

          <nav className="hidden items-center gap-6 md:flex">
            {links.map(({ href, label }) => (
              <Link
                key={href}
                href={href}
                className={
                  pathname === href
                    ? "text-sm font-medium text-accent"
                    : "text-sm text-white/60 transition-colors hover:text-white"
                }
              >
                {label}
              </Link>
            ))}
          </nav>
        </div>

        <ConnectButton showBalance={false} chainStatus="icon" />
      </div>
    </header>
  );
}
