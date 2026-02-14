import { Settings, Play, Square, Zap } from "lucide-react";
import { BotStats } from "../types";

interface HeaderProps {
  stats: BotStats;
  isRunning: boolean;
  isDemoMode: boolean;
  countdown: number;
  onStart: () => void;
  onStop: () => void;
  onSettings: () => void;
}

export default function Header({
  stats,
  isRunning,
  isDemoMode,
  countdown,
  onStart,
  onStop,
  onSettings,
}: HeaderProps) {
  const fmtCountdown = () => {
    if (countdown <= 0) return "--:--";
    const m = Math.floor(countdown / 60);
    const s = countdown % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  };
  return (
    <div className="flex items-center justify-between px-4 py-3 border-b border-bot-border">
      {/* Left: Title */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <Zap className="w-5 h-5 text-bot-cyan" />
          <span className="text-lg font-bold tracking-wider text-white">
            POLYMARKET AGENT
          </span>
          <span className="text-bot-muted mx-1">/</span>
          <span className="text-lg font-bold tracking-wider text-bot-cyan">
            SURVIVAL MODE
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
            {isRunning ? "Alive" : "Stopped"}
          </span>
        </div>

        {isDemoMode && (
          <span className="text-xs bg-bot-purple/20 text-bot-purple px-2 py-0.5 rounded ml-2">
            DEMO
          </span>
        )}
      </div>

      {/* Right: Controls & Info */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-3 text-sm text-bot-muted">
          <span>
            Uptime{" "}
            <span className="text-white font-medium">{stats.uptime}</span>
          </span>
          <span>
            Cycle{" "}
            <span className="text-white font-medium">#{stats.cycle}</span>
          </span>
          <span>
            Next{" "}
            <span className={`font-mono font-bold ${countdown <= 60 ? "text-yellow-400" : "text-bot-cyan"}`}>{fmtCountdown()}</span>
          </span>
        </div>

        <div className="flex items-center gap-2">
          {isRunning ? (
            <button
              onClick={onStop}
              className="flex items-center gap-1.5 bg-bot-red/20 text-bot-red px-4 py-1.5 rounded text-sm font-semibold hover:bg-bot-red/30 transition-colors"
            >
              <Square className="w-3.5 h-3.5" />
              STOP
            </button>
          ) : (
            <button
              onClick={onStart}
              className="flex items-center gap-1.5 bg-bot-green/20 text-bot-green px-4 py-1.5 rounded text-sm font-semibold hover:bg-bot-green/30 transition-colors"
            >
              <Play className="w-3.5 h-3.5" />
              START
            </button>
          )}

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
