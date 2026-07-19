import es from "./es";
import en from "./en";
import pt from "./pt";
import zh from "./zh";
import type { Locale } from "../locales";
import type { Dictionary } from "./es";

export const dictionaries: Record<Locale, Dictionary> = { es, en, pt, zh };
