import { useTranslation } from "../i18n";
import type { Locale } from "../i18n";

/**
 * Compact language toggle: 🌐 ES | EN
 * Sits in the Header bar.
 */
export default function LanguageSelector() {
  const { locale, setLocale, t } = useTranslation();

  const options: { value: Locale; label: string }[] = [
    { value: "es", label: "ES" },
    { value: "en", label: "EN" },
  ];

  return (
    <div className="flex items-center gap-1 text-xs" title={t("lang.label")}>
      <span className="text-bot-muted">🌐</span>
      {options.map((opt, i) => (
        <span key={opt.value}>
          {i > 0 && <span className="text-bot-gray mx-0.5">|</span>}
          <button
            onClick={() => setLocale(opt.value)}
            className={`px-1 py-0.5 rounded transition-colors font-semibold ${
              locale === opt.value
                ? "text-bot-cyan bg-bot-cyan/10"
                : "text-bot-muted hover:text-white"
            }`}
          >
            {opt.label}
          </button>
        </span>
      ))}
    </div>
  );
}
