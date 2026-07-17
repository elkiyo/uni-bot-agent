"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useSelectedChain, useAvailableChains } from "@/lib/useSelectedChain";

const links = [
  { href: "/vaults", label: "Mis vaults" },
  { href: "/create", label: "Crear vault" },
];

const resourceLinks = [
  { href: "/recursos", label: "Guías" },
  { href: "/docs", label: "Doc" },
  { href: "/admin", label: "Operaciones" },
];

export function Header() {
  const pathname = usePathname();
  const { selectedChain } = useSelectedChain();

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
                Vaults · {selectedChain.name}
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
            <ResourcesMenu pathname={pathname} />
          </nav>
        </div>

        <div className="flex items-center gap-3">
          <NetworkSelector />
          <ConnectButton showBalance={false} chainStatus="icon" />
        </div>
      </div>
    </header>
  );
}

/**
 * Picks which chain's data the app BROWSES — deliberately separate from
 * RainbowKit's own wallet-network switcher (that one changes what the
 * wallet is connected to; this one changes what's being viewed, so you can
 * look at Arbitrum vaults without touching your wallet's network — see
 * useSelectedChain.ts). Only lists chains that are actually deployed.
 */
function NetworkSelector() {
  const { selectedChain, setSelectedChainId } = useSelectedChain();
  const available = useAvailableChains();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  if (available.length <= 1) return null; // nothing to switch between yet

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-full border border-hairline px-3 py-1.5 text-sm text-white/80 transition-colors hover:border-accent/50"
      >
        {selectedChain.name}
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className={`transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div
          className="absolute right-0 top-full z-10 mt-2 w-40 rounded-xl border border-hairline p-1.5 shadow-2xl shadow-black/60"
          style={{ backgroundColor: "#0a0a0a" }}
        >
          {available.map((chain) => (
            <button
              key={chain.id}
              type="button"
              onClick={() => {
                setSelectedChainId(chain.id);
                setOpen(false);
              }}
              className={
                chain.id === selectedChain.id
                  ? "block w-full rounded-lg px-3 py-2 text-left text-sm font-medium text-accent"
                  : "block w-full rounded-lg px-3 py-2 text-left text-sm text-white/70 transition-colors hover:bg-white/5 hover:text-white"
              }
            >
              {chain.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ResourcesMenu({ pathname }: { pathname: string }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const isActive = resourceLinks.some((l) => l.href === pathname);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={
          isActive
            ? "flex items-center gap-1 text-sm font-medium text-accent"
            : "flex items-center gap-1 text-sm text-white/60 transition-colors hover:text-white"
        }
      >
        Recursos
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          className={`transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div
          className="absolute left-0 top-full z-10 mt-2 w-44 rounded-xl border border-hairline p-1.5 shadow-2xl shadow-black/60"
          style={{ backgroundColor: "#0a0a0a" }}
        >
          {resourceLinks.map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              onClick={() => setOpen(false)}
              className={
                pathname === href
                  ? "block rounded-lg px-3 py-2 text-sm font-medium text-accent"
                  : "block rounded-lg px-3 py-2 text-sm text-white/70 transition-colors hover:bg-white/5 hover:text-white"
              }
            >
              {label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
