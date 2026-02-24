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
  isAnalyzing: boolean;
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
  isAnalyzing,
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
    <div className="relative flex items-center justify-between px-5 py-3 border-b border-bot-border/60 bg-gradient-to-r from-bot-card via-bot-bg to-bot-card">
      {/* Subtle accent line at top */}
      <div className="absolute top-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-bot-green/30 to-transparent" />
      
      {/* Left: Title */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-bot-green/20 to-bot-cyan/10 border border-bot-green/20 flex items-center justify-center">
            <Zap className="w-4 h-4 text-bot-green" />
          </div>
          <div>
            <span className="text-sm font-display font-bold tracking-wide text-white">
              {t("header.title")}
            </span>
            <span className="text-bot-muted mx-1.5 text-xs">/</span>
            <span className="text-sm font-display font-bold tracking-wide text-gradient">
              {t("header.mode")}
            </span>
          </div>
        </div>

        {/* Status indicator */}
        <div className="flex items-center gap-2 ml-2 px-3 py-1 rounded-full bg-bot-surface/50 border border-bot-border/50">
          <div
            className={`w-2 h-2 rounded-full ${
              isRunning
                ? "neon-dot status-alive"
                : "bg-bot-red shadow-glow-red"
            }`}
          />
          <span
            className={`text-xs font-display font-semibold tracking-wider uppercase ${
              isRunning ? "text-bot-green" : "text-bot-red"
            }`}
          >
            {isRunning ? t("header.alive") : t("header.stopped")}
          </span>
        </div>

        {isDemoMode && (
          <span className="text-[10px] font-display font-semibold bg-bot-purple/10 text-bot-purple/80 px-2.5 py-0.5 rounded-full border border-bot-purple/20">
            {t("header.demo")}
          </span>
        )}
      </div>

      {/* Right: Controls & Info */}
      <div className="flex items-center gap-5">
        {/* Stats pills */}
        <div className="flex items-center gap-4 text-xs">
          <div className="flex items-center gap-1.5">
            <span className="text-bot-muted font-display text-[10px] uppercase tracking-wider">{t("header.uptime")}</span>
            <span className="text-white font-mono font-medium bg-bot-surface/60 px-2 py-0.5 rounded">{stats.uptime}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-bot-muted font-display text-[10px] uppercase tracking-wider">{t("header.cycle")}</span>
            <span className="text-white font-mono font-medium bg-bot-surface/60 px-2 py-0.5 rounded">#{stats.cycle}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-bot-muted font-display text-[10px] uppercase tracking-wider">{t("header.next")}</span>
            <span className={`font-mono font-bold px-2 py-0.5 rounded ${
              countdown <= 60 
                ? "text-bot-yellow bg-bot-yellow/10 border border-bot-yellow/20" 
                : "text-bot-cyan bg-bot-cyan/10 border border-bot-cyan/20"
            }`}>{fmtCountdown()}</span>
          </div>
        </div>

        <div className="w-px h-6 bg-bot-border/40" />

        <LanguageSelector />

        <div className="flex items-center gap-2">
          {isRunning ? (
            <button
              onClick={onStop}
              className="flex items-center gap-1.5 bg-bot-red/10 text-bot-red px-4 py-1.5 rounded-lg text-xs font-display font-semibold 
                         hover:bg-bot-red/20 border border-bot-red/20 hover:border-bot-red/40 transition-all hover:shadow-glow-red"
            >
              <Square className="w-3 h-3" />
              {t("header.stop")}
            </button>
          ) : (
            <button
              onClick={onStart}
              className="flex items-center gap-1.5 bg-bot-green/10 text-bot-green px-4 py-1.5 rounded-lg text-xs font-display font-semibold 
                         hover:bg-bot-green/20 border border-bot-green/20 hover:border-bot-green/40 transition-all hover:shadow-glow-green"
            >
              <Play className="w-3 h-3" />
              {t("header.start")}
            </button>
          )}

          {/* Manual Force-Run Button */}
          <button
            onClick={onForceRun}
            disabled={isManualRunning || isAnalyzing}
            title={isManualRunning || isAnalyzing ? "Analizando..." : "Forzar ciclo manual"}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-display font-semibold border transition-all ${
              isManualRunning || isAnalyzing
                ? "bg-bot-yellow/5 text-bot-yellow/50 border-bot-yellow/10 cursor-not-allowed"
                : "bg-bot-yellow/10 text-bot-yellow border-bot-yellow/20 hover:bg-bot-yellow/20 hover:border-bot-yellow/40"
            }`}
          >
            <RotateCw className={`w-3 h-3 ${isManualRunning || isAnalyzing ? "animate-spin" : ""}`} />
            {isManualRunning || isAnalyzing ? "..." : "Run"}
          </button>

          <button
            onClick={onSettings}
            className="flex items-center gap-1.5 bg-bot-surface/50 text-bot-muted px-3 py-1.5 rounded-lg text-xs 
                       hover:text-white hover:bg-bot-surface border border-bot-border/40 hover:border-bot-border transition-all"
          >
            <Settings className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
