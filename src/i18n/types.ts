/** Supported locales */
export type Locale = "es" | "en";

/** Flat translation keys → string values */
export type TranslationKeys = typeof import("./es").default;

/** A translation dictionary maps every key to a string */
export type Translations = Record<keyof TranslationKeys, string>;
