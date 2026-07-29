"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslation } from "@/lib/i18n/useTranslation";
import { LOCALES } from "@/lib/i18n/locales";
import { ThemeToggle } from "./ThemeToggle";

export function Header() {
  const pathname = usePathname();
  const { t } = useTranslation();

  // /referrals is intentionally left out of the public nav — owner-only
  // feature, not yet meant for LPs to discover. See app/referrals/page.tsx's
  // own owner gate for the actual access control; this is just visibility.
  const links = [
    { href: "/vaults", label: t("header.navVaults") },
    { href: "/create", label: t("header.navCreate") },
    { href: "/dashboard", label: t("header.navDashboard") },
  ];

  const resourceLinks = [
    { href: "/recursos", label: t("header.resourceGuides") },
    { href: "/recursos/inversionistas", label: t("header.resourceInvestors") },
    { href: "/docs", label: t("header.resourceDocs") },
    { href: "/admin", label: t("header.resourceAdmin") },
  ];

  return (
    <header className="fixed inset-x-0 top-0 z-50 border-b border-hairline bg-background/80 backdrop-blur-xl transition-colors duration-200">
      <div className="section flex h-20 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-3 sm:gap-8">
          <Link href="/" className="flex min-w-0 items-center gap-2 sm:gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/brand/logo-mark-64.png"
              alt="AutoRange"
              className="h-9 w-9 shrink-0 rounded-full sm:h-12 sm:w-12"
            />
            <span className="flex min-w-0 flex-col leading-none">
              <span
                className="truncate text-base font-bold tracking-tight text-foreground sm:text-xl"
                style={{ fontFamily: "var(--font-display)" }}
              >
                AutoRange
              </span>
              <span className="mt-1 hidden font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-accent-text sm:block">
                AI Agent
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
                    ? "text-sm font-medium text-accent-text"
                    : "text-sm text-foreground/60 transition-colors hover:text-foreground"
                }
              >
                {label}
              </Link>
            ))}
            <ResourcesMenu pathname={pathname} resourceLinks={resourceLinks} />
          </nav>
        </div>

        <div className="flex shrink-0 items-center gap-1.5 sm:gap-3">
          <ThemeToggle />
          <LanguageMenu />
          {/* Two instances, one per breakpoint, rather than trying to resize
              appkit-button's own shadow-DOM content with CSS — its internal
              text/padding ignore host classes (and its React types don't
              expose className at all, only label/size/balance/etc.), so a
              full "Connect Wallet" label reliably overflowed a phone-width
              header (confirmed: it was clipping off the right edge). Same
              underlying wallet state either way (ChainController is a
              singleton), just a shorter label on mobile. The wrapping
              span carries the responsive visibility instead. */}
          <span className="hidden sm:inline-flex">
            <appkit-button balance="hide" />
          </span>
          <span className="sm:hidden">
            <appkit-button balance="hide" label="Connect" />
          </span>
        </div>
      </div>
    </header>
  );
}

function LanguageMenu() {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const { locale, setLocale } = useTranslation();
  const current = LOCALES.find((l) => l.code === locale) ?? LOCALES[0];

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
        aria-label="Idioma"
        className="flex h-9 items-center gap-1.5 rounded-full border border-hairline bg-surface-1 px-2.5 text-sm text-foreground/70 transition-colors hover:text-foreground sm:px-3"
      >
        <span>{current.flag}</span>
        <span className="hidden font-mono text-[11px] uppercase tracking-wide sm:inline">{current.code}</span>
      </button>

      {open && (
        <div className="absolute right-0 top-full z-10 mt-2 w-36 rounded-xl border border-hairline bg-surface p-1.5 shadow-2xl shadow-[var(--shadow-color)]">
          {LOCALES.map((l) => (
            <button
              key={l.code}
              type="button"
              onClick={() => {
                setLocale(l.code);
                setOpen(false);
              }}
              className={
                l.code === locale
                  ? "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium text-accent-text"
                  : "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-foreground/70 transition-colors hover:bg-surface-hover hover:text-foreground"
              }
            >
              <span>{l.flag}</span>
              <span>{l.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ResourcesMenu({
  pathname,
  resourceLinks,
}: {
  pathname: string;
  resourceLinks: { href: string; label: string }[];
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const isActive = resourceLinks.some((l) => l.href === pathname);
  const { t } = useTranslation();

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
            ? "flex items-center gap-1 text-sm font-medium text-accent-text"
            : "flex items-center gap-1 text-sm text-foreground/60 transition-colors hover:text-foreground"
        }
      >
        {t("header.resources")}
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
        <div className="absolute left-0 top-full z-10 mt-2 w-44 rounded-xl border border-hairline bg-surface p-1.5 shadow-2xl shadow-[var(--shadow-color)]">
          {resourceLinks.map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              onClick={() => setOpen(false)}
              className={
                pathname === href
                  ? "block rounded-lg px-3 py-2 text-sm font-medium text-accent-text"
                  : "block rounded-lg px-3 py-2 text-sm text-foreground/70 transition-colors hover:bg-surface-hover hover:text-foreground"
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
