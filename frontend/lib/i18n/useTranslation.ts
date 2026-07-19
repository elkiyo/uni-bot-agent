"use client";

import { useLanguage } from "./LanguageProvider";

type Primitive = string | number;

// Recursively builds "a.b.c" dot-path keys out of a nested string dictionary,
// so t() gets autocomplete + a compile error on typo'd/renamed keys.
type NestedKeyOf<T> = {
  [K in keyof T & string]: T[K] extends string ? K : `${K}.${NestedKeyOf<T[K]>}`;
}[keyof T & string];

function getByPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object" && key in acc) return (acc as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

function interpolate(template: string, vars?: Record<string, Primitive>): string {
  if (!vars) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) =>
    key in vars ? String(vars[key]) : `{{${key}}}`,
  );
}

export function useTranslation() {
  const { dict, locale, setLocale } = useLanguage();

  function t(path: NestedKeyOf<typeof dict>, vars?: Record<string, Primitive>): string {
    const value = getByPath(dict, path);
    if (typeof value !== "string") return path;
    return interpolate(value, vars);
  }

  return { t, locale, setLocale };
}
