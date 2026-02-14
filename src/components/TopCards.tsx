import { BotStats } from "../types";
import { formatCurrency, formatPnl, formatPercent } from "../utils/format";
import { WalletInfo, formatAddress } from "../services/wallet";

interface TopCardsProps {
  stats: BotStats;
  walletInfo: WalletInfo | null;
}

export default function TopCards({ stats, walletInfo }: TopCardsProps) {
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
          💰 Polymarket
        </div>
        <div className="text-2xl font-bold text-bot-green">
          {walletInfo?.polymarketBalance != null
            ? `$${walletInfo.polymarketBalance.toFixed(2)}`
            : walletInfo?.balance?.usdc != null
              ? `$${walletInfo.balance.usdc.toFixed(2)}`
              : "---"}
        </div>
        <div className="text-xs text-bot-muted mt-1 truncate" title={walletInfo?.address}>
          {walletInfo?.isValid ? (
            <>
              {formatAddress(walletInfo.address)}
              {walletInfo.balance != null && (
                <span className="ml-1 text-gray-600">
                  (wallet: ${walletInfo.balance.usdc.toFixed(2)})
                </span>
              )}
            </>
          ) : "No conectada"}
        </div>
      </div>

      {/* Paper Balance (Equity) */}
      <div className="bg-bot-card border border-bot-border rounded-lg px-4 py-3">
        <div className="text-xs text-bot-muted font-semibold tracking-wider uppercase mb-1">
          📝 Paper Trading
        </div>
        <div className="text-2xl font-bold text-white">
          {formatCurrency(stats.current_balance)}
        </div>
        <div className="text-xs text-bot-muted mt-1">
          Inicial: {formatCurrency(stats.initial_balance)}
        </div>
        <div className="text-[10px] text-gray-600 mt-0.5">
          🔒{formatCurrency(stats.invested_in_orders || 0)} en juego | Equity: {formatCurrency(equity)}
        </div>
      </div>

      {/* Total P&L */}
      <div className="bg-bot-card border border-bot-border rounded-lg px-4 py-3">
        <div className="text-xs text-bot-muted font-semibold tracking-wider uppercase mb-1">
          P&L Total
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
            Realizado: {formatPnl(stats.total_pnl)}
          </div>
        )}
      </div>

      {/* Open Orders */}
      <div className="bg-bot-card border border-bot-border rounded-lg px-4 py-3">
        <div className="text-xs text-bot-muted font-semibold tracking-wider uppercase mb-1">
          Órdenes Abiertas
        </div>
        <div className="text-2xl font-bold text-blue-400">
          {stats.open_orders || 0}
        </div>
        <div className="text-xs text-bot-muted mt-1">
          Valor: ${(stats.pending_value || 0).toFixed(2)}
        </div>
      </div>

      {/* Win Rate */}
      <div className="bg-bot-card border border-bot-border rounded-lg px-4 py-3">
        <div className="text-xs text-bot-muted font-semibold tracking-wider uppercase mb-1">
          Tasa de Éxito
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
          Mercados
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
