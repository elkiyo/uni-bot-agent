"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "@/lib/i18n/useTranslation";
import type { ChainDef } from "@/lib/chains";
import { ChainIcon } from "./ChainIcon";

/**
 * Uniswap-style network dropdown: a trigger button showing the current
 * chain, a search box, and a searchable list — replacing the plain row of
 * chain pills. No "all networks" option here (unlike a filter context):
 * creating a vault always needs exactly one chain selected.
 */
export function NetworkSelector({
  chains,
  selectedId,
  onSelect,
}: {
  chains: ChainDef[];
  selectedId: number;
  onSelect: (id: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const { t } = useTranslation();

  const selected = chains.find((c) => c.id === selectedId);
  const filtered = chains.filter((c) => c.name.toLowerCase().includes(query.trim().toLowerCase()));

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
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
        onClick={() => {
          setOpen((v) => !v);
          setQuery("");
        }}
        aria-expanded={open}
        className="flex items-center gap-2 rounded-full border border-hairline bg-white/[0.02] px-3 py-1.5 text-sm font-medium text-white transition-colors hover:border-accent/50"
      >
        {selected && <ChainIcon chainId={selected.id} size={18} />}
        <span>{selected?.name}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className={`transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div
          className="absolute left-0 top-full z-20 mt-2 w-72 rounded-2xl border border-hairline p-3 shadow-2xl shadow-black/60"
          style={{ backgroundColor: "#0a0a0a" }}
        >
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("create.searchNetworks")}
            className="w-full rounded-xl border border-white/[0.18] bg-white/[0.03] px-3 py-2 text-sm text-white placeholder:text-faint focus:border-accent/50 focus:outline-none"
          />
          <div className="mt-2 flex max-h-64 flex-col gap-0.5 overflow-y-auto">
            {filtered.length === 0 && (
              <p className="px-2 py-3 text-center text-xs text-faint">{t("create.noNetworksFound")}</p>
            )}
            {filtered.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => {
                  onSelect(c.id);
                  setOpen(false);
                }}
                className="flex items-center gap-3 rounded-xl px-2 py-2 text-left text-sm text-white/90 transition-colors hover:bg-white/5"
              >
                <ChainIcon chainId={c.id} />
                <span className="flex-1">{c.name}</span>
                {c.id === selectedId && (
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent text-background">
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                      <path d="M1.5 5L4 7.5L8.5 2.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
