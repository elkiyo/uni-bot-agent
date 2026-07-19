"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { DEFAULT_LOCALE, isLocale, localeFromBrowserLanguage, type Locale } from "./locales";
import { dictionaries } from "./dictionaries";
import type { Dictionary } from "./dictionaries/es";

const STORAGE_KEY = "uniagent:locale";

interface LanguageContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  dict: Dictionary;
}

const LanguageContext = createContext<LanguageContextValue | undefined>(undefined);

/**
 * Deliberately independent of chain/wallet state (see useSelectedChain.tsx
 * for the equivalent pattern) — persisted to localStorage so it survives
 * reloads. First-time visitors get a best-effort guess from the browser's
 * language, falling back to Spanish (the app's original/native language).
 */
export function LanguageProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored && isLocale(stored)) {
      setLocaleState(stored);
    } else {
      setLocaleState(localeFromBrowserLanguage(window.navigator.language));
    }
  }, []);

  function setLocale(next: Locale) {
    setLocaleState(next);
    window.localStorage.setItem(STORAGE_KEY, next);
  }

  return (
    <LanguageContext.Provider value={{ locale, setLocale, dict: dictionaries[locale] }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage(): LanguageContextValue {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error("useLanguage must be used within a LanguageProvider");
  return ctx;
}
