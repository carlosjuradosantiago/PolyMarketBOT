// ─── Paper Trading Service (Dashboard-only) ─────────────────────
// Solo funciones de LECTURA y cálculo de estadísticas.
// Toda lógica de trading/resolución/órdenes vive en Edge Functions.

import { PaperOrder, Portfolio, BalancePoint } from "../types";

// ─── Stats Calculation ────────────────────────────────────────

export interface PortfolioStats {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  avgReturn: number;
  avgBet: number;
  bestTrade: number;
  worstTrade: number;
  openPositions: number;
  totalInvested: number;
  equity: number;
  maxDrawdown: number;
}

export function calculateStats(portfolio: Portfolio): PortfolioStats {
  const closed = portfolio.closedOrders || [];
  const open = portfolio.openOrders || [];

  const wins = closed.filter((o) => o.pnl !== undefined && o.pnl > 0).length;
  const losses = closed.filter((o) => o.pnl !== undefined && o.pnl <= 0).length;
  const totalPnl = closed.reduce((s, o) => s + (o.pnl || 0), 0);
  const totalInvested = open.reduce((s, o) => s + (o.totalCost || 0), 0);
  const totalBetAmount = closed.reduce((s, o) => s + (o.totalCost || 0), 0);

  const pnls = closed.map((o) => o.pnl || 0);
  const bestTrade = pnls.length ? Math.max(...pnls) : 0;
  const worstTrade = pnls.length ? Math.min(...pnls) : 0;

  // Simplified max-drawdown from sequential P&L
  let peak = 0;
  let maxDD = 0;
  let cumulative = 0;
  for (const p of pnls) {
    cumulative += p;
    if (cumulative > peak) peak = cumulative;
    const dd = peak - cumulative;
    if (dd > maxDD) maxDD = dd;
  }

  return {
    totalTrades: closed.length,
    wins,
    losses,
    winRate: closed.length > 0 ? (wins / closed.length) * 100 : 0,
    totalPnl,
    avgReturn: closed.length > 0 ? totalPnl / closed.length : 0,
    avgBet: closed.length > 0 ? totalBetAmount / closed.length : 0,
    bestTrade,
    worstTrade,
    openPositions: open.length,
    totalInvested,
    equity: portfolio.balance + totalInvested,
    maxDrawdown: maxDD,
  };
}

// ─── Balance History (para gráfica) ───────────────────────────

export function getBalanceHistory(
  portfolio: Portfolio
): BalancePoint[] {
  const closed = [...(portfolio.closedOrders || [])].sort(
    (a, b) =>
      new Date(a.resolvedAt || a.createdAt).getTime() -
      new Date(b.resolvedAt || b.createdAt).getTime()
  );

  const history: BalancePoint[] = [];
  let running = portfolio.initialBalance || 1500;

  // Punto inicial
  if (closed.length > 0) {
    const first = new Date(closed[0].resolvedAt || closed[0].createdAt);
    first.setDate(first.getDate() - 1);
    history.push({
      timestamp: first.toISOString(),
      balance: running,
      label: "Start",
    });
  }

  for (const order of closed) {
    running += order.pnl || 0;
    const ts = order.resolvedAt || order.createdAt;
    history.push({
      timestamp: ts,
      balance: Math.max(0, running),
      label: `${order.pnl && order.pnl >= 0 ? "+" : ""}$${(order.pnl || 0).toFixed(2)}`,
    });
  }

  return history;
}
