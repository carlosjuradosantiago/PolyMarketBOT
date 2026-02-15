import { Settings, Play, Square, Zap, RotateCw } from "lucide-react";
import { BotStats } from "../types";
import { useTranslation } from "../i18n";
import LanguageSelector from "./LanguageSelector";

interface HeaderProps {
  stats: BotStats;
  isRunning: boolean;
  isDemoMode: boolean;
  countdown: number;
  onStart: () => void;
  onStop: () => void;
  onForceRun: () => void;
  isManualRunning: boolean;
  onSettings: () => void;
}

export default function Header({
  stats,
  isRunning,
  isDemoMode,
  countdown,
  onStart,
  onStop,
  onForceRun,
  isManualRunning,
  onSettings,
}: HeaderProps) {
  const fmtCountdown = () => {
    if (countdown <= 0) return "--:--";
    const h = Math.floor(countdown / 3600);
    const m = Math.floor((countdown % 3600) / 60);
    const s = countdown % 60;
    if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
    return `${m}:${String(s).padStart(2, "0")}`;
  };
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-between px-4 py-3 border-b border-bot-border">
      {/* Left: Title */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <Zap className="w-5 h-5 text-bot-cyan" />
          <span className="text-lg font-bold tracking-wider text-white">
            {t("header.title")}
          </span>
          <span className="text-bot-muted mx-1">/</span>
          <span className="text-lg font-bold tracking-wider text-bot-cyan">
            {t("header.mode")}
          </span>
        </div>

        {/* Status indicator */}
        <div className="flex items-center gap-2 ml-4">
          <div
            className={`w-2.5 h-2.5 rounded-full ${
              isRunning
                ? "bg-bot-green status-alive"
                : "bg-bot-red"
            }`}
          />
          <span
            className={`text-sm font-semibold tracking-wide ${
              isRunning ? "text-bot-green" : "text-bot-red"
            }`}
          >
            {isRunning ? t("header.alive") : t("header.stopped")}
          </span>
        </div>

        {isDemoMode && (
          <span className="text-xs bg-bot-purple/20 text-bot-purple px-2 py-0.5 rounded ml-2">
            {t("header.demo")}
          </span>
        )}
      </div>

      {/* Right: Controls & Info */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-3 text-sm text-bot-muted">
          <span>
            {t("header.uptime")}{" "}
            <span className="text-white font-medium">{stats.uptime}</span>
          </span>
          <span>
            {t("header.cycle")}{" "}
            <span className="text-white font-medium">#{stats.cycle}</span>
          </span>
          <span>
            {t("header.next")}{" "}
            <span className={`font-mono font-bold ${countdown <= 60 ? "text-yellow-400" : "text-bot-cyan"}`}>{fmtCountdown()}</span>
          </span>
        </div>

        <LanguageSelector />

        <div className="flex items-center gap-2">
          {isRunning ? (
            <button
              onClick={onStop}
              className="flex items-center gap-1.5 bg-bot-red/20 text-bot-red px-4 py-1.5 rounded text-sm font-semibold hover:bg-bot-red/30 transition-colors"
            >
              <Square className="w-3.5 h-3.5" />
              {t("header.stop")}
            </button>
          ) : (
            <button
              onClick={onStart}
              className="flex items-center gap-1.5 bg-bot-green/20 text-bot-green px-4 py-1.5 rounded text-sm font-semibold hover:bg-bot-green/30 transition-colors"
            >
              <Play className="w-3.5 h-3.5" />
              {t("header.start")}
            </button>
          )}

          {/* Manual Force-Run Button */}
          <button
            onClick={onForceRun}
            disabled={isManualRunning}
            title={isManualRunning ? "Ejecutando..." : "Forzar ciclo manual"}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-semibold transition-colors ${
              isManualRunning
                ? "bg-yellow-500/10 text-yellow-600 cursor-not-allowed"
                : "bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30"
            }`}
          >
            <RotateCw className={`w-3.5 h-3.5 ${isManualRunning ? "animate-spin" : ""}`} />
            {isManualRunning ? "Running..." : "Run Now"}
          </button>

          <button
            onClick={onSettings}
            className="flex items-center gap-1.5 bg-bot-border text-bot-muted px-3 py-1.5 rounded text-sm hover:bg-bot-gray/30 hover:text-white transition-colors"
          >
            <Settings className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
