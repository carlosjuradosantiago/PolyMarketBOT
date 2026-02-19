import { BotStats } from "../types";
import { formatCurrency, formatPnl, formatPercent, formatNumber } from "../utils/format";
import { useTranslation } from "../i18n";

interface StatsPanelProps {
  stats: BotStats;
}

export default function StatsPanel({ stats }: StatsPanelProps) {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-2 gap-2.5 px-5 pb-3">
      {/* Survival Card */}
      <div className="glass-card rounded-xl px-4 py-3">
        <div className="text-[9px] font-display font-bold tracking-[0.2em] text-bot-muted/50 uppercase mb-2.5">
          {t("stats.survival")}
        </div>
        <div className="grid grid-cols-2 gap-y-2 text-xs">
          <StatRow
            label={t("stats.dailyAPICost")}
            value={`~${formatCurrency(stats.daily_api_cost)}`}
            color="text-bot-red/80"
          />
          <StatRow
            label={t("stats.runway")}
            value={t("stats.runwayDays", formatNumber(stats.runway_days))}
            color="text-white"
          >
            <div className="w-16 h-1 bg-bot-border/50 rounded-full mt-1 overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-bot-green to-bot-cyan"
                style={{
                  width: `${Math.min(100, (stats.runway_days / 2000) * 100)}%`,
                }}
              />
            </div>
          </StatRow>
        </div>
      </div>

      {/* Performance Card */}
      <div className="glass-card rounded-xl px-4 py-3">
        <div className="grid grid-cols-7 gap-3 text-center">
          <StatCol label={t("stats.trades")} value={stats.total_trades.toString()} />
          <StatCol
            label={t("stats.marketsScanned")}
            value={formatNumber(stats.markets_scanned)}
          />
          <StatCol
            label={t("stats.avgBet")}
            value={formatCurrency(stats.avg_bet)}
          />
          <StatCol
            label={t("stats.bestTrade")}
            value={formatPnl(stats.best_trade)}
            color="text-bot-green"
          />
          <StatCol
            label={t("stats.worstTrade")}
            value={formatPnl(stats.worst_trade)}
            color="text-bot-red"
          />
          <StatCol
            label={t("stats.sharpe")}
            value={stats.sharpe_ratio.toFixed(2)}
          />
          <StatCol
            label={t("stats.avgEdge")}
            value={formatPercent(stats.avg_edge)}
          />
        </div>
      </div>
    </div>
  );
}

function StatRow({
  label,
  value,
  color = "text-white",
  children,
}: {
  label: string;
  value: string;
  color?: string;
  children?: React.ReactNode;
}) {
  return (
    <>
      <span className="text-bot-muted/60 text-[11px]">{label}</span>
      <div>
        <span className={`font-mono font-semibold text-[11px] ${color}`}>{value}</span>
        {children}
      </div>
    </>
  );
}

function StatCol({
  label,
  value,
  color = "text-white",
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div>
      <div className={`text-sm font-display font-bold ${color}`}>{value}</div>
      <div className="text-[9px] text-bot-muted/40 font-display uppercase tracking-wider mt-0.5">
        {label}
      </div>
    </div>
  );
}
