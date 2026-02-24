import { BotStats } from "../types";
import { formatCurrency, formatPnl, formatPercent } from "../utils/format";
import { WalletInfo, formatAddress } from "../types";
import { useTranslation } from "../i18n";

interface TopCardsProps {
  stats: BotStats;
  walletInfo: WalletInfo | null;
}

export default function TopCards({ stats, walletInfo }: TopCardsProps) {
  const { t } = useTranslation();
  const equity = stats.current_balance + (stats.invested_in_orders || 0);
  const pnlPositive = stats.total_pnl >= 0;
  const roi = stats.initial_balance > 0 
    ? (stats.total_pnl / stats.initial_balance) * 100 
    : 0;

  return (
    <div className="grid grid-cols-6 gap-2.5 px-5 py-3 stagger-children">
      {/* Polymarket Balance */}
      <div className="glass-card glow-border-green rounded-xl px-4 py-3 group hover:scale-[1.01] transition-transform">
        <div className="text-[10px] font-display font-semibold tracking-widest uppercase mb-1.5 text-bot-green/80">
          {t("card.polymarket")}
        </div>
        <div className="text-2xl font-display font-extrabold text-gradient">
          {(() => {
            const cash = walletInfo?.polymarketBalance ?? walletInfo?.balance?.usdc ?? null;
            const posValue = walletInfo?.openOrders?.totalPositionValue ?? 0;
            const total = (cash ?? 0) + posValue;
            return cash != null ? `$${total.toFixed(2)}` : "---";
          })()}
        </div>
        <div className="text-[10px] text-bot-muted mt-1.5 truncate" title={walletInfo?.address}>
          {walletInfo?.isValid ? (
            <>
              <span className="text-bot-gray">{formatAddress(walletInfo.address)}</span>
              {walletInfo.openOrders?.positions && walletInfo.openOrders.positions.length > 0 ? (
                <span className="ml-1.5 text-bot-cyan/70">
                  {walletInfo.openOrders.positions.length} pos
                  {walletInfo.openOrders.totalPnl !== 0 && (
                    <span className={walletInfo.openOrders.totalPnl >= 0 ? " text-bot-green" : " text-bot-red"}>
                      {" "}{walletInfo.openOrders.totalPnl >= 0 ? "+" : ""}${walletInfo.openOrders.totalPnl.toFixed(2)}
                    </span>
                  )}
                </span>
              ) : walletInfo.openOrders && walletInfo.openOrders.count > 0 ? (
                <span className="ml-1.5 text-bot-yellow/60">
                  {walletInfo.openOrders.count} {walletInfo.openOrders.count === 1 ? "orden" : "órdenes"}
                </span>
              ) : null}
            </>
          ) : <span className="text-bot-muted/50">{t("card.notConnected")}</span>}
        </div>
      </div>

      {/* Paper Equity */}
      <div className="glass-card rounded-xl px-4 py-3 hover:scale-[1.01] transition-transform">
        <div className="text-[10px] font-display font-semibold tracking-widest uppercase mb-1.5 text-bot-muted">
          {t("card.equity")}
        </div>
        <div className="text-2xl font-display font-extrabold text-white">
          {formatCurrency(equity)}
        </div>
        <div className="text-[10px] text-bot-muted mt-1.5">
          {t("card.initial")}: <span className="text-bot-gray">{formatCurrency(stats.initial_balance)}</span>
        </div>
        <div className="text-[9px] text-bot-muted/50 mt-0.5 font-mono">
          {t("card.cash")}: {formatCurrency(stats.current_balance)} · {t("card.inPlay")}: {formatCurrency(stats.invested_in_orders || 0)}
        </div>
      </div>

      {/* Total P&L */}
      <div className={`glass-card rounded-xl px-4 py-3 hover:scale-[1.01] transition-transform ${pnlPositive ? 'glow-border-green' : 'glow-border-red'}`}>
        <div className="text-[10px] font-display font-semibold tracking-widest uppercase mb-1.5 text-bot-muted">
          {t("card.pnlTotal")}
        </div>
        <div
          className={`text-2xl font-display font-extrabold ${
            pnlPositive ? "text-bot-green" : "text-bot-red"
          }`}
        >
          {formatPnl(stats.total_pnl)}
        </div>
        <div
          className={`text-[10px] mt-1.5 font-mono font-semibold ${
            roi >= 0 ? "text-bot-green/60" : "text-bot-red/60"
          }`}
        >
          {roi >= 0 ? "+" : ""}{roi.toFixed(1)}% ROI
        </div>
      </div>

      {/* Open Orders */}
      <div className="glass-card rounded-xl px-4 py-3 hover:scale-[1.01] transition-transform">
        <div className="text-[10px] font-display font-semibold tracking-widest uppercase mb-1.5 text-bot-muted">
          {t("card.openOrders")}
        </div>
        <div className="text-2xl font-display font-extrabold text-bot-blue">
          {stats.open_orders}
        </div>
        <div className="text-[10px] text-bot-muted mt-1.5 font-mono">
          {t("card.inPlay")}: {formatCurrency(stats.invested_in_orders || 0)}
        </div>
      </div>

      {/* Win Rate */}
      <div className="glass-card rounded-xl px-4 py-3 hover:scale-[1.01] transition-transform">
        <div className="text-[10px] font-display font-semibold tracking-widest uppercase mb-1.5 text-bot-muted">
          {t("card.winRate")}
        </div>
        <div className="text-2xl font-display font-extrabold text-white">
          {formatPercent(stats.win_rate)}
        </div>
        <div className="text-[10px] text-bot-muted mt-1.5">
          <span className="text-bot-green/70">{stats.wins}W</span>
          <span className="mx-1 text-bot-border-light">/</span>
          <span className="text-bot-red/70">{stats.losses}L</span>
        </div>
      </div>

      {/* Markets Scanned */}
      <div className="glass-card glow-border-purple rounded-xl px-4 py-3 hover:scale-[1.01] transition-transform">
        <div className="text-[10px] font-display font-semibold tracking-widest uppercase mb-1.5 text-bot-muted">
          {t("card.markets")}
        </div>
        <div className="text-2xl font-display font-extrabold text-bot-purple">
          {stats.markets_scanned.toLocaleString()}
        </div>
        <div className="text-[10px] text-bot-muted mt-1.5">
          Ciclo <span className="text-bot-gray font-mono">#{stats.cycle}</span>
        </div>
      </div>
    </div>
  );
}
