/**
 * i18n — Internationalization system
 *
 * Usage:
 *   const { t } = useTranslation();
 *   t("header.title")           → "POLYMARKET AGENT"
 *   t("ai.ofEligible", 50, 1)   → "de 50 elegibles (≤1h)"
 *
 * Auto-detects browser language (es/en) and persists choice in localStorage.
 */

export { LanguageProvider, useTranslation, useLocale } from "./LanguageContext";
export type { Locale } from "./types";
