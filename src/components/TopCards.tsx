import { BotStats } from "../types";
import { formatCurrency, formatPnl, formatPercent } from "../utils/format";
import { WalletInfo, formatAddress } from "../services/wallet";
import { useTranslation } from "../i18n";

interface TopCardsProps {
  stats: BotStats;
  walletInfo: WalletInfo | null;
}

export default function TopCards({ stats, walletInfo }: TopCardsProps) {
  const { t } = useTranslation();
  // Equity = cash balance + money invested in open orders
  const equity = stats.current_balance + (stats.invested_in_orders || 0);
  // P&L = realized only (resolved trades). ROI based on realized P&L.
  const pnlPositive = stats.total_pnl >= 0;
  const roi = stats.initial_balance > 0 
    ? (stats.total_pnl / stats.initial_balance) * 100 
    : 0;

  return (
    <div className="grid grid-cols-6 gap-3 px-4 py-3">
      {/* Polymarket Balance (main real balance) */}
      <div className="bg-bot-card border border-bot-green/30 rounded-lg px-4 py-3">
        <div className="text-xs text-bot-green font-semibold tracking-wider uppercase mb-1">
          {t("card.polymarket")}
        </div>
        <div className="text-2xl font-bold text-bot-green">
          {(() => {
            const cash = walletInfo?.polymarketBalance ?? walletInfo?.balance?.usdc ?? null;
            const posValue = walletInfo?.openOrders?.totalPositionValue ?? 0;
            const total = (cash ?? 0) + posValue;
            return cash != null ? `$${total.toFixed(2)}` : "---";
          })()}
        </div>
        <div className="text-xs text-bot-muted mt-1 truncate" title={walletInfo?.address}>
          {walletInfo?.isValid ? (
            <>
              {formatAddress(walletInfo.address)}
              {/* Show positions summary */}
              {walletInfo.openOrders?.positions && walletInfo.openOrders.positions.length > 0 ? (
                <span className="ml-1 text-cyan-400">
                  📊 {walletInfo.openOrders.positions.length} pos
                  {walletInfo.openOrders.totalPnl !== 0 && (
                    <span className={walletInfo.openOrders.totalPnl >= 0 ? " text-bot-green" : " text-bot-red"}>
                      {" "}{walletInfo.openOrders.totalPnl >= 0 ? "+" : ""}${walletInfo.openOrders.totalPnl.toFixed(2)}
                    </span>
                  )}
                </span>
              ) : walletInfo.openOrders && walletInfo.openOrders.count > 0 ? (
                <span className="ml-1 text-yellow-400">
                  📋 {walletInfo.openOrders.count} {walletInfo.openOrders.count === 1 ? "orden" : "órdenes"}
                </span>
              ) : null}
            </>
          ) : t("card.notConnected")}
        </div>
        {/* Position details */}
        {walletInfo?.openOrders?.positions && walletInfo.openOrders.positions.length > 0 && (
          <div className="mt-1.5 space-y-0.5">
            {walletInfo.openOrders.positions.map((pos, i) => (
              <div key={i} className="text-[10px] text-gray-400 truncate" title={pos.marketName || pos.market}>
                <span className="text-cyan-500">{pos.outcome}</span>
                {" "}{pos.shares.toFixed(1)} @${pos.avgPrice.toFixed(2)}
                {pos.currentPrice != null && (
                  <>
                    {" → $"}{pos.currentPrice.toFixed(2)}
                    <span className={(pos.pnl ?? 0) >= 0 ? " text-bot-green" : " text-bot-red"}>
                      {" "}{(pos.pnl ?? 0) >= 0 ? "+" : ""}${(pos.pnl ?? 0).toFixed(2)}
                    </span>
                  </>
                )}
                {pos.marketName && (
                  <span className="text-gray-600"> — {pos.marketName.length > 40 ? pos.marketName.slice(0, 40) + "…" : pos.marketName}</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Paper Balance (Equity = cash + invested) */}
      <div className="bg-bot-card border border-bot-border rounded-lg px-4 py-3">
        <div className="text-xs text-bot-muted font-semibold tracking-wider uppercase mb-1">
          {t("card.equity")}
        </div>
        <div className="text-2xl font-bold text-white">
          {formatCurrency(equity)}
        </div>
        <div className="text-xs text-bot-muted mt-1">
          {t("card.initial")}: {formatCurrency(stats.initial_balance)}
        </div>
        <div className="text-[10px] text-gray-600 mt-0.5">
          💵 {t("card.cash")}: {formatCurrency(stats.current_balance)} | 🔒 {t("card.inPlay")}: {formatCurrency(stats.invested_in_orders || 0)}
        </div>
      </div>

      {/* Total P&L */}
      <div className="bg-bot-card border border-bot-border rounded-lg px-4 py-3">
        <div className="text-xs text-bot-muted font-semibold tracking-wider uppercase mb-1">
          {t("card.pnlTotal")}
        </div>
        <div
          className={`text-2xl font-bold ${
            pnlPositive ? "text-bot-green" : "text-bot-red"
          }`}
        >
          {formatPnl(stats.total_pnl)}
        </div>
        <div
          className={`text-xs mt-1 ${
            roi >= 0 ? "text-bot-green/70" : "text-bot-red/70"
          }`}
        >
          {roi >= 0 ? "+" : ""}{roi.toFixed(1)}% ROI
        </div>
        {stats.total_pnl !== 0 && (
          <div className="text-[10px] text-gray-600 mt-0.5">
            {t("card.realized")}: {formatPnl(stats.total_pnl)}
          </div>
        )}
      </div>

      {/* Open Orders */}
      <div className="bg-bot-card border border-bot-border rounded-lg px-4 py-3">
        <div className="text-xs text-bot-muted font-semibold tracking-wider uppercase mb-1">
          {t("card.openOrders")}
        </div>
        <div className="text-2xl font-bold text-blue-400">
          {stats.open_orders || 0}
        </div>
        <div className="text-xs text-bot-muted mt-1">
          {t("card.value")}: ${(stats.pending_value || 0).toFixed(2)}
        </div>
      </div>

      {/* Win Rate */}
      <div className="bg-bot-card border border-bot-border rounded-lg px-4 py-3">
        <div className="text-xs text-bot-muted font-semibold tracking-wider uppercase mb-1">
          {t("card.winRate")}
        </div>
        <div className="text-2xl font-bold text-white">
          {formatPercent(stats.win_rate)}
        </div>
        <div className="text-xs text-bot-muted mt-1">
          {stats.wins}G / {stats.losses}P
        </div>
      </div>

      {/* Markets Scanned */}
      <div className="bg-bot-card border border-bot-border rounded-lg px-4 py-3">
        <div className="text-xs text-bot-muted font-semibold tracking-wider uppercase mb-1">
          {t("card.markets")}
        </div>
        <div className="text-2xl font-bold text-purple-400">
          {stats.markets_scanned.toLocaleString()}
        </div>
        <div className="text-xs text-bot-muted mt-1">
          Ciclo #{stats.cycle}
        </div>
      </div>
    </div>
  );
}
