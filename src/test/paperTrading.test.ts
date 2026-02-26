import { describe, it, expect } from "vitest";
import { calculateStats, getBalanceHistory } from "../services/paperTrading";
import { Portfolio } from "../types";

function makeOrder(overrides: Record<string, any> = {}) {
  return {
    id: "test-" + Math.random().toString(36).slice(2, 8),
    marketId: "12345",
    conditionId: "0xabc",
    marketQuestion: "Test market?",
    marketSlug: "test-market",
    outcome: "Yes",
    outcomeIndex: 0,
    side: "buy" as const,
    price: 0.5,
    quantity: 10,
    totalCost: 5,
    potentialPayout: 10,
    status: "won" as const,
    createdAt: "2025-01-01T00:00:00Z",
    pnl: 5,
    ...overrides,
  };
}

function makePortfolio(overrides: Partial<Portfolio> = {}): Portfolio {
  return {
    balance: 1500,
    initialBalance: 1500,
    totalPnl: 0,
    openOrders: [],
    closedOrders: [],
    lastUpdated: new Date().toISOString(),
    ...overrides,
  };
}

describe("calculateStats", () => {
  it("devuelve stats vacíos sin órdenes", () => {
    const stats = calculateStats(makePortfolio());
    expect(stats.totalTrades).toBe(0);
    expect(stats.wins).toBe(0);
    expect(stats.losses).toBe(0);
    expect(stats.winRate).toBe(0);
    expect(stats.totalPnl).toBe(0);
    expect(stats.sharpeRatio).toBe(0);
  });

  it("calcula wins y losses correctamente", () => {
    const portfolio = makePortfolio({
      closedOrders: [
        makeOrder({ pnl: 5, status: "won" }),
        makeOrder({ pnl: 3, status: "won" }),
        makeOrder({ pnl: -5, status: "lost" }),
      ],
    });
    const stats = calculateStats(portfolio);
    expect(stats.wins).toBe(2);
    expect(stats.losses).toBe(1);
    expect(stats.totalTrades).toBe(3);
    expect(stats.winRate).toBeCloseTo(66.67, 1);
    expect(stats.totalPnl).toBeCloseTo(3, 2);
  });

  it("calcula Sharpe ratio > 0 para trades ganadores", () => {
    const portfolio = makePortfolio({
      closedOrders: [
        makeOrder({ pnl: 5, totalCost: 5 }),  // 100% return
        makeOrder({ pnl: 3, totalCost: 5 }),  // 60% return
        makeOrder({ pnl: 4, totalCost: 5 }),  // 80% return
      ],
    });
    const stats = calculateStats(portfolio);
    expect(stats.sharpeRatio).toBeGreaterThan(0);
  });

  it("calcula Sharpe ratio negativo para trades perdedores", () => {
    const portfolio = makePortfolio({
      closedOrders: [
        makeOrder({ pnl: -5, totalCost: 5 }),
        makeOrder({ pnl: -3, totalCost: 5 }),
        makeOrder({ pnl: -4, totalCost: 5 }),
      ],
    });
    const stats = calculateStats(portfolio);
    expect(stats.sharpeRatio).toBeLessThan(0);
  });

  it("calcula max drawdown correctamente", () => {
    const portfolio = makePortfolio({
      closedOrders: [
        makeOrder({ pnl: 10 }),
        makeOrder({ pnl: -15 }),
        makeOrder({ pnl: -5 }),
        makeOrder({ pnl: 20 }),
      ],
    });
    const stats = calculateStats(portfolio);
    // Peak = 10, then drops to -10, drawdown = 20
    expect(stats.maxDrawdown).toBe(20);
  });

  it("calcula equity incluyendo órdenes abiertas", () => {
    const portfolio = makePortfolio({
      balance: 1000,
      openOrders: [
        makeOrder({ totalCost: 50, status: "pending" }),
        makeOrder({ totalCost: 30, status: "filled" }),
      ],
    });
    const stats = calculateStats(portfolio);
    expect(stats.equity).toBe(1080);
    expect(stats.openPositions).toBe(2);
    expect(stats.totalInvested).toBe(80);
  });
});

describe("getBalanceHistory", () => {
  it("devuelve array vacío sin órdenes cerradas", () => {
    const history = getBalanceHistory(makePortfolio());
    expect(history).toHaveLength(0);
  });

  it("crea historia de balance desde órdenes cerradas", () => {
    const portfolio = makePortfolio({
      initialBalance: 1000,
      closedOrders: [
        makeOrder({ pnl: 10, resolvedAt: "2025-01-02T00:00:00Z" }),
        makeOrder({ pnl: -5, resolvedAt: "2025-01-03T00:00:00Z" }),
      ],
    });
    const history = getBalanceHistory(portfolio);
    expect(history.length).toBe(3); // Start + 2 orders
    expect(history[0].balance).toBe(1000); // Initial
    expect(history[1].balance).toBe(1010); // +10
    expect(history[2].balance).toBe(1005); // -5
  });
});
