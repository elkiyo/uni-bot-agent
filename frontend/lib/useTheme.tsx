"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "uniagent:theme";

function systemTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function storedTheme(): Theme | null {
  if (typeof window === "undefined") return null;
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === "light" || stored === "dark" ? stored : null;
}

interface ThemeContextValue {
  theme: Theme;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

/**
 * Initial state is always "dark" — matching layout.tsx's static
 * `data-theme="dark"` on <html> — on BOTH the server render and React's
 * first client render, even though the actual DOM may already be "light"
 * by then (the inline script in layout.tsx runs before hydration and can
 * resolve to the OS preference, which the server has no way to know). If
 * this lazy-read the OS preference directly instead, hydration would often
 * disagree with the server-rendered "dark" markup (aria-label, icon
 * classes) for any visitor whose system is in light mode with no saved
 * preference yet — a real hydration-mismatch bug, confirmed live via a
 * console error during Playwright verification (2026-07-29). Deferring the
 * correction to a post-mount effect (reading the DOM attribute the inline
 * script already set) avoids that: hydration always matches, and the one
 * extra client-only re-render right after mount is an established, safe
 * trade-off (see "Syncing with React state" in
 * node_modules/next/dist/docs/.../preventing-flash-before-hydration.md).
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    const resolved = (document.documentElement.getAttribute("data-theme") as Theme | null) ?? systemTheme();
    setTheme(resolved);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  useEffect(() => {
    if (storedTheme()) return; // user already picked explicitly, ignore OS changes
    const mql = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => setTheme(systemTheme());
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === "dark" ? "light" : "dark";
      window.localStorage.setItem(STORAGE_KEY, next);
      return next;
    });
  }, []);

  return <ThemeContext.Provider value={{ theme, toggleTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
