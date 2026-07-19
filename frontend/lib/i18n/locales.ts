export type Locale = "es" | "en" | "pt" | "zh";

export const LOCALES: { code: Locale; label: string; flag: string }[] = [
  { code: "es", label: "Español", flag: "🇪🇸" },
  { code: "en", label: "English", flag: "🇺🇸" },
  { code: "pt", label: "Português", flag: "🇧🇷" },
  { code: "zh", label: "中文", flag: "🇨🇳" },
];

export const DEFAULT_LOCALE: Locale = "es";

export function isLocale(value: string): value is Locale {
  return LOCALES.some((l) => l.code === value);
}

/** Best-effort match of the browser's language to one of our locales. */
export function localeFromBrowserLanguage(lang: string): Locale {
  const short = lang.slice(0, 2).toLowerCase();
  if (isLocale(short)) return short;
  return DEFAULT_LOCALE;
}
