/**
 * Smart Trader — Flow:
 *   1. Pre-filter: find markets expiring within 1 hour (≤1h pool)
 *   2. Exclude junk/noise, open orders from pool
 *   3. Send ≤1h pool to Claude for OSINT analysis (cheap: ~30-50 markets)
 *   4. Claude returns recommendations with exact marketIds
 *   5. Kelly Criterion sizes each bet using real market prices
 *   6. Place orders
 *   7. Repeat every ~10 minutes
 */

import {
  PolymarketMarket,
  Portfolio,
  ActivityEntry,
  SmartCycleResult,
  KellyResult,
  MarketAnalysis,
} from "../types";
import { analyzeMarketsWithClaude, loadCostTracker, formatCost, ClaudeResearchResult, PerformanceHistory } from "./claudeAI";
// loadCostTracker is now async (DB-only)
import { calculateKellyBet, canTrade, getBankrollStatus, shouldAnalyze } from "./kellyStrategy";
import { createPaperOrder } from "./paperTrading";
import { dbSaveCycleLog, dbUpdateOrder, dbGetStats } from "./db";

// ─── Config ───────────────────────────────────────────

let _maxExpiryMs = 24 * 60 * 60 * 1000;  // Default: 24 hours (configurable)
const SCAN_INTERVAL_SECS = 600;          // 10 minutes between cycles

// Minimum liquidity and volume to be worth analyzing (filter BEFORE Claude)
// With $10 bankroll and $1 max bets, even low-liq markets are tradeable.
const MIN_LIQUIDITY = 500;     // $500 — sufficient depth for $1 limit orders
const MIN_VOLUME = 1_000;      // $1K — ensures market has some activity

// Time throttle: enforce minimum 10 minutes between Claude API calls.
// Markets are re-analyzed each cycle because prices/conditions change constantly.
// ALL state persisted in sessionStorage to survive Vite HMR reloads.
let _lastClaudeCallTime = Number(sessionStorage.getItem('_smartTrader_lastClaudeCall') || '0');
const MIN_CLAUDE_INTERVAL_MS = 10 * 60 * 1000;    // HARD minimum: 10 minutes between Claude calls

/** Persist throttle timestamp to sessionStorage (survives HMR, cleared on tab close) */
function _persistThrottleState() {
  try {
    sessionStorage.setItem('_smartTrader_lastClaudeCall', String(_lastClaudeCallTime));
  } catch { /* sessionStorage full or unavailable — ignore */ }
}

// ─── Recently-analyzed cache: avoid re-sending same markets to Claude ──
// Maps marketId → timestamp when last sent. Markets with recent analysis are excluded
// from the pool unless enough time has passed (ANALYZED_CACHE_TTL).
const ANALYZED_CACHE_KEY = '_smartTrader_analyzedMap';
const ANALYZED_CACHE_TTL_MS = 30 * 60 * 1000; // 30 min — don't re-analyze within this window

function _loadAnalyzedMap(): Map<string, number> {
  try {
    const raw = sessionStorage.getItem(ANALYZED_CACHE_KEY);
    if (!raw) return new Map();
    const entries: [string, number][] = JSON.parse(raw);
    const now = Date.now();
    // Filter out expired entries
    return new Map(entries.filter(([, ts]) => (now - ts) < ANALYZED_CACHE_TTL_MS));
  } catch { return new Map(); }
}

function _saveAnalyzedMap(map: Map<string, number>) {
  try {
    sessionStorage.setItem(ANALYZED_CACHE_KEY, JSON.stringify([...map.entries()]));
  } catch { /* ignore */ }
}

function _markAnalyzed(marketIds: string[]) {
  const map = _loadAnalyzedMap();
  const now = Date.now();
  for (const id of marketIds) map.set(id, now);
  _saveAnalyzedMap(map);
}

/**
 * Cycle lock — prevents concurrent cycles (React StrictMode, double-triggers, HMR).
 * PERSISTED in sessionStorage with a TTL (max 3 min) to survive HMR but auto-expire
 * if the tab crashed or the cycle hung.
 */
const CYCLE_LOCK_KEY = '_smartTrader_cycleLock';
const CYCLE_LOCK_MAX_MS = 3 * 60 * 1000; // Lock expires after 3 min max

function _isCycleLocked(): boolean {
  try {
    const raw = sessionStorage.getItem(CYCLE_LOCK_KEY);
    if (!raw) return false;
    const lockTime = Number(raw);
    if (isNaN(lockTime)) return false;
    // Lock is valid if < CYCLE_LOCK_MAX_MS old
    return (Date.now() - lockTime) < CYCLE_LOCK_MAX_MS;
  } catch { return false; }
}

function _setCycleLock() {
  try { sessionStorage.setItem(CYCLE_LOCK_KEY, String(Date.now())); } catch {}
}

function _clearCycleLock() {
  try { sessionStorage.removeItem(CYCLE_LOCK_KEY); } catch {}
}

let _cycleRunning = false;

/** Called from App.tsx when config changes */
export function setMaxExpiry(hours: number) {
  const h = (hours && !isNaN(hours) && hours > 0) ? hours : 24;
  _maxExpiryMs = h * 60 * 60 * 1000;
  log(`⏰ Max expiry actualizado: ${h}h (${_maxExpiryMs}ms)`);
}

function log(...args: unknown[]) {
  console.log("[SmartTrader]", ...args);
}

function activity(msg: string, type: ActivityEntry["entry_type"] = "Info"): ActivityEntry {
  return { timestamp: new Date().toISOString(), message: msg, entry_type: type };
}

// ─── Debug log store for Console Panel ───────────────

export interface RecommendationResult {
  marketId: string;
  question: string;
  recommendedSide: string;
  pMarket: number;
  pReal: number;
  edge: number;
  confidence: number;
  reasoning: string;
  sources: string[];
  // Kelly
  kellyResult?: KellyResult;
  decision: string;             // "BET $X.XX" | "SKIP — reason"
}

export interface CycleDebugLog {
  timestamp: string;
  // Market pool
  totalMarkets: number;
  poolBreakdown: {
    total: number;
    noEndDate: number;
    expired: number;
    resolved: number;
    tooFarOut: number;
    junk: number;
    sports: number;         // excluded sports (0 if included via progressive relaxation)
    crypto: number;         // excluded crypto/finance
    stocks: number;         // excluded stocks/indices
    duplicateOpen: number;
    lowLiquidity: number;
    passed: number;
    filterLevel: number;    // 0=strict, 1=+sports, 2=+crypto, 3=+stocks
    filterLabel: string;    // Human label: "Estricto", "+Deportes", etc.
  };
  shortTermList: { question: string; endDate: string; volume: number; yesPrice: number }[];
  // AI
  prompt: string;
  rawResponse: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  responseTimeMs: number;
  summary: string;
  // Results
  recommendations: number;
  results: RecommendationResult[];
  betsPlaced: number;
  nextScanSecs: number;
  error?: string;
}

const _cycleLogs: CycleDebugLog[] = [];
export function getCycleLogs(): CycleDebugLog[] { return _cycleLogs; }
export function clearCycleLogs(): void { _cycleLogs.length = 0; }

/** Hydrate in-memory cycle logs from Supabase (call once on mount) */
let _hydrated = false;
export async function hydrateCycleLogs(): Promise<void> {
  if (_hydrated) return;
  _hydrated = true;
  try {
    const { dbGetCycleLogs } = await import("./db");
    const saved = await dbGetCycleLogs(20);
    if (saved.length > 0 && _cycleLogs.length === 0) {
      _cycleLogs.push(...saved);
      console.log(`[SmartTrader] Hydrated ${saved.length} cycle logs from DB`);
    }
  } catch (e) {
    console.error("[SmartTrader] Failed to hydrate cycle logs:", e);
  }
}

/** Reset throttle state — called on portfolio reset to allow fresh start */
export function clearAnalyzedCache(): void {
  _lastClaudeCallTime = 0;
  _persistThrottleState();
  _clearCycleLock();
  _cycleRunning = false;
  sessionStorage.removeItem('_smartTrader_analyzedIds'); // cleanup legacy key
  sessionStorage.removeItem(ANALYZED_CACHE_KEY); // clear recently-analyzed cache
  log("🧹 Throttle de IA reseteado + cycle lock + cache analizados limpiado");
}

// ─── Cluster dedup: detect correlated/overlapping markets ────────

/**
 * Detects correlated markets and keeps only the best (highest abs edge) per cluster.
 * 
 * Two markets are correlated if:
 * 1. Claude gave them the same clusterId, OR
 * 2. Their questions share the same "base subject" but differ only in a number/threshold
 *    (e.g., "Seoul temp 8°C" and "Seoul temp 9°C", or "GDP above 3%" vs "GDP above 2%")
 * 
 * Also groups markets with open positions to avoid doubling down on same subject.
 */
function deduplicateCorrelatedMarkets(analyses: MarketAnalysis[]): MarketAnalysis[] {
  if (analyses.length <= 1) return analyses;

  // Step 1: Build cluster map
  const clusterMap = new Map<string, MarketAnalysis[]>();

  for (const a of analyses) {
    // Try Claude's clusterId first
    let key = a.clusterId || "";

    // If no clusterId, compute a text-based cluster key
    if (!key) {
      key = computeClusterKey(a.question);
    }

    if (!key) {
      // No cluster detected — unique market
      key = `__unique_${a.marketId}`;
    }

    const group = clusterMap.get(key) || [];
    group.push(a);
    clusterMap.set(key, group);
  }

  // Step 2: Pick best from each cluster (highest absolute edge)
  const result: MarketAnalysis[] = [];
  for (const [_key, group] of clusterMap) {
    if (group.length === 1) {
      result.push(group[0]);
    } else {
      // Sort by abs(edge) desc, then confidence desc
      group.sort((a, b) => {
        const edgeDiff = Math.abs(b.edge) - Math.abs(a.edge);
        if (Math.abs(edgeDiff) > 0.005) return edgeDiff;
        return b.confidence - a.confidence;
      });
      result.push(group[0]);
      log(`  🔗 Cluster "${_key}": ${group.length} mercados → picked "${group[0].question.slice(0, 50)}" (edge ${(group[0].edge * 100).toFixed(1)}%)`);
    }
  }

  return result;
}

/**
 * Extract a "cluster key" from a question by removing numbers/thresholds.
 * Examples:
 *   "highest temperature in Seoul be 8°C" → "highest temperature in seoul be °c"
 *   "highest temperature in Seoul be 9°C or higher" → "highest temperature in seoul be °c or higher"
 *   "GDP growth above 3%?" → "gdp growth above %?"
 *   "Bitcoin above $50,000?" → "bitcoin above $?"
 */
function computeClusterKey(question: string): string {
  let q = question.toLowerCase().trim();

  // Remove specific numbers but keep the structure
  // Replace digits (including decimals, negatives, commas) with a placeholder
  q = q.replace(/[-+]?\d[\d,]*\.?\d*/g, "#");

  // Normalize whitespace
  q = q.replace(/\s+/g, " ");

  // Remove very short results (too generic)
  if (q.length < 15) return "";

  return q;
}

// ─── Pre-filter: markets expiring ≤maxExpiry — PROGRESSIVE ─────

/** Minimum pool size before we start relaxing content filters */
const MIN_POOL_TARGET = 15;

const FILTER_LEVEL_LABELS = ["Estricto", "+Deportes", "+Deportes+Crypto", "Todo (sin junk)"];

/** Max batches per cycle — if 0 bets placed, try next batch immediately */
const MAX_BATCHES_PER_CYCLE = 3;

// ─── Category classifier for pool diversification ─────
const weatherPatterns = /temperature|°[cf]|weather|rain|snow|hurricane|tornado|wind speed|heat wave|cold|frost|humidity|celsius|fahrenheit|forecast|precipitation|storm|flood|drought|wildfire|nws|noaa/;
const politicsPatterns = /trump|biden|harris|congress|senate|house of rep|election|vote|poll|president|governor|democrat|republican|gop|legislation|bill sign|executive order|supreme court|scotus|impeach|primary|caucus|cabinet|veto|filibuster/;
const geopoliticsPatterns = /war|military|invasion|nato|united nations|\bun\b|sanction|tariff|trade war|ceasefire|peace deal|treaty|summit|nuclear|missile|refugee|occupation|annexation/;
const entertainmentPatterns = /oscar|grammy|emmy|movie|film|box office|album|song|concert|tv show|series|streaming|netflix|disney|spotify|billboard|ratings|premiere|celebrity|award/;

function classifyMarketCategory(question: string): string {
  const q = question.toLowerCase();
  if (sportsPatterns.some(p => q.includes(p))) return 'sports';
  if (cryptoPatterns.some(p => q.includes(p))) return 'crypto';
  if (stockPatterns.some(p => q.includes(p))) return 'finance';
  if (weatherPatterns.test(q)) return 'weather';
  if (politicsPatterns.test(q)) return 'politics';
  if (geopoliticsPatterns.test(q)) return 'geopolitics';
  if (entertainmentPatterns.test(q)) return 'entertainment';
  return 'other';
}

/**
 * Pick up to `maxSize` markets from `markets`, interleaving categories via round-robin.
 * Within each category, markets are sorted by volume (best first).
 * This ensures the batch sent to Claude has diverse topics.
 */
function diversifyPool(markets: PolymarketMarket[], maxSize: number): PolymarketMarket[] {
  const buckets = new Map<string, PolymarketMarket[]>();
  for (const m of markets) {
    const cat = classifyMarketCategory(m.question);
    if (!buckets.has(cat)) buckets.set(cat, []);
    buckets.get(cat)!.push(m);
  }
  // Sort each bucket by volume descending
  for (const [, arr] of buckets) arr.sort((a, b) => b.volume - a.volume);

  const result: PolymarketMarket[] = [];
  const categories = [...buckets.keys()];
  let round = 0;

  while (result.length < maxSize) {
    let added = false;
    for (const cat of categories) {
      const arr = buckets.get(cat)!;
      if (round < arr.length) {
        result.push(arr[round]);
        added = true;
        if (result.length >= maxSize) break;
      }
    }
    if (!added) break;
    round++;
  }
  return result;
}

/** Sports / betting patterns */
const sportsPatterns = [
  "nba", "nfl", "mlb", "nhl", "soccer", "football", "basketball", "baseball",
  "hockey", "tennis", "golf", "f1", "formula 1", "ufc", "mma", "boxing",
  "premier league", "la liga", "serie a", "bundesliga", "champions league",
  "world cup", "copa america", "euros 2024", "super bowl", "playoffs",
  "grand slam", "wimbledon", "us open", "french open", "australian open",
  "win the", "win against", "beat the", "defeat", "clinch",
  "mvp", "ballon d'or", "touchdown", "home run", "goal scored",
  "match", "game 1", "game 2", "game 3", "game 4", "game 5", "game 6", "game 7",
  "eredivisie", "ligue 1", "serie b", "mls",
  "wnba", "ncaa", "college football", "march madness",
  "atp", "wta", "pga", "lpga", "nascar", "indycar",
];

/** Crypto / DeFi patterns */
const cryptoPatterns = [
  "bitcoin", "btc", "ethereum", "eth", "solana", "sol", "dogecoin", "doge",
  "crypto", "cryptocurrency", "blockchain", "defi", "nft",
  "token", "altcoin", "memecoin", "meme coin",
  "binance", "coinbase", "kraken",
  "market cap", "trading volume", "ath", "all-time high",
  "halving", "staking", "mining",
  "xrp", "ripple", "cardano", "ada", "polkadot", "dot",
  "avax", "avalanche", "matic", "polygon",
];

/** Traditional finance / stock market patterns */
const stockPatterns = [
  "stock", "stocks", "s&p 500", "s&p500", "nasdaq", "dow jones",
  "nyse", "share price", "stock price", "market cap",
  "ipo", "earnings", "quarterly report", "revenue",
  "fed", "federal reserve", "interest rate", "rate cut", "rate hike",
  "inflation", "cpi", "gdp", "unemployment rate",
  "treasury", "bond", "yield", "forex",
  "oil price", "gold price", "silver price", "commodity",
  "bull market", "bear market", "recession",
  "tesla stock", "apple stock", "nvidia",
];

function buildShortTermPool(
  allMarkets: PolymarketMarket[],
  openOrderMarketIds: Set<string>,
  now: number,
): { pool: PolymarketMarket[]; breakdown: CycleDebugLog["poolBreakdown"] } {
  const bd: CycleDebugLog["poolBreakdown"] = {
    total: allMarkets.length,
    noEndDate: 0,
    expired: 0,
    resolved: 0,
    tooFarOut: 0,
    junk: 0,
    sports: 0,
    crypto: 0,
    stocks: 0,
    duplicateOpen: 0,
    lowLiquidity: 0,
    passed: 0,
    filterLevel: 0,
    filterLabel: FILTER_LEVEL_LABELS[0],
  };

  // ── Phase 1: Apply base filters (always enforced) ──
  // Separate markets into: clean, sports, crypto, stocks (all passing base filters)
  const clean: PolymarketMarket[] = [];
  const sportsBucket: PolymarketMarket[] = [];
  const cryptoBucket: PolymarketMarket[] = [];
  const stocksBucket: PolymarketMarket[] = [];

  for (const m of allMarkets) {
    if (!m.endDate) { bd.noEndDate++; continue; }

    const endTime = new Date(m.endDate).getTime();
    const timeLeft = endTime - now;

    if (timeLeft <= 0) { bd.expired++; continue; }
    if (m.resolved || !m.active) { bd.resolved++; continue; }
    if (timeLeft > _maxExpiryMs) { bd.tooFarOut++; continue; }

    // ═══ AUTO-REJECT ULTRA NEAR EXPIRY (≤5 min) ═══
    // These almost always end up rejected and waste Claude tokens
    if (timeLeft <= 5 * 60 * 1000) { bd.expired++; continue; }

    // ═══ HARD LIQUIDITY/VOLUME FILTER ═══
    if (m.liquidity < MIN_LIQUIDITY || m.volume < MIN_VOLUME) {
      bd.lowLiquidity++;
      continue;
    }

    // ═══ DE FACTO RESOLVED — prices at extremes, no tradeable edge ═══
    // Skip markets where YES price is ≤2¢ or ≥98¢ — these waste Claude tokens
    const yp = parseFloat(m.outcomePrices[0] || "0.5");
    if (yp <= 0.02 || yp >= 0.98) {
      bd.junk++; // count as junk since they're untradeable
      continue;
    }

    const q = m.question.toLowerCase();

    // ─── Junk / noise (ALWAYS excluded, no progressive) ───
    const junkPatterns = [
      "tweet", "tweets", "post on x", "post on twitter", "retweet",
      "how many", "number of", "followers", "subscribers",
      "elon musk", "musk post", "musk tweet",
      "tiktok", "instagram", "youtube video", "viral",
      "# of ", "#1 free app", "app store", "play store",
      "chatgpt", "most streamed", "most viewed",
      "spelling bee", "wordle", "jeopardy", "wheel of fortune",
    ];
    if (junkPatterns.some(j => q.includes(j))) { bd.junk++; continue; }

    // ─── Skip if already have open order ───
    if (openOrderMarketIds.has(m.id)) { bd.duplicateOpen++; continue; }

    // ─── Classify into content buckets ───
    if (sportsPatterns.some(p => q.includes(p))) {
      sportsBucket.push(m);
    } else if (cryptoPatterns.some(p => q.includes(p))) {
      cryptoBucket.push(m);
    } else if (stockPatterns.some(p => q.includes(p))) {
      stocksBucket.push(m);
    } else {
      clean.push(m);
    }
  }

  // Initialize counts as "excluded"
  bd.sports = sportsBucket.length;
  bd.crypto = cryptoBucket.length;
  bd.stocks = stocksBucket.length;

  // ── Phase 2: Progressive relaxation ──
  // Start strict, add categories until pool >= MIN_POOL_TARGET
  const pool = [...clean];
  let level = 0;

  if (pool.length < MIN_POOL_TARGET && sportsBucket.length > 0) {
    pool.push(...sportsBucket);
    bd.sports = 0;   // no longer excluded
    level = 1;
    log(`  📈 Filtro progresivo → Nivel 1: +${sportsBucket.length} deportes (pool era ${clean.length})`);
  }

  if (pool.length < MIN_POOL_TARGET && cryptoBucket.length > 0) {
    pool.push(...cryptoBucket);
    bd.crypto = 0;
    level = 2;
    log(`  📈 Filtro progresivo → Nivel 2: +${cryptoBucket.length} crypto (pool era ${pool.length - cryptoBucket.length})`);
  }

  if (pool.length < MIN_POOL_TARGET && stocksBucket.length > 0) {
    pool.push(...stocksBucket);
    bd.stocks = 0;
    level = 3;
    log(`  📈 Filtro progresivo → Nivel 3: +${stocksBucket.length} stocks/finance (pool era ${pool.length - stocksBucket.length})`);
  }

  bd.filterLevel = level;
  bd.filterLabel = FILTER_LEVEL_LABELS[level] || "???";
  bd.passed = pool.length;

  // Sort by volume descending for better analysis
  pool.sort((a, b) => b.volume - a.volume);

  return { pool, breakdown: bd };
}

// ─── Main Cycle ──────────────────────────────────────

export async function runSmartCycle(
  portfolio: Portfolio,
  allMarkets: PolymarketMarket[],
  claudeModel?: string,
): Promise<SmartCycleResult> {
  // ─── Cycle Lock: prevent concurrent execution ─────
  // Check BOTH in-memory flag AND sessionStorage (survives HMR)
  if (_cycleRunning || _isCycleLocked()) {
    log("⚠️ Ciclo ya en ejecución — ignorando llamada duplicada (lock activo)");
    return {
      portfolio, betsPlaced: [], marketsAnalyzed: 0, marketsEligible: 0,
      aiUsage: null, nextScanSeconds: SCAN_INTERVAL_SECS, activities: [],
      skippedReason: "Cycle already running (duplicate call blocked)",
    };
  }
  _cycleRunning = true;
  _setCycleLock();

  try {
    return await _runSmartCycleInner(portfolio, allMarkets, claudeModel);
  } finally {
    _cycleRunning = false;
    _clearCycleLock();
  }
}

async function _runSmartCycleInner(
  portfolio: Portfolio,
  allMarkets: PolymarketMarket[],
  claudeModel?: string,
): Promise<SmartCycleResult> {
  const activities: ActivityEntry[] = [];
  const betsPlaced: KellyResult[] = [];
  let updatedPortfolio = { ...portfolio };
  const now = Date.now();

  // Debug: log throttle state
  const secsSinceLastClaude = _lastClaudeCallTime > 0 ? Math.round((now - _lastClaudeCallTime) / 1000) : -1;
  log(`🔒 Throttle: Última llamada Claude: ${secsSinceLastClaude === -1 ? 'nunca' : `hace ${secsSinceLastClaude}s`} (mín 600s)`);

  // ─── Step 0: Bankroll Check ──────────────────
  // Use free cash for canTrade — need at least $1 to place any bet
  if (!canTrade(portfolio.balance)) {
    const status = getBankrollStatus(portfolio.balance);
    log(status);
    return {
      portfolio: updatedPortfolio, betsPlaced: [], marketsAnalyzed: 0, marketsEligible: 0,
      aiUsage: null, nextScanSeconds: 900,
      activities: [activity(status, "Warning")],
      skippedReason: status,
    };
  }

  // ─── Step 0.5: Time throttle — check FIRST before any heavy work ─────
  // If throttle hasn't expired, skip the entire cycle silently.
  // This avoids wasting CPU on pool building/filtering just to be blocked.
  {
    const freshNow = Date.now();
    const timeSinceLastClaude = freshNow - _lastClaudeCallTime;
    if (_lastClaudeCallTime > 0 && timeSinceLastClaude < MIN_CLAUDE_INTERVAL_MS) {
      const secsLeft = Math.ceil((MIN_CLAUDE_INTERVAL_MS - timeSinceLastClaude) / 1000);
      const msg = `⏳ Throttle activo — próximo análisis en ${Math.ceil(secsLeft / 60)}min ${secsLeft % 60}s`;
      log(msg);
      // Don't save to cycle logs or show as error — just schedule next attempt
      return {
        portfolio: updatedPortfolio, betsPlaced: [], marketsAnalyzed: 0,
        marketsEligible: 0, aiUsage: null, nextScanSeconds: Math.max(secsLeft + 5, 60),
        activities: [activity(msg, "Info")],
        skippedReason: msg,
      };
    }
  }

  // ─── Past throttle gate — heavy work starts here ─────
  const costTracker = await loadCostTracker();

  // Init debug log
  const debugLog: CycleDebugLog = {
    timestamp: new Date().toISOString(),
    totalMarkets: allMarkets.length,
    poolBreakdown: { total: 0, noEndDate: 0, expired: 0, resolved: 0, tooFarOut: 0, junk: 0, sports: 0, crypto: 0, stocks: 0, duplicateOpen: 0, lowLiquidity: 0, passed: 0, filterLevel: 0, filterLabel: "Estricto" },
    shortTermList: [],
    prompt: "",
    rawResponse: "",
    model: claudeModel || "claude-sonnet-4-20250514",
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    responseTimeMs: 0,
    summary: "",
    recommendations: 0,
    results: [],
    betsPlaced: 0,
    nextScanSecs: SCAN_INTERVAL_SECS,
  };

  log("═══════════════════════════════════════════════");
  log("🔬 OSINT Research Cycle Starting");
  log(`💰 Bankroll: $${portfolio.balance.toFixed(2)}`);
  log(`📊 Total markets: ${allMarkets.length}`);

  activities.push(activity(`🔬 Ciclo OSINT — Bankroll: $${portfolio.balance.toFixed(2)}`, "Info"));

  // ─── Step 1: Build short-term pool (progressive filters) ──
  const openOrderIds = new Set(portfolio.openOrders.map(o => o.marketId));
  const { pool, breakdown } = buildShortTermPool(allMarkets, openOrderIds, now);
  debugLog.poolBreakdown = breakdown;

  // Store list for Console Panel
  debugLog.shortTermList = pool.map(m => ({
    question: m.question,
    endDate: m.endDate,
    volume: m.volume,
    yesPrice: parseFloat(m.outcomePrices[0] || "0.5"),
  }));

  // ─── Step 1.5: LOCAL cluster dedup (pre-Claude) ──
  // Group by computeClusterKey() and keep only the best (highest volume) per cluster.
  // This collapses e.g. 10 "Seoul temp X°C" → 1.
  const clusterGroups = new Map<string, PolymarketMarket[]>();
  for (const m of pool) {
    const key = computeClusterKey(m.question) || `__unique_${m.id}`;
    const group = clusterGroups.get(key) || [];
    group.push(m);
    clusterGroups.set(key, group);
  }
  const dedupedPool: PolymarketMarket[] = [];
  let clustersCollapsed = 0;
  for (const [_key, group] of clusterGroups) {
    // Pick the one with highest volume
    group.sort((a, b) => b.volume - a.volume);
    dedupedPool.push(group[0]);
    if (group.length > 1) {
      clustersCollapsed += group.length - 1;
      log(`  🔗 Cluster pre-dedup "${_key.slice(0, 50)}": ${group.length} → 1 (kept vol=$${group[0].volume.toLocaleString()})`);
    }
  }
  // Replace pool contents with deduped version
  pool.length = 0;
  pool.push(...dedupedPool);

  const expiryLabel = _maxExpiryMs >= 86400000 ? `≤${(_maxExpiryMs / 86400000).toFixed(_maxExpiryMs % 86400000 === 0 ? 0 : 1)}d` : `≤${_maxExpiryMs / 3600000}h`;
  log(`⏱️ Pool ${expiryLabel}: ${pool.length} mercados (de ${allMarkets.length}, ${clustersCollapsed} cluster-dupes eliminados) — Filtro: ${breakdown.filterLabel}`);
  log(`   Filtrado: ${breakdown.tooFarOut} fuera ventana, ${breakdown.junk} junk, ${breakdown.sports} deportes excl, ${breakdown.crypto} crypto excl, ${breakdown.stocks} stocks excl, ${breakdown.lowLiquidity} baja liq, ${breakdown.duplicateOpen} ya abiertos`);

  activities.push(activity(
    `⏱️ Pool ${expiryLabel}: ${pool.length} mercados [${breakdown.filterLabel}] (${breakdown.junk} junk, ${breakdown.sports} dep, ${breakdown.crypto} crypto, ${breakdown.lowLiquidity} baja liq, ${clustersCollapsed} cluster-dupes)`,
    "Market"
  ));

  if (pool.length === 0) {
    const msg = `No hay mercados que venzan en ${expiryLabel}. Esperando...`;
    log(`⏳ ${msg}`);
    activities.push(activity(`⏳ ${msg}`, "Info"));
    debugLog.error = msg;
    _cycleLogs.unshift(debugLog);
    if (_cycleLogs.length > 20) _cycleLogs.length = 20;
    dbSaveCycleLog(debugLog).catch(e => console.error("[SmartTrader] DB cycle log save failed:", e));
    return {
      portfolio: updatedPortfolio, betsPlaced: [], marketsAnalyzed: 0, marketsEligible: 0,
      aiUsage: null, nextScanSeconds: SCAN_INTERVAL_SECS, activities,
      skippedReason: msg,
    };
  }

  // ─── Step 1.8: Exclude recently-analyzed markets ──
  const analyzedMap = _loadAnalyzedMap();
  const beforeDedup = pool.length;
  const freshPool = pool.filter(m => !analyzedMap.has(m.id));
  const analyzedSkipped = beforeDedup - freshPool.length;
  if (analyzedSkipped > 0) {
    log(`🔄 ${analyzedSkipped} mercados ya analizados en últimos 30min — excluidos del pool`);
    pool.length = 0;
    pool.push(...freshPool);
  }

  if (pool.length === 0 && analyzedSkipped > 0) {
    const msg = `📋 Todos los ${analyzedSkipped} mercados ya fueron analizados en los últimos 30min. Esperando mercados nuevos...`;
    log(msg);
    activities.push(activity(msg, "Info"));
    debugLog.error = msg;
    _cycleLogs.unshift(debugLog);
    if (_cycleLogs.length > 20) _cycleLogs.length = 20;
    dbSaveCycleLog(debugLog).catch(e => console.error("[SmartTrader] DB cycle log save failed:", e));
    return {
      portfolio: updatedPortfolio, betsPlaced: [], marketsAnalyzed: 0, marketsEligible: 0,
      aiUsage: null, nextScanSeconds: SCAN_INTERVAL_SECS, activities,
      skippedReason: msg,
    };
  }

  // ─── Step 2: Build category-diverse batches ─────────
  // Instead of sending top-30-by-volume (which may all be one category),
  // interleave categories so Claude sees weather + politics + sports + etc.
  const MAX_POOL_FOR_ANALYSIS = 30;
  const fullPool = [...pool]; // keep reference to full pool for market lookup
  const diversified = diversifyPool(pool, pool.length); // reorder, don't truncate yet

  // Split into batches of MAX_POOL_FOR_ANALYSIS
  const batches: PolymarketMarket[][] = [];
  for (let i = 0; i < diversified.length; i += MAX_POOL_FOR_ANALYSIS) {
    batches.push(diversified.slice(i, i + MAX_POOL_FOR_ANALYSIS));
  }
  // Cap total batches per cycle
  if (batches.length > MAX_BATCHES_PER_CYCLE) batches.length = MAX_BATCHES_PER_CYCLE;

  log(`📦 Pool dividido en ${batches.length} batch(es) de ≤${MAX_POOL_FOR_ANALYSIS} mercados (diversificado por categoría)`);

  // shouldAnalyze uses equity so AI cost check is proportional to total portfolio
  const equityForAnalysis = portfolio.balance + portfolio.openOrders.reduce((s, o) => s + (o.totalCost || 0), 0);
  if (!shouldAnalyze(equityForAnalysis, batches[0]?.length || 0)) {
    const msg = "💸 Costo de IA excede límite seguro para bankroll actual.";
    activities.push(activity(msg, "Warning"));
    debugLog.error = msg;
    _cycleLogs.unshift(debugLog);
    if (_cycleLogs.length > 20) _cycleLogs.length = 20;
    dbSaveCycleLog(debugLog).catch(e => console.error("[SmartTrader] DB cycle log save failed:", e));
    return {
      portfolio: updatedPortfolio, betsPlaced: [], marketsAnalyzed: 0,
      marketsEligible: pool.length, aiUsage: null, nextScanSeconds: SCAN_INTERVAL_SECS,
      activities, skippedReason: msg,
    };
  }

  // Fetch performance history once (used for all batches)
  let perfHistory: PerformanceHistory | undefined;
  try {
    const stats = await dbGetStats();
    perfHistory = {
      totalTrades: stats.totalTrades,
      wins: stats.wins,
      losses: stats.losses,
      totalPnl: stats.totalPnl,
      winRate: stats.winRate,
    };
  } catch (e) {
    log("⚠️ Could not fetch performance history:", e);
  }

  // ─── Step 3: Multi-batch Claude Analysis Loop ───────────
  // If batch N yields 0 bets AND more batches remain → try batch N+1 immediately.
  // Stop when: bets placed, all batches exhausted, or error.
  let totalBetsThisCycle = 0;
  let totalRecommendations = 0;
  let lastAiResult: ClaudeResearchResult | null = null;
  let totalAICostCycle = 0;

  // Set throttle BEFORE starting (prevents concurrent cycles)
  _lastClaudeCallTime = Date.now();
  _persistThrottleState();

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    const batchLabel = `Batch ${batchIdx + 1}/${batches.length}`;

    log(`\n═══ ${batchLabel}: ${batch.length} mercados ═══`);
    activities.push(activity(`📡 ${batchLabel}: Enviando ${batch.length} mercados ${expiryLabel} a Claude...`, "Inference"));

    let aiResult: ClaudeResearchResult;

    try {
      const equityForClaude = updatedPortfolio.balance + updatedPortfolio.openOrders.reduce((s, o) => s + (o.totalCost || 0), 0);

      aiResult = await analyzeMarketsWithClaude(
        batch,
        updatedPortfolio.openOrders,
        equityForClaude,
        claudeModel,
        perfHistory,
      );

      lastAiResult = aiResult;
      totalAICostCycle += aiResult.usage.costUsd;

      // Update debug log with latest batch info
      debugLog.prompt = aiResult.prompt;
      debugLog.rawResponse = aiResult.rawResponse;
      debugLog.inputTokens += aiResult.usage.inputTokens;
      debugLog.outputTokens += aiResult.usage.outputTokens;
      debugLog.costUsd += aiResult.usage.costUsd;
      debugLog.responseTimeMs += aiResult.responseTimeMs;
      debugLog.summary = aiResult.summary;
      debugLog.recommendations += aiResult.analyses.length;
      totalRecommendations += aiResult.analyses.length;

      // Mark batch markets as analyzed
      _markAnalyzed(batch.map(m => m.id));

      log(`🔬 ${batchLabel}: ${aiResult.analyses.length} recomendaciones — Costo: ${formatCost(aiResult.usage.costUsd)} (${aiResult.responseTimeMs}ms)`);
      log(`💡 ${aiResult.summary}`);

      activities.push(activity(
        `🔬 ${batchLabel}: ${aiResult.analyses.length} recs — ${formatCost(aiResult.usage.costUsd)} (${aiResult.responseTimeMs}ms)`,
        "Inference"
      ));

    } catch (error: any) {
      const errMsg = error?.message || String(error);
      log(`❌ ${batchLabel} error:`, errMsg);
      activities.push(activity(`❌ ${batchLabel}: ${errMsg.slice(0, 100)}`, "Error"));
      debugLog.error = errMsg;
      break; // Stop trying more batches on error
    }

    // ─── Process recommendations from this batch ──
    const dedupedAnalyses = deduplicateCorrelatedMarkets(aiResult.analyses);

    if (dedupedAnalyses.length < aiResult.analyses.length) {
      const skippedDedup = aiResult.analyses.length - dedupedAnalyses.length;
      log(`🔗 Cluster dedup: ${aiResult.analyses.length} → ${dedupedAnalyses.length} (${skippedDedup} correlacionados eliminados)`);
    }

    let betsThisBatch = 0;

    for (const analysis of dedupedAnalyses) {
      const rr: RecommendationResult = {
        marketId: analysis.marketId,
        question: analysis.question,
        recommendedSide: analysis.recommendedSide,
        pMarket: analysis.pMarket,
        pReal: analysis.pReal,
        edge: analysis.edge,
        confidence: analysis.confidence,
        reasoning: analysis.reasoning,
        sources: analysis.sources || [],
        decision: "SKIP — processing",
      };

      // Find the market by exact ID from the full pool
      let market = fullPool.find(m => m.id === analysis.marketId);

      if (!market && analysis.question) {
        const normQ = analysis.question.toLowerCase().trim();
        market = fullPool.find(m => m.question.toLowerCase().trim() === normQ);
        if (!market) {
          market = fullPool.find(m =>
            m.question.toLowerCase().includes(normQ.slice(0, 40)) ||
            normQ.includes(m.question.toLowerCase().slice(0, 40))
          );
        }
        if (market) log(`  ⚠️ ID no coincide, match por texto: "${market.question.slice(0, 50)}"`);
      }

      if (!market) {
        rr.decision = "SKIP — Market ID not found in pool";
        debugLog.results.push(rr);
        log(`  ❌ ID "${analysis.marketId}" no encontrado — SKIP`);
        continue;
      }

      const prices = market.outcomePrices.map(p => parseFloat(p));
      const yesPrice = prices[0] || 0.5;
      const noPrice = prices[1] || (1 - yesPrice);

      const enrichedAnalysis: MarketAnalysis = {
        ...analysis,
        marketId: market.id,
        pMarket: analysis.recommendedSide === "YES" ? yesPrice : noPrice,
        edge: analysis.recommendedSide === "YES"
          ? analysis.pReal - yesPrice
          : (1 - analysis.pReal) - noPrice,
      };

      rr.pMarket = enrichedAnalysis.pMarket;
      rr.edge = enrichedAnalysis.edge;

      const endMs = new Date(market.endDate).getTime();
      const minutesLeft = Math.max(0, Math.round((endMs - now) / 60000));

      log(`\n  📌 "${analysis.question.slice(0, 55)}"`);
      log(`     ${analysis.recommendedSide} | pMkt(real)=${(enrichedAnalysis.pMarket * 100).toFixed(1)}% | pReal=${(analysis.pReal * 100).toFixed(1)}% | edge=${(enrichedAnalysis.edge * 100).toFixed(1)}% | conf=${analysis.confidence} | ${minutesLeft}min`);

      const investedInOrders = updatedPortfolio.openOrders.reduce((s, o) => s + (o.totalCost || 0), 0);
      const equity = updatedPortfolio.balance + investedInOrders;
      const kelly = calculateKellyBet(
        enrichedAnalysis,
        market,
        equity,
        aiResult.usage.costUsd,
        Math.max(1, aiResult.analyses.length),
        updatedPortfolio.balance,
      );

      rr.kellyResult = kelly;
      log(`     Kelly: raw=${(kelly.rawKelly * 100).toFixed(2)}% | ¼K=${(kelly.fractionalKelly * 100).toFixed(2)}% | $${kelly.betAmount.toFixed(2)} | EV=$${kelly.expectedValue.toFixed(4)}`);

      if (kelly.betAmount <= 0) {
        rr.decision = `SKIP — ${kelly.reasoning}`;
        debugLog.results.push(rr);
        log(`     ⏭️ SKIP — ${kelly.reasoning}`);
        continue;
      }

      // ─── Place Bet ─────────────────────────────
      const quantity = kelly.betAmount / kelly.price;
      const { order, portfolio: newPortfolio, error } = createPaperOrder(
        market, kelly.outcomeIndex, "buy", quantity, updatedPortfolio,
      );

      if (error || !order) {
        rr.decision = `ERROR — ${error}`;
        debugLog.results.push(rr);
        log(`     ❌ Orden fallida: ${error}`);
        continue;
      }

      order.aiReasoning = {
        claudeAnalysis: {
          pMarket: enrichedAnalysis.pMarket,
          pReal: analysis.pReal,
          pLow: analysis.pLow,
          pHigh: analysis.pHigh,
          edge: enrichedAnalysis.edge,
          confidence: analysis.confidence,
          recommendedSide: analysis.recommendedSide,
          reasoning: analysis.reasoning,
          sources: analysis.sources || [],
          evNet: analysis.evNet,
          maxEntryPrice: analysis.maxEntryPrice,
          sizeUsd: analysis.sizeUsd,
          orderType: analysis.orderType,
          clusterId: analysis.clusterId,
          risks: analysis.risks,
          resolutionCriteria: analysis.resolutionCriteria,
        },
        kelly: {
          rawKelly: kelly.rawKelly,
          fractionalKelly: kelly.fractionalKelly,
          betAmount: kelly.betAmount,
          expectedValue: kelly.expectedValue,
          aiCostPerBet: kelly.aiCostPerBet,
        },
        model: debugLog.model,
        costUsd: aiResult.usage.costUsd / Math.max(1, aiResult.analyses.length),
        timestamp: new Date().toISOString(),
        fullPrompt: aiResult.prompt,
        fullResponse: aiResult.rawResponse,
      };

      const orderIdx = newPortfolio.openOrders.findIndex(o => o.id === order.id);
      if (orderIdx >= 0) {
        newPortfolio.openOrders[orderIdx] = order;
      }

      dbUpdateOrder({ id: order.id, aiReasoning: order.aiReasoning, status: order.status }).catch(
        e => console.error("[SmartTrader] DB update aiReasoning failed:", e)
      );

      updatedPortfolio = newPortfolio;
      betsThisBatch++;
      totalBetsThisCycle++;
      betsPlaced.push(kelly);

      rr.decision = `BET $${kelly.betAmount.toFixed(2)}`;
      debugLog.results.push(rr);

      activities.push(activity(
        `🎯 APUESTA: ${kelly.outcomeName} "${market.question.slice(0, 40)}..." @ ${(kelly.price * 100).toFixed(0)}¢ | $${kelly.betAmount.toFixed(2)} | Edge ${(enrichedAnalysis.edge * 100).toFixed(1)}% | ⏱️${minutesLeft}min`,
        "Order"
      ));

      log(`     ✅ BET: ${kelly.outcomeName} — $${kelly.betAmount.toFixed(2)} @ ${(kelly.price * 100).toFixed(1)}¢ — ${minutesLeft}min left`);
    }

    // If we placed bets this batch → stop (don't burn more API calls)
    if (betsThisBatch > 0) {
      log(`✅ ${batchLabel} colocó ${betsThisBatch} apuesta(s) — deteniendo batches.`);
      break;
    }

    // If no bets and more batches remain → log and continue immediately
    if (batchIdx < batches.length - 1) {
      log(`📭 ${batchLabel}: 0 apuestas — probando siguiente batch inmediatamente...`);
      activities.push(activity(`📭 ${batchLabel}: 0 apuestas — probando siguiente batch...`, "Info"));
    }
  } // end batch loop

  // Update throttle AFTER all batches complete
  _lastClaudeCallTime = Date.now();
  _persistThrottleState();

  // ─── Summary ─────────────────────────────────
  const totalAICost = costTracker.totalCostUsd + totalAICostCycle;
  debugLog.betsPlaced = totalBetsThisCycle;
  debugLog.nextScanSecs = SCAN_INTERVAL_SECS;

  log("────────────────────────────────────────────────");
  log(`📋 RESUMEN: ${totalBetsThisCycle} apuestas / ${totalRecommendations} recomendaciones / ${fullPool.length} en pool (${batches.length} batches)`);
  log(`💡 ${lastAiResult?.summary || "(no AI result)"}`);
  log(`💸 Costo ciclo: ${formatCost(totalAICostCycle)} | Total: ${formatCost(totalAICost)}`);
  log(`⏱️ Próximo ciclo en ${SCAN_INTERVAL_SECS}s`);
  log("────────────────────────────────────────────────");

  if (totalBetsThisCycle === 0) {
    let reason = "";
    if (totalRecommendations === 0) reason = `Claude no encontró mispricing en ${batches.length} batch(es) (${Math.min(fullPool.length, batches.length * MAX_POOL_FOR_ANALYSIS)} mercados ${expiryLabel}).`;
    else reason = "Kelly rechazó las recomendaciones (edge o monto insuficiente).";

    activities.push(activity(
      `📭 0 apuestas de ${totalRecommendations} recs (${batches.length} batches). ${reason} Costo: ${formatCost(totalAICostCycle)}`,
      "Info"
    ));
  } else {
    activities.push(activity(
      `✅ ${totalBetsThisCycle} apuestas | Balance: $${updatedPortfolio.balance.toFixed(2)} | IA: ${formatCost(totalAICostCycle)}`,
      "Info"
    ));
  }

  _cycleLogs.unshift(debugLog);
  if (_cycleLogs.length > 20) _cycleLogs.length = 20;
  dbSaveCycleLog(debugLog).catch(e => console.error("[SmartTrader] DB cycle log save failed:", e));

  return {
    portfolio: updatedPortfolio,
    betsPlaced,
    marketsAnalyzed: totalRecommendations,
    marketsEligible: fullPool.length,
    aiUsage: lastAiResult?.usage || null,
    nextScanSeconds: SCAN_INTERVAL_SECS,
    activities,
  };
}
