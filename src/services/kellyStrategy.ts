/**
 * Kelly Criterion Strategy — Intelligent Bet Sizing
 * 
 * Implements fractional Kelly with:
 * - AI cost factoring (deducted from edge before sizing)
 * - Bankroll = AVAILABLE CASH (not total equity)
 * - MIN_BET_USD = $1 (Polymarket platform minimum)
 * - If bankroll < MIN_BET → skip AI entirely (no wasted tokens)
 * - Dynamic scan interval based on activity
 *
 * Philosophy: True Kelly — bankroll = your available cash right now.
 * As you place bets, your remaining cash shrinks and Kelly naturally
 * sizes subsequent bets smaller. When bets resolve and cash returns,
 * Kelly sizes larger again. No artificial "stop loss" needed.
 */

import { MarketAnalysis, KellyResult, AIUsage, PolymarketMarket } from "../types";
import { estimateAnalysisCost } from "./claudeAI";

// ─── Config ───────────────────────────────────────────

const KELLY_FRACTION = 0.50;          // Half-Kelly for balanced growth
const MAX_BET_FRACTION = 0.10;        // Never more than 10% of bankroll
const MIN_BET_USD = 1.00;             // Polymarket platform minimum order size ($1 USDC)
const MIN_EDGE_AFTER_COSTS = 0.06;    // 6% minimum net edge (after AI costs, before 8% gross)
const MIN_CONFIDENCE = 60;            // Skip below this confidence (matches prompt threshold)
const MIN_MARKET_PRICE = 0.02;        // Skip outcomes under 2¢ (lottery tickets — prompt tells AI to avoid <3¢)
const MAX_MARKET_PRICE = 0.98;        // Skip outcomes over 98¢ (no upside)
const MIN_RETURN_PCT = 0.03;          // Skip if expected return < 3% (avoids 0% return bets)
const DEFAULT_SCAN_SECS = 600;        // 10 minutes
const MIN_SCAN_SECS = 300;            // 5 minutes minimum
const MAX_SCAN_SECS = 900;            // 15 minutes maximum

function log(...args: unknown[]) {
  console.log("[Kelly]", ...args);
}

// ─── Core Kelly Math ─────────────────────────────────

/**
 * Standard Kelly Criterion for binary markets
 * 
 * In Polymarket:
 * - Buy YES at price P: win (1-P) if correct, lose P if wrong
 * - Buy NO  at price (1-P): win P if correct, lose (1-P) if wrong
 * 
 * Kelly: f* = (p*b - q) / b
 * where b = net odds = (1-P)/P for YES side
 *       p = true probability
 *       q = 1-p
 * 
 * Simplified for binary: f* = (pReal - pMarket) / (1 - pMarket)
 */
export function rawKellyFraction(pReal: number, pMarket: number): number {
  if (pMarket <= 0 || pMarket >= 1) return 0;
  if (pReal <= pMarket) return 0; // No edge

  const edge = pReal - pMarket;
  const f = edge / (1 - pMarket);
  return Math.max(0, f);
}

/**
 * Full Kelly calculation with cost adjustment and safety limits
 */
export function calculateKellyBet(
  analysis: MarketAnalysis,
  market: PolymarketMarket,
  bankroll: number,
  aiCostForThisBatch: number,
  marketsInBatch: number,
): KellyResult {
  // bankroll = available cash (true Kelly: always bet fraction of what you have NOW)
  const side = analysis.recommendedSide;

  // Default "don't bet" result
  const skipResult: KellyResult = {
    marketId: market.id,
    question: market.question,
    edge: 0,
    rawKelly: 0,
    fractionalKelly: 0,
    betAmount: 0,
    outcomeIndex: 0,
    outcomeName: "Yes",
    price: 0,
    expectedValue: 0,
    aiCostPerBet: aiCostForThisBatch / Math.max(1, marketsInBatch),
    confidence: analysis.confidence,
    reasoning: "SKIP",
  };

  // Skip conditions
  if (side === "SKIP") {
    skipResult.reasoning = "AI recommends SKIP";
    return skipResult;
  }
  if (bankroll < MIN_BET_USD) {
    skipResult.reasoning = `Bankroll $${bankroll.toFixed(2)} < mínimo Polymarket $${MIN_BET_USD}`;
    return skipResult;
  }
  if (analysis.confidence < MIN_CONFIDENCE) {
    skipResult.reasoning = `Confidence ${analysis.confidence} < minimum ${MIN_CONFIDENCE}`;
    return skipResult;
  }

  // Check market prices aren't extreme lottery tickets
  const checkPrices = market.outcomePrices.map(p => parseFloat(p));
  const targetPrice = side === "YES" ? (checkPrices[0] || 0.5) : (checkPrices[1] || 0.5);
  if (targetPrice < MIN_MARKET_PRICE) {
    skipResult.reasoning = `Precio ${(targetPrice * 100).toFixed(1)}¢ < mínimo ${(MIN_MARKET_PRICE * 100)}¢ (ticket de lotería)`;
    return skipResult;
  }
  if (targetPrice > MAX_MARKET_PRICE) {
    skipResult.reasoning = `Precio ${(targetPrice * 100).toFixed(1)}¢ > máximo ${(MAX_MARKET_PRICE * 100)}¢ (sin potencial)`;
    return skipResult;
  }

  // Determine which side to bet
  let pReal: number;
  let pMarket: number;
  let outcomeIndex: number;
  let outcomeName: string;

  const prices = market.outcomePrices.map(p => parseFloat(p));
  const yesPrice = prices[0] || 0.5;
  const noPrice = prices[1] || (1 - yesPrice);

  if (side === "YES") {
    // Claude reports pReal = P(YES). For YES bet we use it directly.
    pReal = analysis.pReal;
    pMarket = yesPrice;
    outcomeIndex = 0;
    outcomeName = market.outcomes[0] || "Yes";
  } else { // "NO"
    // Parser already guarantees pReal = P(YES), even if Claude confused convention.
    // For NO bet we simply convert: P(NO) = 1 - P(YES).
    pReal = 1 - analysis.pReal;
    pMarket = noPrice;
    outcomeIndex = 1;
    outcomeName = market.outcomes[1] || "No";
  }

  // Calculate raw edge
  const grossEdge = pReal - pMarket;

  // Factor in AI cost per bet
  const aiCostPerBet = aiCostForThisBatch / Math.max(1, marketsInBatch);

  // To compute net edge in equivalent terms, express AI cost as fraction of expected bet
  // We'll calculate the bet first with gross edge, then check if net edge is enough
  const rawKelly = rawKellyFraction(pReal, pMarket);
  const fractional = rawKelly * KELLY_FRACTION;
  
  // Apply limits
  const cappedFraction = Math.min(fractional, MAX_BET_FRACTION);
  let betAmount = bankroll * cappedFraction;

  // Must meet minimum
  if (betAmount < MIN_BET_USD) {
    skipResult.edge = grossEdge;
    skipResult.rawKelly = rawKelly;
    skipResult.reasoning = `Bet $${betAmount.toFixed(2)} < minimum $${MIN_BET_USD}`;
    return skipResult;
  }

  // Check net edge after AI costs
  const netEdge = grossEdge - (aiCostPerBet / betAmount);
  if (netEdge < MIN_EDGE_AFTER_COSTS) {
    skipResult.edge = grossEdge;
    skipResult.rawKelly = rawKelly;
    skipResult.reasoning = `Net edge ${(netEdge * 100).toFixed(1)}% < minimum ${(MIN_EDGE_AFTER_COSTS * 100).toFixed(1)}% after AI costs`;
    return skipResult;
  }

  // Check minimum return % — reject near-100¢ bets with negligible profit
  const expectedReturnPct = (1 - pMarket) / pMarket; // profit per dollar if correct
  if (expectedReturnPct < MIN_RETURN_PCT) {
    skipResult.edge = grossEdge;
    skipResult.rawKelly = rawKelly;
    skipResult.reasoning = `Expected return ${(expectedReturnPct * 100).toFixed(1)}% < minimum ${(MIN_RETURN_PCT * 100).toFixed(0)}% (price too close to $1)`;
    return skipResult;
  }

  // Safety: never more than 10% of bankroll
  betAmount = Math.min(betAmount, bankroll * MAX_BET_FRACTION);

  // Round to 2 decimals
  betAmount = Math.floor(betAmount * 100) / 100;

  // Calculate expected value
  const expectedWin = betAmount * ((1 - pMarket) / pMarket); // if correct
  const expectedValue = (pReal * expectedWin) - ((1 - pReal) * betAmount) - aiCostPerBet;

  log(`✅ ${outcomeName} @ ${(pMarket * 100).toFixed(1)}¢ → Kelly ${(rawKelly * 100).toFixed(1)}% × ${KELLY_FRACTION} = $${betAmount.toFixed(2)}, Edge: ${(grossEdge * 100).toFixed(1)}%, EV: $${expectedValue.toFixed(3)}`);

  return {
    marketId: market.id,
    question: market.question,
    edge: grossEdge,
    rawKelly,
    fractionalKelly: cappedFraction,
    betAmount,
    outcomeIndex,
    outcomeName,
    price: pMarket,
    expectedValue,
    aiCostPerBet,
    confidence: analysis.confidence,
    reasoning: `Edge ${(grossEdge * 100).toFixed(1)}% | Kelly ${(cappedFraction * 100).toFixed(1)}% | EV $${expectedValue.toFixed(3)}`,
  };
}

// ─── Bankroll Safety Check ───────────────────────────

export function canTrade(bankroll: number): boolean {
  // Only real limit: can you place at least 1 minimum bet on Polymarket?
  // Kelly handles sizing — no artificial stop loss needed.
  return bankroll >= MIN_BET_USD;
}

export function getBankrollStatus(bankroll: number): string {
  if (bankroll <= 0) return "💀 ELIMINADO — bankroll a $0";
  if (bankroll < MIN_BET_USD) return `🛑 STOP — bankroll $${bankroll.toFixed(2)} < mínimo Polymarket $${MIN_BET_USD} (no se llamará a IA)`;
  if (bankroll < 10) return `⚠️ BAJO — bankroll: $${bankroll.toFixed(2)} (Kelly ajustará apuestas proporcionalmente)`;
  if (bankroll < 25) return `🟡 PRECAUCIÓN — bankroll: $${bankroll.toFixed(2)}`;
  return `🟢 OK — bankroll: $${bankroll.toFixed(2)}`;
}

// ─── Dynamic Scan Interval ───────────────────────────

/**
 * Adjust scan interval based on:
 * - Bankroll level (lower → slower to preserve)
 * - Recent activity (many bets → slow down)
 * - Number of eligible markets (more markets → scan more often)
 */
export function calculateScanInterval(
  bankroll: number,
  recentBetsCount: number,
  eligibleMarkets: number,
): number {
  let interval = DEFAULT_SCAN_SECS;

  // If bankroll is low, scan less frequently (preserve capital)
  if (bankroll < 25) {
    interval = MAX_SCAN_SECS; // 15 min
  } else if (bankroll < 50) {
    interval = 720; // 12 min
  }

  // If we've been placing many bets, slow down
  if (recentBetsCount > 5) {
    interval = Math.min(interval + 120, MAX_SCAN_SECS);
  }

  // If there are many eligible markets, scan a bit more often
  if (eligibleMarkets > 10) {
    interval = Math.max(interval - 60, MIN_SCAN_SECS);
  }

  return Math.max(MIN_SCAN_SECS, Math.min(MAX_SCAN_SECS, interval));
}

// ─── Cost-Awareness Helper ───────────────────────────

/**
 * Check if it's worth spending on AI analysis given current bankroll
 * Returns false if AI costs would eat too much of the bankroll
 */
export function shouldAnalyze(
  bankroll: number,
  marketCount: number,
  model?: string,
): boolean {
  if (!canTrade(bankroll)) return false;
  
  const estimatedCost = estimateAnalysisCost(marketCount, model);
  
  // Don't spend more than 5% of bankroll on total analysis cost (deep analysis across all batches)
  if (estimatedCost > bankroll * 0.05) {
    log(`Analysis cost $${estimatedCost.toFixed(4)} > 5% of bankroll $${bankroll.toFixed(2)} — skipping`);
    return false;
  }

  return true;
}

// ─── Constants Export ────────────────────────────────

export const KELLY_CONFIG = {
  KELLY_FRACTION,
  MAX_BET_FRACTION,
  MIN_BET_USD,
  MIN_EDGE_AFTER_COSTS,
  MIN_CONFIDENCE,
  MIN_MARKET_PRICE,
  MAX_MARKET_PRICE,
  DEFAULT_SCAN_SECS,
  MIN_SCAN_SECS,
  MAX_SCAN_SECS,
};
