import { BotStats } from "../types";
import { formatCurrency, formatPnl, formatPercent, formatNumber } from "../utils/format";
import { useTranslation } from "../i18n";

interface StatsPanelProps {
  stats: BotStats;
}

export default function StatsPanel({ stats }: StatsPanelProps) {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-2 gap-3 px-4 pb-4">
      {/* Survival Card */}
      <div className="bg-bot-card border border-bot-border rounded-lg px-4 py-3">
        <div className="text-xs font-semibold tracking-wider text-bot-muted uppercase mb-2">
          {t("stats.survival")}
        </div>
        <div className="grid grid-cols-2 gap-y-1.5 text-xs">
          <StatRow
            label={t("stats.dailyAPICost")}
            value={`~${formatCurrency(stats.daily_api_cost)}`}
            color="text-bot-red"
          />
          <StatRow
            label={t("stats.runway")}
            value={t("stats.runwayDays", formatNumber(stats.runway_days))}
            color="text-white"
          >
            {/* Runway bar */}
            <div className="w-16 h-1 bg-bot-border rounded-full mt-0.5">
              <div
                className="h-full bg-gradient-to-r from-bot-green to-bot-cyan rounded-full"
                style={{
                  width: `${Math.min(100, (stats.runway_days / 2000) * 100)}%`,
                }}
              />
            </div>
          </StatRow>
        </div>
      </div>

      {/* Performance Card */}
      <div className="bg-bot-card border border-bot-border rounded-lg px-4 py-3">
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
      <span className="text-bot-muted">{label}</span>
      <div>
        <span className={`font-semibold ${color}`}>{value}</span>
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
      <div className={`text-sm font-bold ${color}`}>{value}</div>
      <div className="text-[10px] text-bot-muted uppercase tracking-wider mt-0.5">
        {label}
      </div>
    </div>
  );
}
