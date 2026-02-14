// ─── Paper Trading Service ─────────────────────────────────────────
// Simulates orders at real market prices without risking real money

import { 
  PaperOrder, 
  Portfolio, 
  OrderSide, 
  OrderStatus,
  PolymarketMarket,
  defaultPortfolio,
  ActivityEntry,
} from "../types";
import { isMarketResolved, getWinningOutcome, fetchMarketById } from "./polymarket";
import { dbLoadPortfolio, dbSavePortfolio, dbCreateOrder, dbUpdateOrder, dbCancelOrder, dbAddBalance, dbResetPortfolio } from "./db";

// ─── Portfolio Management ─────────────────────────────────────────

/** Load from Supabase DB */
export async function loadPortfolioFromDB(): Promise<Portfolio> {
  try {
    return await dbLoadPortfolio();
  } catch (e) {
    console.error("[Paper] DB load failed:", e);
    return { ...defaultPortfolio };
  }
}

/** @deprecated Use loadPortfolioFromDB instead. Kept for sync compatibility. */
export function loadPortfolio(): Portfolio {
  return { ...defaultPortfolio };
}

export function savePortfolio(portfolio: Portfolio): void {
  // Persist to Supabase in background
  dbSavePortfolio(portfolio).catch(e => console.error("[Paper] DB save failed:", e));
}

export function resetPortfolio(initialBalance: number = 100): Portfolio {
  const portfolio: Portfolio = {
    balance: initialBalance,
    initialBalance,
    totalPnl: 0,
    openOrders: [],
    closedOrders: [],
    lastUpdated: new Date().toISOString(),
  };
  savePortfolio(portfolio);
  // Full DB reset in background
  dbResetPortfolio(initialBalance).catch(e => console.error("[Paper] DB reset failed:", e));
  return portfolio;
}

// ─── Order Functions ─────────────────────────────────────────

export function generateOrderId(): string {
  return `paper_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

export function createPaperOrder(
  market: PolymarketMarket,
  outcomeIndex: number,
  side: OrderSide,
  quantity: number,
  portfolio: Portfolio
): { order: PaperOrder | null; portfolio: Portfolio; error?: string } {
  // Get current price
  const price = parseFloat(market.outcomePrices[outcomeIndex]);

  // Block lottery-ticket prices (< 3¢)
  if (price < 0.03) {
    return {
      order: null,
      portfolio,
      error: `Precio ${(price * 100).toFixed(1)}¢ demasiado bajo (mín 3¢). Ticket de lotería rechazado.`,
    };
  }
  
  // Calculate cost
  const totalCost = quantity * price;
  
  // Check balance
  if (totalCost > portfolio.balance) {
    return {
      order: null,
      portfolio,
      error: `Insufficient balance. Need $${totalCost.toFixed(2)}, have $${portfolio.balance.toFixed(2)}`,
    };
  }
  
  // Calculate potential payout (if win)
  const potentialPayout = quantity; // Full $1 per share if wins
  
  // Create order
  const order: PaperOrder = {
    id: generateOrderId(),
    marketId: market.id,
    conditionId: market.conditionId,
    marketQuestion: market.question,
    marketSlug: market.slug,
    outcome: market.outcomes[outcomeIndex],
    outcomeIndex,
    side,
    price,
    quantity,
    totalCost,
    potentialPayout,
    status: "filled", // Paper orders fill instantly
    createdAt: new Date().toISOString(),
    endDate: market.endDate || "", // Store market expiration date for smart resolution
  };
  
  // Update portfolio in-memory (DB persistence handled by dbCreateOrder)
  const updatedPortfolio: Portfolio = {
    ...portfolio,
    balance: portfolio.balance - totalCost,
    openOrders: [...portfolio.openOrders, order],
    lastUpdated: new Date().toISOString(),
  };
  
  // Persist order to DB — dbCreateOrder also calls deduct_balance RPC atomically
  dbCreateOrder(order).catch(e => console.error("[Paper] DB create order failed:", e));
  
  return { order, portfolio: updatedPortfolio };
}

export function cancelPaperOrder(
  orderId: string,
  portfolio: Portfolio
): Portfolio {
  const orderIndex = portfolio.openOrders.findIndex(o => o.id === orderId);
  
  if (orderIndex === -1) {
    return portfolio;
  }
  
  const order = portfolio.openOrders[orderIndex];
  
  // Refund the cost
  const updatedBalance = portfolio.balance + order.totalCost;
  
  // Move to closed orders
  const cancelledOrder: PaperOrder = {
    ...order,
    status: "cancelled",
    resolvedAt: new Date().toISOString(),
    pnl: 0, // No P&L for cancelled orders
  };
  
  const updatedPortfolio: Portfolio = {
    ...portfolio,
    balance: updatedBalance,
    openOrders: portfolio.openOrders.filter(o => o.id !== orderId),
    closedOrders: [...portfolio.closedOrders, cancelledOrder],
    lastUpdated: new Date().toISOString(),
  };
  
  savePortfolio(updatedPortfolio);
  // Persist cancel to DB (includes atomic add_balance RPC)
  dbCancelOrder(orderId, order.totalCost).catch(e => console.error("[Paper] DB cancel failed:", e));
  
  return updatedPortfolio;
}

// ─── Resolution Functions ─────────────────────────────────────────

/**
 * Smart order resolution:
 * 1. Skip orders whose market endDate hasn't passed yet
 * 2. After endDate, periodically check the Gamma API for resolved=true
 * 3. Only resolve (win/lose) when the market is officially resolved
 * 4. Throttle API calls: max 1 check per order per 5 minutes
 */
export async function checkAndResolveOrders(
  portfolio: Portfolio
): Promise<{ 
  portfolio: Portfolio; 
  resolved: PaperOrder[];
  activities: ActivityEntry[];
}> {
  const resolved: PaperOrder[] = [];
  const activities: ActivityEntry[] = [];
  let updatedOpenOrders = [...portfolio.openOrders];
  let updatedClosedOrders = [...portfolio.closedOrders];
  let updatedBalance = portfolio.balance;
  let totalPnl = portfolio.totalPnl;
  
  const now = new Date();
  const CHECK_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes between checks per order
  
  for (const order of portfolio.openOrders) {
    try {
      // ── Step 1: Skip if market hasn't expired yet ──
      if (order.endDate) {
        const endDate = new Date(order.endDate);
        if (now < endDate) {
          // Market still active — no point checking
          continue;
        }
      }
      
      // ── Step 2: Throttle API calls per order ──
      if (order.lastCheckedAt) {
        const lastCheck = new Date(order.lastCheckedAt).getTime();
        if (now.getTime() - lastCheck < CHECK_COOLDOWN_MS) {
          continue; // Checked recently, skip
        }
      }
      
      // ── Step 3: Mark this order as checked (update timestamp) ──
      const orderIdx = updatedOpenOrders.findIndex(o => o.id === order.id);
      if (orderIdx >= 0) {
        updatedOpenOrders[orderIdx] = {
          ...updatedOpenOrders[orderIdx],
          lastCheckedAt: now.toISOString(),
        };
      }
      
      // ── Step 4: Fetch market from Gamma API using numeric marketId ──
      const market = await fetchMarketById(order.marketId);
      if (!market) {
        console.warn(`[Resolution] Could not fetch market for ${order.marketId} (${order.marketQuestion?.slice(0, 30)})`);
        continue;
      }
      
      // ── Step 5: Only resolve if market is OFFICIALLY resolved ──
      if (!isMarketResolved(market)) {
        // Market expired but not yet resolved — UMA oracle needs time
        // (proposal + 2h dispute period). We'll check again next cycle.
        continue;
      }
      
      // ── Step 6: Determine winner and calculate P&L ──
      const winningOutcome = getWinningOutcome(market);
      const isWinner = winningOutcome === order.outcomeIndex;
      
      let pnl: number;
      let status: OrderStatus;
      
      if (isWinner) {
        pnl = order.potentialPayout - order.totalCost;
        status = "won";
        updatedBalance += order.potentialPayout;
      } else {
        pnl = -order.totalCost;
        status = "lost";
      }
      
      const resolvedOrder: PaperOrder = {
        ...order,
        status,
        resolvedAt: now.toISOString(),
        pnl,
        resolutionPrice: winningOutcome !== null ? 
          parseFloat(market.outcomePrices[winningOutcome]) : undefined,
      };
      
      resolved.push(resolvedOrder);
      updatedClosedOrders.push(resolvedOrder);
      updatedOpenOrders = updatedOpenOrders.filter(o => o.id !== order.id);
      totalPnl += pnl;
      
      // Persist resolution to DB
      dbUpdateOrder(resolvedOrder).catch(e => console.error("[Paper] DB update resolved failed:", e));
      
      // Atomically update balance in DB for won orders
      if (isWinner) {
        dbAddBalance(order.potentialPayout).catch(e => console.error("[Paper] DB add_balance (win) failed:", e));
      }

      // Activity log
      const timestamp = `[${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}]`;
      
      activities.push({
        timestamp,
        message: `RESOLVED "${order.marketQuestion.slice(0, 40)}..." → ${isWinner ? "WON" : "LOST"} ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`,
        entry_type: isWinner ? "Resolved" : "Warning",
      });
      
      console.log(`[Resolution] ${order.marketQuestion.slice(0, 50)} → ${status.toUpperCase()} (P&L: $${pnl.toFixed(2)})`);
    } catch (e) {
      console.error(`Error checking order ${order.id}:`, e);
    }
  }
  
  const updatedPortfolio: Portfolio = {
    ...portfolio,
    balance: updatedBalance,
    totalPnl,
    openOrders: updatedOpenOrders,
    closedOrders: updatedClosedOrders,
    lastUpdated: now.toISOString(),
  };
  
  if (resolved.length > 0 || updatedOpenOrders !== portfolio.openOrders) {
    savePortfolio(updatedPortfolio);
  }
  
  return { portfolio: updatedPortfolio, resolved, activities };
}

// ─── Auto Trading Functions ─────────────────────────────────────────

export interface AutoTradeConfig {
  enabled: boolean;
  maxBetSize: number;
  minEdge: number;
  maxOpenOrders: number;
  minVolume: number;
  minLiquidity: number;
}

export const defaultAutoTradeConfig: AutoTradeConfig = {
  enabled: true,
  maxBetSize: 10,
  minEdge: 0.05,
  maxOpenOrders: 10,
  minVolume: 5000,
  minLiquidity: 1000,
};

/**
 * Find edge in a market - simplified strategy
 * Returns the outcome index and edge if found, null otherwise
 */
export function findEdge(
  market: PolymarketMarket,
  config: AutoTradeConfig
): { outcomeIndex: number; edge: number; price: number } | null {
  const prices = market.outcomePrices.map(p => parseFloat(p));
  
  // Simple strategy: look for prices that seem mispriced
  // In reality, you'd use more sophisticated methods (ML, sentiment, etc.)
  
  for (let i = 0; i < prices.length; i++) {
    const price = prices[i];
    
    // Look for good value bets
    // Simple heuristic: if price is between 0.20 and 0.80, and volume is high
    if (price >= 0.15 && price <= 0.85) {
      // Calculate expected edge based on volume/liquidity ratio
      const vlRatio = market.liquidity / Math.max(market.volume, 1);
      
      // Simulate finding edge (in real scenario, this would be ML-based)
      const randomFactor = (Math.sin(Date.now() / 1000 + price * 100) + 1) / 2;
      const calculatedEdge = (0.02 + randomFactor * 0.15) * (0.5 + vlRatio);
      
      if (calculatedEdge >= config.minEdge) {
        return {
          outcomeIndex: i,
          edge: calculatedEdge,
          price,
        };
      }
    }
  }
  
  return null;
}

/**
 * Auto-place orders based on market analysis
 */
export async function autoPlaceOrders(
  markets: PolymarketMarket[],
  portfolio: Portfolio,
  config: AutoTradeConfig
): Promise<{
  portfolio: Portfolio;
  newOrders: PaperOrder[];
  activities: ActivityEntry[];
}> {
  if (!config.enabled) {
    return { portfolio, newOrders: [], activities: [] };
  }
  
  const newOrders: PaperOrder[] = [];
  const activities: ActivityEntry[] = [];
  let currentPortfolio = portfolio;
  
  // Filter markets
  const eligibleMarkets = markets.filter(m => 
    !m.resolved && 
    !m.closed && 
    m.volume >= config.minVolume &&
    m.liquidity >= config.minLiquidity &&
    // Check if we already have an order in this market
    !currentPortfolio.openOrders.some(o => o.conditionId === m.conditionId)
  );
  
  // Check max open orders
  if (currentPortfolio.openOrders.length >= config.maxOpenOrders) {
    return { portfolio: currentPortfolio, newOrders, activities };
  }
  
  // Find opportunities
  for (const market of eligibleMarkets) {
    if (currentPortfolio.openOrders.length >= config.maxOpenOrders) {
      break;
    }
    
    const opportunity = findEdge(market, config);
    
    if (opportunity) {
      // Calculate bet size (Kelly-inspired, but conservative)
      const betSize = Math.min(
        config.maxBetSize,
        currentPortfolio.balance * 0.1, // Max 10% of balance per bet
        opportunity.edge * currentPortfolio.balance * 2 // Edge-based sizing
      );
      
      if (betSize < 1) continue; // Minimum $1 bet
      
      // Calculate quantity
      const quantity = betSize / opportunity.price;
      
      // Create order
      const result = createPaperOrder(
        market,
        opportunity.outcomeIndex,
        "buy",
        quantity,
        currentPortfolio
      );
      
      if (result.order) {
        newOrders.push(result.order);
        currentPortfolio = result.portfolio;
        
        // Create activity entry
        const ts = new Date();
        const timestamp = `[${String(ts.getHours()).padStart(2, "0")}:${String(ts.getMinutes()).padStart(2, "0")}:${String(ts.getSeconds()).padStart(2, "0")}]`;
        
        activities.push({
          timestamp,
          message: `Edge: ${(opportunity.edge * 100).toFixed(1)}% on "${market.question.slice(0, 35)}..."`,
          entry_type: "Edge",
        });
        
        activities.push({
          timestamp,
          message: `ORDER $${result.order.totalCost.toFixed(2)} → "${market.outcomes[opportunity.outcomeIndex]}" @ ${(opportunity.price * 100).toFixed(1)}¢`,
          entry_type: "Order",
        });
      }
    }
  }
  
  return { portfolio: currentPortfolio, newOrders, activities };
}

// ─── Statistics Functions ─────────────────────────────────────────

export function calculateStats(portfolio: Portfolio): {
  wins: number;
  losses: number;
  winRate: number;
  avgBet: number;
  bestTrade: number;
  worstTrade: number;
  totalPnl: number;
  roi: number;
} {
  const resolvedOrders = portfolio.closedOrders.filter(
    o => o.status === "won" || o.status === "lost"
  );
  
  const wins = resolvedOrders.filter(o => o.status === "won").length;
  const losses = resolvedOrders.filter(o => o.status === "lost").length;
  const totalTrades = wins + losses;
  
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  
  const avgBet = totalTrades > 0 
    ? resolvedOrders.reduce((sum, o) => sum + o.totalCost, 0) / totalTrades 
    : 0;
  
  const pnls = resolvedOrders.map(o => o.pnl || 0);
  const bestTrade = pnls.length > 0 ? Math.max(...pnls) : 0;
  const worstTrade = pnls.length > 0 ? Math.min(...pnls) : 0;
  
  const totalPnl = pnls.reduce((sum, p) => sum + p, 0);
  const roi = portfolio.initialBalance > 0 
    ? (totalPnl / portfolio.initialBalance) * 100 
    : 0;
  
  return {
    wins,
    losses,
    winRate,
    avgBet,
    bestTrade,
    worstTrade,
    totalPnl,
    roi,
  };
}

// ─── History Functions ─────────────────────────────────────────

export function getOrderHistory(
  portfolio: Portfolio,
  limit: number = 50
): PaperOrder[] {
  return [...portfolio.closedOrders]
    .sort((a, b) => new Date(b.resolvedAt || b.createdAt).getTime() - 
                    new Date(a.resolvedAt || a.createdAt).getTime())
    .slice(0, limit);
}

export function getBalanceHistory(
  portfolio: Portfolio
): { timestamp: string; balance: number; label: string }[] {
  const history: { timestamp: string; balance: number; label: string }[] = [];
  
  // Start with initial balance
  let balance = portfolio.initialBalance;
  history.push({
    timestamp: "Start",
    balance,
    label: "Start",
  });
  
  // Reconstruct history from closed orders
  const sortedOrders = [...portfolio.closedOrders].sort(
    (a, b) => new Date(a.resolvedAt || a.createdAt).getTime() - 
              new Date(b.resolvedAt || b.createdAt).getTime()
  );
  
  for (const order of sortedOrders) {
    if (order.pnl !== undefined) {
      balance += order.pnl;
      const date = new Date(order.resolvedAt || order.createdAt);
      history.push({
        timestamp: `${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`,
        balance: Math.max(0, balance),
        label: order.status === "won" ? "W" : order.status === "lost" ? "L" : "C",
      });
    }
  }
  
  // Add current state
  history.push({
    timestamp: "Now",
    balance: portfolio.balance,
    label: "Now",
  });
  
  return history;
}
