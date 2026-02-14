import { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from "react";
import type { Locale } from "./types";
import es from "./es";
import en from "./en";

// ─── Detect browser language ────────────────────
function detectLocale(): Locale {
  try {
    const stored = localStorage.getItem("app_locale");
    if (stored === "es" || stored === "en") return stored;
  } catch { /* SSR / incognito */ }

  // Check navigator languages
  const langs = navigator.languages ?? [navigator.language];
  for (const lang of langs) {
    const code = lang.toLowerCase().split("-")[0];
    if (code === "es") return "es";
    if (code === "en") return "en";
  }
  return "es"; // default fallback
}

// ─── Translation dictionaries ───────────────────
const dictionaries: Record<Locale, Record<string, string>> = { es, en };

type TKey = keyof typeof es;

// ─── Context ────────────────────────────────────

interface I18nContextValue {
  locale: Locale;
  setLocale: (l: Locale) => void;
  /** Translate a key with optional interpolation: t("key", arg0, arg1, ...) */
  t: (key: TKey, ...args: (string | number)[]) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

// ─── Provider ───────────────────────────────────

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detectLocale);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    try { localStorage.setItem("app_locale", l); } catch { /* ignore */ }
  }, []);

  const t = useCallback(
    (key: TKey, ...args: (string | number)[]): string => {
      let text = dictionaries[locale]?.[key] ?? dictionaries.es[key] ?? key;
      // Replace {0}, {1}, ... placeholders
      for (let i = 0; i < args.length; i++) {
        text = text.replace(`{${i}}`, String(args[i]));
      }
      return text;
    },
    [locale],
  );

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

// ─── Hooks ──────────────────────────────────────

export function useTranslation() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useTranslation must be used within <LanguageProvider>");
  return ctx;
}

/** Convenience: just the locale + setter */
export function useLocale() {
  const { locale, setLocale } = useTranslation();
  return { locale, setLocale };
}
