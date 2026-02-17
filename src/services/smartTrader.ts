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
import { analyzeMarketsWithClaude, loadCostTracker, formatCost, ClaudeResearchResult, PerformanceHistory, SkippedMarket } from "./claudeAI";
import {
  JUNK_PATTERNS, JUNK_REGEXES, WEATHER_RE,
  computeMinLiquidity, MIN_VOLUME, WEATHER_MIN_LIQUIDITY, WEATHER_MIN_VOLUME,
  PRICE_FLOOR, PRICE_CEILING, computeClusterKey, computeBroadClusterKey,
  estimateSpread, MAX_SPREAD,
} from "./marketConstants";
// loadCostTracker is now async (DB-only)
import { calculateKellyBet, canTrade, getBankrollStatus, shouldAnalyze } from "./kellyStrategy";
import { createPaperOrder } from "./paperTrading";
import { dbSaveCycleLog, dbUpdateOrder, dbGetStats } from "./db";

// ─── Config ───────────────────────────────────────────

let _maxExpiryMs = 120 * 60 * 60 * 1000;  // Default: 5 days (configurable)
const SCAN_INTERVAL_SECS = 86400;         // 24 hours between cycles (daily 6am run)

// Minimum liquidity/volume/price thresholds imported from marketConstants.ts
// (single source of truth shared with polymarket.ts Bot View)

// Time throttle: enforce minimum 20 HOURS between Claude API calls.
// Markets are re-analyzed each cycle because prices/conditions change constantly.
// ALL state persisted in localStorage to survive page reloads AND tab closures.
let _lastClaudeCallTime = Number(localStorage.getItem('_smartTrader_lastClaudeCall') || '0');
const MIN_CLAUDE_INTERVAL_MS = 20 * 60 * 60 * 1000;    // HARD minimum: 20 hours between Claude calls (daily schedule)

/** Persist throttle timestamp to localStorage (survives page reload + tab close) */
function _persistThrottleState() {
  try {
    localStorage.setItem('_smartTrader_lastClaudeCall', String(_lastClaudeCallTime));
  } catch { /* localStorage full or unavailable — ignore */ }
}

// ─── Recently-analyzed cache: avoid re-sending same markets to Claude ──
// Maps marketId → timestamp when last sent. Markets with recent analysis are excluded
// from the pool unless enough time has passed (ANALYZED_CACHE_TTL).
// TTL MUST match throttle interval — otherwise with a 35-market pool and 30min TTL,
// cycles 2 & 3 see only 5-8 markets because 30 are still "recently analyzed".
const ANALYZED_CACHE_KEY = '_smartTrader_analyzedMap';
const ANALYZED_CACHE_TTL_MS = MIN_CLAUDE_INTERVAL_MS; // = 20 hours, prevents rapid re-analysis on page reload

function _loadAnalyzedMap(): Map<string, number> {
  try {
    const raw = localStorage.getItem(ANALYZED_CACHE_KEY);
    if (!raw) return new Map();
    const entries: [string, number][] = JSON.parse(raw);
    const now = Date.now();
    // Filter out expired entries
    return new Map(entries.filter(([, ts]) => (now - ts) < ANALYZED_CACHE_TTL_MS));
  } catch { return new Map(); }
}

function _saveAnalyzedMap(map: Map<string, number>) {
  try {
    localStorage.setItem(ANALYZED_CACHE_KEY, JSON.stringify([...map.entries()]));
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
 * PERSISTED in localStorage with a TTL (max 3 min) to survive reloads but auto-expire
 * if the tab crashed or the cycle hung.
 */
const CYCLE_LOCK_KEY = '_smartTrader_cycleLock';
const CYCLE_LOCK_MAX_MS = 3 * 60 * 1000; // Lock expires after 3 min max

function _isCycleLocked(): boolean {
  try {
    const raw = localStorage.getItem(CYCLE_LOCK_KEY);
    if (!raw) return false;
    const lockTime = Number(raw);
    if (isNaN(lockTime)) return false;
    // Lock is valid if < CYCLE_LOCK_MAX_MS old
    return (Date.now() - lockTime) < CYCLE_LOCK_MAX_MS;
  } catch { return false; }
}

function _setCycleLock() {
  try { localStorage.setItem(CYCLE_LOCK_KEY, String(Date.now())); } catch {}
}

function _clearCycleLock() {
  try { localStorage.removeItem(CYCLE_LOCK_KEY); } catch {}
}

let _cycleRunning = false;

/** Called from App.tsx when config changes */
export function setMaxExpiry(hours: number) {
  const HARD_MAX_HOURS = 168; // 7 days absolute cap — safety net
  const h = Math.min((hours && !isNaN(hours) && hours > 0) ? hours : 24, HARD_MAX_HOURS);
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
    sports: number;         // always excluded (Claude can't verify bookmaker odds)
    crypto: number;         // excluded crypto/finance (0 if included via progressive relaxation)
    stocks: number;         // excluded stocks/indices (0 if included via progressive relaxation)
    duplicateOpen: number;
    lowLiquidity: number;
    wideSpread: number;       // rejected by spread guard (estimated spread > MAX_SPREAD)
    passed: number;
    filterLevel: number;    // 0=strict, 1=+crypto, 2=+crypto+stocks
    filterLabel: string;    // Human label: "Estricto", "+Crypto", etc.
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
  skipped: SkippedMarket[];
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
  localStorage.removeItem('_smartTrader_analyzedIds'); // cleanup legacy key
  localStorage.removeItem(ANALYZED_CACHE_KEY); // clear recently-analyzed cache
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

  // Step 1: Build cluster map using BROAD cluster key
  // This catches "NYC ≤41°F" + "NYC 42-43°F" as same cluster (both about NYC high temp)
  const clusterMap = new Map<string, MarketAnalysis[]>();

  for (const a of analyses) {
    // Try Claude's clusterId first
    let key = a.clusterId || "";

    // If no clusterId, compute a BROAD text-based cluster key
    if (!key) {
      key = computeBroadClusterKey(a.question);
    }
    // Fallback to narrow key if broad is empty
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

// computeClusterKey imported from marketConstants.ts

// ─── Pre-filter: markets expiring ≤maxExpiry — PROGRESSIVE ─────

/** Minimum pool size before we start relaxing content filters */
const MIN_POOL_TARGET = 15;

const FILTER_LEVEL_LABELS = ["Estricto", "+Crypto", "+Crypto+Stocks", "Todo (sin junk)"];

/** Max markets to analyze per cycle (daily limit) */
const MAX_ANALYZED_PER_CYCLE = 20;
/** Max Claude batches = MAX_ANALYZED_PER_CYCLE / BATCH_SIZE */
const MAX_BATCHES_PER_CYCLE = 5;

// ─── Category classifier for pool diversification ─────
// WEATHER_RE imported from marketConstants.ts
const politicsPatterns = /trump|biden|harris|congress|senate|house of rep|election|vote|poll|president|governor|democrat|republican|gop|legislation|bill sign|executive order|supreme court|scotus|impeach|primary|caucus|cabinet|veto|filibuster/;
const geopoliticsPatterns = /war|military|invasion|nato|united nations|\bun\b|sanction|tariff|trade war|ceasefire|peace deal|treaty|summit|nuclear|missile|refugee|occupation|annexation/;
const entertainmentPatterns = /oscar|grammy|emmy|movie|film|box office|album|song|concert|tv show|series|streaming|netflix|disney|spotify|billboard|ratings|premiere|celebrity|award/;

function classifyMarketCategory(market: PolymarketMarket): string {
  // Use the API-derived category first (set by categorizeMarket() during fetch)
  if (market.category === 'sports') return 'sports';

  const q = market.question.toLowerCase();
  if (cryptoPatterns.some(p => q.includes(p))) return 'crypto';
  if (stockPatterns.some(p => q.includes(p))) return 'finance';
  if (WEATHER_RE.test(q)) return 'weather';
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
/** Priority order for pool diversification — non-weather first so Claude sees diverse markets */
const CATEGORY_PRIORITY = ['politics', 'geopolitics', 'entertainment', 'other', 'finance', 'crypto', 'weather'];

/** Max markets per category in a single batch (prevents weather from dominating) */
const MAX_PER_CATEGORY: Record<string, number> = {
  weather: 8,      // 8 max — Claude only needs 1-2 searches each
  politics: 12,
  geopolitics: 10,
  entertainment: 10,
  finance: 8,
  crypto: 6,
  other: 10,
};
const DEFAULT_CAT_CAP = 10;

function diversifyPool(markets: PolymarketMarket[], maxSize: number): PolymarketMarket[] {
  const buckets = new Map<string, PolymarketMarket[]>();
  for (const m of markets) {
    const cat = classifyMarketCategory(m);
    if (!buckets.has(cat)) buckets.set(cat, []);
    buckets.get(cat)!.push(m);
  }
  // Sort each bucket by volume descending
  for (const [, arr] of buckets) arr.sort((a, b) => b.volume - a.volume);

  // Apply per-category cap BEFORE round-robin
  for (const [cat, arr] of buckets) {
    const cap = MAX_PER_CATEGORY[cat] ?? DEFAULT_CAT_CAP;
    if (arr.length > cap) {
      log(`  🔪 Category '${cat}' capped: ${arr.length} → ${cap}`);
      arr.length = cap;
    }
  }

  // Order categories by priority, then any unlisted
  const categories = CATEGORY_PRIORITY.filter(c => buckets.has(c));
  for (const c of buckets.keys()) {
    if (!categories.includes(c)) categories.push(c);
  }

  const result: PolymarketMarket[] = [];
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
  bankroll: number,
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
    wideSpread: 0,
    passed: 0,
    filterLevel: 0,
    filterLabel: FILTER_LEVEL_LABELS[0],
  };

  // ── Phase 1: Apply base filters (always enforced) ──
  // Separate markets into: clean, crypto, stocks (sports permanently excluded)
  const clean: PolymarketMarket[] = [];
  const cryptoBucket: PolymarketMarket[] = [];
  const stocksBucket: PolymarketMarket[] = [];

  for (const m of allMarkets) {
    if (!m.endDate) { bd.noEndDate++; continue; }

    const endTime = new Date(m.endDate).getTime();
    const timeLeft = endTime - now;

    if (timeLeft <= 0) { bd.expired++; continue; }
    if (m.resolved || !m.active) { bd.resolved++; continue; }
    if (timeLeft > _maxExpiryMs) { bd.tooFarOut++; continue; }

    // ═══ AUTO-REJECT NEAR EXPIRY (≤10 min) ═══
    // These almost always end up rejected and waste Claude tokens
    if (timeLeft <= 10 * 60 * 1000) { bd.expired++; continue; }

    const q = m.question.toLowerCase();

    // ═══ HARD LIQUIDITY/VOLUME FILTER ═══
    // Dynamic: min_liq = max(floor, 100× typical Kelly bet size)
    // Weather exception: thin but high-edge markets with >12h horizon allow lower thresholds
    const isWeatherMarket = WEATHER_RE.test(q) && timeLeft > 12 * 60 * 60 * 1000;
    const dynamicMinLiq = computeMinLiquidity(bankroll);
    const minLiq = isWeatherMarket ? WEATHER_MIN_LIQUIDITY : dynamicMinLiq;
    const minVol = isWeatherMarket ? WEATHER_MIN_VOLUME : MIN_VOLUME;
    if (m.liquidity < minLiq || m.volume < minVol) {
      bd.lowLiquidity++;
      continue;
    }

    // ═══ SPREAD GUARD (proxy from liquidity) ═══
    // No real orderbook data → estimate spread from liquidity.
    // Reject if estimated spread > MAX_SPREAD (8%) — these are too thin to trade.
    // Weather exception: allowed through (patient limit orders fill better).
    if (!isWeatherMarket) {
      const estSpread = estimateSpread(m.liquidity);
      if (estSpread > MAX_SPREAD) {
        bd.wideSpread++;
        continue;
      }
    }

    // ═══ DE FACTO RESOLVED — prices at extremes, no tradeable edge ═══
    const yp = parseFloat(m.outcomePrices[0] || "0.5");
    if (yp <= PRICE_FLOOR || yp >= PRICE_CEILING) {
      bd.junk++; // count as junk since they're untradeable
      continue;
    }

    // ─── Junk / noise (ALWAYS excluded, no progressive) ───
    // Patterns & regexes imported from marketConstants.ts (shared with Bot View)
    if (JUNK_PATTERNS.some(j => q.includes(j))) { bd.junk++; continue; }
    if (JUNK_REGEXES.some(r => r.test(q))) { bd.junk++; continue; }

    // ─── Skip if already have open order ───
    if (openOrderMarketIds.has(m.id)) { bd.duplicateOpen++; continue; }

    // ─── Classify into content buckets ───
    // Sports/esports excluded via market.category (set from Polymarket API data:
    // sportsMarketType, tags[], categories[], gameId, teamAID, teamBID)
    if (m.category === 'sports') {
      bd.sports++;
      continue;
    } else if (cryptoPatterns.some(p => q.includes(p))) {
      cryptoBucket.push(m);
    } else if (stockPatterns.some(p => q.includes(p))) {
      stocksBucket.push(m);
    } else {
      clean.push(m);
    }
  }

  // Log category distribution for debugging filter effectiveness
  log(`  📦 Category breakdown — clean: ${clean.length}, crypto: ${cryptoBucket.length}, stocks: ${stocksBucket.length}, sports excluded: ${bd.sports}`);
  log(`  📦 Other filters — noEndDate: ${bd.noEndDate}, expired: ${bd.expired}, resolved: ${bd.resolved}, tooFarOut: ${bd.tooFarOut}, junk: ${bd.junk}, lowLiq: ${bd.lowLiquidity}, wideSpread: ${bd.wideSpread}, dupeOpen: ${bd.duplicateOpen}`);

  // Initialize counts as "excluded"
  bd.crypto = cryptoBucket.length;
  bd.stocks = stocksBucket.length;

  // ── Phase 2: Progressive relaxation ──
  // Start strict, add categories until pool >= MIN_POOL_TARGET
  // Sports are NEVER included (Claude can't verify bookmaker odds → 100% rejection)
  const pool = [...clean];
  let level = 0;

  if (pool.length < MIN_POOL_TARGET && cryptoBucket.length > 0) {
    pool.push(...cryptoBucket);
    bd.crypto = 0;
    level = 1;
    log(`  📈 Filtro progresivo → Nivel 1: +${cryptoBucket.length} crypto (pool era ${pool.length - cryptoBucket.length})`);
  }

  if (pool.length < MIN_POOL_TARGET && stocksBucket.length > 0) {
    pool.push(...stocksBucket);
    bd.stocks = 0;
    level = 2;
    log(`  📈 Filtro progresivo → Nivel 2: +${stocksBucket.length} stocks/finance (pool era ${pool.length - stocksBucket.length})`);
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
  // Check BOTH in-memory flag AND localStorage (survives reload)
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
    poolBreakdown: { total: 0, noEndDate: 0, expired: 0, resolved: 0, tooFarOut: 0, junk: 0, sports: 0, crypto: 0, stocks: 0, duplicateOpen: 0, lowLiquidity: 0, wideSpread: 0, passed: 0, filterLevel: 0, filterLabel: "Estricto" },
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
    skipped: [],
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
  const { pool, breakdown } = buildShortTermPool(allMarkets, openOrderIds, now, portfolio.balance);
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

  // ─── Step 1.6: Filter out markets conflicting with OPEN ORDERS (broad cluster match) ──
  // "NYC ≤41°F" and "NYC between 42-43°F" are mutually exclusive — betting both is
  // guaranteed to lose one. Uses broad cluster key (strips all numbers + threshold words).
  const openOrderBroadKeys = new Set<string>();
  for (const o of portfolio.openOrders) {
    if (o.status !== "filled" && o.status !== "pending") continue;
    const bk = computeBroadClusterKey(o.marketQuestion);
    if (bk) openOrderBroadKeys.add(bk);
  }
  if (openOrderBroadKeys.size > 0) {
    const beforeLen = pool.length;
    const conflicting: string[] = [];
    const filtered = pool.filter(m => {
      const bk = computeBroadClusterKey(m.question);
      if (bk && openOrderBroadKeys.has(bk)) {
        conflicting.push(`"${m.question.slice(0, 60)}" (cluster: ${bk.slice(0, 40)})`);
        return false;
      }
      return true;
    });
    if (conflicting.length > 0) {
      log(`  🚫 Broad cluster conflict filter: removed ${conflicting.length} markets already covered by open orders:`);
      conflicting.forEach(c => log(`     - ${c}`));
    }
    pool.length = 0;
    pool.push(...filtered);
  }

  const expiryLabel = _maxExpiryMs >= 86400000 ? `≤${(_maxExpiryMs / 86400000).toFixed(_maxExpiryMs % 86400000 === 0 ? 0 : 1)}d` : `≤${_maxExpiryMs / 3600000}h`;
  log(`⏱️ Pool ${expiryLabel}: ${pool.length} mercados (de ${allMarkets.length}, ${clustersCollapsed} cluster-dupes eliminados) — Filtro: ${breakdown.filterLabel}`);
  log(`   Filtrado: ${breakdown.tooFarOut} fuera ventana, ${breakdown.junk} junk, ${breakdown.sports} deportes excl, ${breakdown.crypto} crypto excl, ${breakdown.stocks} stocks excl, ${breakdown.lowLiquidity} baja liq, ${breakdown.duplicateOpen} ya abiertos`);

  activities.push(activity(
    `⏱️ Pool ${expiryLabel}: ${pool.length} mercados [${breakdown.filterLabel}] (${breakdown.junk} junk, ${breakdown.sports} dep, ${breakdown.crypto} crypto, ${breakdown.lowLiquidity} baja liq, ${breakdown.wideSpread} spread, ${clustersCollapsed} cluster-dupes)`,
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
    log(`🔄 ${analyzedSkipped} mercados ya analizados en último ciclo — excluidos del pool`);
    pool.length = 0;
    pool.push(...freshPool);
  }

  if (pool.length === 0 && analyzedSkipped > 0) {
    const msg = `📋 Todos los ${analyzedSkipped} mercados ya fueron analizados en el último ciclo. Esperando mercados nuevos...`;
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
  // interleave categories so Claude sees weather + politics + finance + etc.
  const BATCH_SIZE = 4;  // Send 4 markets at a time for deep analysis
  const fullPool = [...pool]; // keep reference to full pool for market lookup
  const diversified = diversifyPool(pool, Math.min(pool.length, MAX_ANALYZED_PER_CYCLE)); // reorder + cap at daily limit

  // Split into sequential batches of 4 — max MAX_BATCHES_PER_CYCLE batches
  const batches: PolymarketMarket[][] = [];
  for (let i = 0; i < diversified.length && batches.length < MAX_BATCHES_PER_CYCLE; i += BATCH_SIZE) {
    batches.push(diversified.slice(i, i + BATCH_SIZE));
  }

  log(`📦 Pool: ${fullPool.length} mercados → ${diversified.length} seleccionados → ${batches.length} batch(es) de ≤${BATCH_SIZE} (máx ${MAX_ANALYZED_PER_CYCLE}/día)`);

  // shouldAnalyze checks if estimated cost for selected batches is affordable
  const totalMarketsToAnalyze = diversified.length; // capped at MAX_ANALYZED_PER_CYCLE
  if (!shouldAnalyze(portfolio.balance, totalMarketsToAnalyze)) {
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
      // Tell Claude the available cash (true Kelly bankroll)
      aiResult = await analyzeMarketsWithClaude(
        batch,
        updatedPortfolio.openOrders,
        updatedPortfolio.balance,
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
      debugLog.skipped = [...debugLog.skipped, ...aiResult.skipped];
      totalRecommendations += aiResult.analyses.length;

      // Mark batch markets as analyzed
      _markAnalyzed(batch.map(m => m.id));

      log(`🔬 ${batchLabel}: ${aiResult.analyses.length} recomendaciones, ${aiResult.skipped.length} descartados — Costo: ${formatCost(aiResult.usage.costUsd)} (${aiResult.responseTimeMs}ms)`);
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

      // True Kelly: bankroll = available cash (not total equity)
      const kelly = calculateKellyBet(
        enrichedAnalysis,
        market,
        updatedPortfolio.balance,
        aiResult.usage.costUsd,
        Math.max(1, aiResult.analyses.length),
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
      // HARD SAFETY: reject if market expires beyond maxExpiry (belt-and-suspenders)
      const msLeft = endMs - now;
      if (msLeft > _maxExpiryMs) {
        rr.decision = `HARD_REJECT — expires in ${(msLeft / 3600000).toFixed(1)}h > max ${(_maxExpiryMs / 3600000).toFixed(0)}h`;
        debugLog.results.push(rr);
        log(`     🚫 HARD REJECT: expiry ${(msLeft / 3600000).toFixed(1)}h exceeds max ${(_maxExpiryMs / 3600000).toFixed(0)}h`);
        continue;
      }
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

    // Always continue to next batch — analyze ALL markets
    if (betsThisBatch > 0) {
      log(`✅ ${batchLabel} colocó ${betsThisBatch} apuesta(s) — continuando con siguiente batch...`);
    }
    if (batchIdx < batches.length - 1) {
      log(`📡 ${batchLabel}: ${betsThisBatch} apuesta(s) — siguiente batch...`);
      activities.push(activity(`📡 Batch ${batchIdx + 1}/${batches.length}: ${betsThisBatch} apuesta(s) — continuando...`, "Info"));
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
    if (totalRecommendations === 0) reason = `Claude no encontró mispricing en ${batches.length} batch(es) (${fullPool.length} mercados ${expiryLabel}).`;
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
