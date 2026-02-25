// ═══════════════════════════════════════════════════════════════════
// Supabase Edge Function — Smart Trader Autonomous Cycle
// Triggered by pg_cron daily at 14:00 UTC (9am UTC-5 Colombia)
//
// Self-contained: fetches markets, analyzes with Claude, places paper
// orders — ALL server-side, no browser dependency.
// ═══════════════════════════════════════════════════════════════════

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ─── Environment ─────────────────────────────────────

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CLAUDE_API_KEY = Deno.env.get("CLAUDE_API_KEY") || "";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") || "";
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") || "";
const XAI_API_KEY = Deno.env.get("XAI_API_KEY") || "";
const DEEPSEEK_API_KEY = Deno.env.get("DEEPSEEK_API_KEY") || "";
const GAMMA_API = "https://gamma-api.polymarket.com";
const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";

type AIProviderType = "anthropic" | "google" | "openai" | "xai" | "deepseek";

// API keys from env (server secrets) — will be supplemented by bot_kv keys
let envApiKeys: Record<AIProviderType, string> = {
  anthropic: CLAUDE_API_KEY,
  google: GEMINI_API_KEY,
  openai: OPENAI_API_KEY,
  xai: XAI_API_KEY,
  deepseek: DEEPSEEK_API_KEY,
};
// Keys from bot_kv (user-entered via web form) — loaded on demand
let userApiKeys: Partial<Record<AIProviderType, string>> = {};
let userApiKeysLoaded = false;

async function loadUserApiKeys(): Promise<void> {
  if (userApiKeysLoaded) return;
  try {
    const { data } = await supabase.from("bot_kv").select("value").eq("key", "bot_config").single();
    if (data?.value) {
      const config = JSON.parse(data.value);
      if (config.ai_api_keys) {
        userApiKeys = config.ai_api_keys;
        log(`[Keys] Loaded user API keys from bot_kv: ${Object.keys(userApiKeys).filter(k => userApiKeys[k as AIProviderType]).join(", ")}`);
      }
    }
  } catch { /* ignore */ }
  userApiKeysLoaded = true;
}

function getProviderApiKey(provider: AIProviderType): string {
  // Priority: 1) Server env secrets, 2) User-entered keys from bot_kv
  return envApiKeys[provider] || userApiKeys[provider] || "";
}

// ─── Supabase Client (service role — full access) ────

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ─── CORS ────────────────────────────────────────────

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ─── Config ──────────────────────────────────────────

const MAX_EXPIRY_MS = 120 * 60 * 60 * 1000; // 5 days
const SCAN_INTERVAL_SECS = 86400;
const MIN_CLAUDE_INTERVAL_MS = 3 * 60 * 1000; // 3 min entre auto-ciclos (cron dispara cada 5 min)
const ANALYZED_MAP_TTL_MS = 12 * 60 * 60 * 1000; // Mercados analizados se cachean 12h
const BATCH_DELAY_MS = 0; // No delay — 1 batch per invocation, cron/frontend chains calls
const BATCH_SIZE = 5; // 5 markets per batch (single batch per invocation)
const MAX_BATCHES_PER_CYCLE = 1; // 1 batch per invocation — cron/frontend chains multiple calls
const MAX_ANALYZED_PER_CYCLE = 5; // 1 batch × 5 markets
const MAX_AUTO_CYCLES_PER_DAY = 5; // Máx invocaciones automáticas por día (cron)
const MIN_POOL_TARGET = 15;
const DEFAULT_MODEL = "gemini-2.5-flash"; // Changed: Anthropic credits depleted, use Gemini as default

// Kelly — defaults (Claude)
const KELLY_FRACTION = 0.50;
const MAX_BET_FRACTION = 0.10;
const MIN_BET_USD = 1.00;
const MIN_EDGE_AFTER_COSTS = 0.06;
const MIN_CONFIDENCE = 60;
// Kelly — Gemini overrides (stricter because Gemini is over-confident)
const GEMINI_MAX_BET_FRACTION = 0.07;
const GEMINI_MIN_EDGE_AFTER_COSTS = 0.12;
const GEMINI_MIN_CONFIDENCE = 75;
const MIN_MARKET_PRICE = 0.02;
const MAX_MARKET_PRICE = 0.98;
const MIN_RETURN_PCT = 0.03;
const LOTTERY_PRICE_THRESHOLD = 0.20;
const LOTTERY_MIN_CONFIDENCE = 70;
const LOTTERY_MAX_BET_FRACTION = 0.03;
const MAX_ENRICHED_EDGE = 0.40;

// Market constants
const MIN_LIQUIDITY_FLOOR = 1500;
const MIN_LIQUIDITY_CAP = 10_000;
const MIN_LIQUIDITY_MULTIPLIER = 50;
const MIN_VOLUME = 300;
const WEATHER_MIN_LIQUIDITY = 500;
const WEATHER_MIN_VOLUME = 300;
const MAX_SPREAD = 0.08;
const PRICE_FLOOR = 0.05;
const PRICE_CEILING = 0.95;

// Model pricing ($ per 1M tokens)
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // Anthropic
  "claude-opus-4-6":               { input: 5,    output: 25 },
  "claude-opus-4-5":               { input: 5,    output: 25 },
  "claude-sonnet-4-5":             { input: 3,    output: 15 },
  "claude-sonnet-4-20250514":      { input: 3,    output: 15 },
  "claude-haiku-4-5":              { input: 1,    output: 5 },
  "claude-3-5-haiku-20241022":     { input: 0.80, output: 4 },
  // Google Gemini
  "gemini-2.5-pro":                { input: 1.25, output: 10 },
  "gemini-2.5-flash":              { input: 0.15, output: 0.60 },
  "gemini-2.0-flash":              { input: 0.10, output: 0.40 },
  "gemini-2.0-flash-lite":         { input: 0.075, output: 0.30 },
  // OpenAI
  "gpt-4.1":                       { input: 2,    output: 8 },
  "gpt-4.1-mini":                  { input: 0.40, output: 1.60 },
  "gpt-4.1-nano":                  { input: 0.10, output: 0.40 },
  "o3":                            { input: 2,    output: 8 },
  "o4-mini":                       { input: 1.10, output: 4.40 },
  // xAI
  "grok-3":                        { input: 3,    output: 15 },
  "grok-3-mini":                   { input: 0.30, output: 0.50 },
  // DeepSeek
  "deepseek-chat":                 { input: 0.27, output: 1.10 },
  "deepseek-reasoner":             { input: 0.55, output: 2.19 },
  // Default
  "default":                       { input: 3,    output: 15 },
};

// ─── Types ───────────────────────────────────────────

interface PolymarketMarket {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  outcomes: string[];
  outcomePrices: string[];
  clobTokenIds: string[];
  volume: number;
  liquidity: number;
  endDate: string;
  active: boolean;
  closed: boolean;
  resolved: boolean;
  description?: string;
  category?: string;
}

interface MarketAnalysis {
  marketId: string;
  question: string;
  pMarket: number;
  pReal: number;
  pLow: number;
  pHigh: number;
  edge: number;
  confidence: number;
  recommendedSide: string;
  reasoning: string;
  sources: string[];
  evNet?: number;
  maxEntryPrice?: number;
  sizeUsd?: number;
  orderType?: string;
  clusterId?: string | null;
  risks?: string;
  resolutionCriteria?: string;
  category?: string;
  friction?: number;
  expiresInMin?: number;
  liqUsd?: number;
  volUsd?: number;
  dataFreshnessScore?: number;
  executionNotes?: string;
}

interface KellyResult {
  marketId: string;
  question: string;
  edge: number;
  rawKelly: number;
  fractionalKelly: number;
  betAmount: number;
  outcomeIndex: number;
  outcomeName: string;
  price: number;
  expectedValue: number;
  aiCostPerBet: number;
  confidence: number;
  reasoning: string;
}

interface PaperOrder {
  id: string;
  marketId: string;
  conditionId: string;
  marketQuestion: string;
  marketSlug?: string;
  outcome: string;
  outcomeIndex: number;
  side: string;
  price: number;
  quantity: number;
  totalCost: number;
  potentialPayout: number;
  status: string;
  createdAt: string;
  endDate?: string;
  aiReasoning?: any;
}

interface Portfolio {
  balance: number;
  initialBalance: number;
  totalPnl: number;
  openOrders: PaperOrder[];
  closedOrders: PaperOrder[];
  lastUpdated: string;
}

interface SkippedMarket {
  marketId: string;
  question: string;
  reason: string;
}

// ─── Junk Patterns ───────────────────────────────────

const JUNK_PATTERNS: string[] = [
  "tweet", "tweets", "post on x", "post on twitter", "retweet",
  "truth social post", "truth social", "tiktok", "instagram",
  "youtube video", "viral", "# of ", "#1 free app", "app store",
  "play store", "how many", "number of", "followers", "subscribers",
  "most streamed", "most viewed", "elon musk", "musk post", "musk tweet",
  "spelling bee", "wordle", "jeopardy", "wheel of fortune", "chatgpt",
  "robot dancer", "robot dance", "have robot", "gala", "spring festival",
  "fundraiser", "160-179", "180-199", "200-219",
];

const JUNK_REGEXES: RegExp[] = [
  /will .{1,40} say .{1,30} during/,
  /\d{2,3}-\d{2,3}\s*(posts?|tweets?|times?)/,
];

const WEATHER_RE = /temperature|°[cf]|weather|rain|snow|hurricane|tornado|wind speed|heat wave|cold|frost|humidity|celsius|fahrenheit|forecast|precipitation|storm|flood|drought|wildfire|nws|noaa/;

const cryptoPatterns = [
  "bitcoin", "btc", "ethereum", "eth", "solana", "sol", "dogecoin", "doge",
  "crypto", "cryptocurrency", "blockchain", "defi", "nft", "token", "altcoin",
  "memecoin", "meme coin", "binance", "coinbase", "kraken", "market cap",
  "halving", "staking", "mining", "xrp", "ripple", "cardano", "ada",
  "polkadot", "dot", "avax", "avalanche", "matic", "polygon",
];

const stockPatterns = [
  "stock", "stocks", "s&p 500", "s&p500", "nasdaq", "dow jones", "nyse",
  "share price", "stock price", "ipo", "earnings", "quarterly report",
  "revenue", "fed", "federal reserve", "interest rate", "rate cut",
  "rate hike", "inflation", "cpi", "gdp", "unemployment rate", "treasury",
  "bond", "yield", "forex", "oil price", "gold price", "silver price",
  "commodity", "bull market", "bear market", "recession", "tesla stock",
  "apple stock", "nvidia",
];

// Category classifiers for diversification
const politicsPatterns = /trump|biden|harris|congress|senate|house of rep|election|vote|poll|president|governor|democrat|republican|gop|legislation|bill sign|executive order|supreme court|scotus|impeach|primary|caucus|cabinet|veto|filibuster/;
const geopoliticsPatterns = /war|military|invasion|nato|united nations|\bun\b|sanction|tariff|trade war|ceasefire|peace deal|treaty|summit|nuclear|missile|refugee|occupation|annexation/;
const entertainmentPatterns = /oscar|grammy|emmy|movie|film|box office|album|song|concert|tv show|series|streaming|netflix|disney|spotify|billboard|ratings|premiere|celebrity|award/;

const CATEGORY_PRIORITY = ['politics', 'geopolitics', 'entertainment', 'other', 'finance', 'crypto', 'weather'];
const MAX_PER_CATEGORY: Record<string, number> = {
  weather: 8, politics: 12, geopolitics: 10, entertainment: 10,
  finance: 8, crypto: 6, other: 10,
};
const DEFAULT_CAT_CAP = 10;
const FILTER_LEVEL_LABELS = ["Estricto", "+Crypto", "+Crypto+Stocks", "Todo (sin junk)"];

// ─── Logging ─────────────────────────────────────────

function log(...args: unknown[]) {
  console.log("[SmartTraderCycle]", ...args);
}

// ─── Utility Functions ───────────────────────────────

function computeMinLiquidity(bankroll: number): number {
  const typicalBet = bankroll * 0.025;
  const raw = Math.max(MIN_LIQUIDITY_FLOOR, MIN_LIQUIDITY_MULTIPLIER * typicalBet);
  return Math.min(raw, MIN_LIQUIDITY_CAP);
}

function estimateSpread(liquidity: number): number {
  if (liquidity >= 50_000) return 0.01;
  if (liquidity >= 10_000) return 0.025;
  if (liquidity >= 2_000) return 0.045;
  if (liquidity >= 1_000) return 0.06;
  return 0.08;
}

function computeClusterKey(question: string): string {
  let q = question.toLowerCase().trim();
  q = q.replace(/[-+]?\d[\d,]*\.?\d*/g, "#");
  q = q.replace(/\s+/g, " ");
  if (q.length < 15) return "";
  return q;
}

function computeBroadClusterKey(question: string): string {
  let q = question.toLowerCase().trim();
  q = q.replace(/[-+]?\d[\d,]*\.?\d*/g, "");
  q = q.replace(/°[fc]/g, "");
  q = q.replace(/\b(between|or below|or above|less than|more than|greater than|at least|at most|exactly|be\b)/g, "");
  q = q.replace(/\b(will|the|be|on|in|this|a|an|of|for|to|and|or)\b/g, "");
  q = q.replace(/\?/g, "");
  q = q.replace(/\s+/g, " ").trim();
  if (q.length < 10) return "";
  return q;
}

function calculateTokenCost(inputTokens: number, outputTokens: number, model: string): number {
  const pricing = MODEL_PRICING[model] || MODEL_PRICING["default"];
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}

function formatCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `${(usd * 100).toFixed(2)}¢`;
  return `$${usd.toFixed(4)}`;
}

function generateOrderId(): string {
  return `paper_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// ─── DB: Throttle State (replaces localStorage) ──────

async function getThrottleState(): Promise<{ lastClaudeCallTime: number; analyzedMap: Map<string, number> }> {
  try {
    const { data } = await supabase
      .from("bot_kv")
      .select("key, value")
      .in("key", ["last_claude_call_time", "analyzed_map"]);

    let lastClaudeCallTime = 0;
    let analyzedMap = new Map<string, number>();

    for (const row of data || []) {
      if (row.key === "last_claude_call_time") {
        lastClaudeCallTime = Number(row.value) || 0;
      }
      if (row.key === "analyzed_map") {
        try {
          const entries: [string, number][] = JSON.parse(row.value);
          const now = Date.now();
          analyzedMap = new Map(entries.filter(([, ts]) => (now - ts) < ANALYZED_MAP_TTL_MS));
        } catch { /* ignore */ }
      }
    }

    return { lastClaudeCallTime, analyzedMap };
  } catch (e) {
    log("⚠️ Failed to load throttle state:", e);
    return { lastClaudeCallTime: 0, analyzedMap: new Map() };
  }
}

async function saveThrottleState(lastClaudeCallTime: number, analyzedMap: Map<string, number>, skipTimestamp = false): Promise<void> {
  try {
    const rows: { key: string; value: string; updated_at: string }[] = [
      { key: "analyzed_map", value: JSON.stringify([...analyzedMap.entries()]), updated_at: new Date().toISOString() },
    ];
    // Solo guardar timestamp para ciclos automáticos — runs manuales NO bloquean el cron diario
    if (!skipTimestamp) {
      rows.push({ key: "last_claude_call_time", value: String(lastClaudeCallTime), updated_at: new Date().toISOString() });
    }
    await supabase.from("bot_kv").upsert(rows, { onConflict: "key" });
  } catch (e) {
    log("⚠️ Failed to save throttle state:", e);
  }
}

async function checkCycleLock(): Promise<boolean> {
  try {
    const { data } = await supabase
      .from("bot_kv")
      .select("value")
      .eq("key", "cycle_lock")
      .single();

    if (!data?.value) return false;
    const lockTime = Number(data.value);
    if (isNaN(lockTime)) return false;
    // Lock expires after 5 min (generous for Edge Function)
    return (Date.now() - lockTime) < 5 * 60 * 1000;
  } catch {
    return false;
  }
}

async function setCycleLock(): Promise<void> {
  await supabase.from("bot_kv").upsert(
    { key: "cycle_lock", value: String(Date.now()), updated_at: new Date().toISOString() },
    { onConflict: "key" }
  );
}

async function clearCycleLock(): Promise<void> {
  await supabase.from("bot_kv").upsert(
    { key: "cycle_lock", value: "0", updated_at: new Date().toISOString() },
    { onConflict: "key" }
  );
}

// ─── DB: Load Portfolio ──────────────────────────────

function deserializeOrder(row: any): PaperOrder {
  return {
    id: row.id,
    marketId: row.market_id,
    conditionId: row.condition_id || "",
    marketQuestion: row.market_question,
    marketSlug: row.market_slug || undefined,
    outcome: row.outcome,
    outcomeIndex: row.outcome_index,
    side: row.side || "buy",
    price: row.price,
    quantity: row.quantity,
    totalCost: row.total_cost,
    potentialPayout: row.potential_payout,
    status: row.status,
    createdAt: row.created_at,
    endDate: row.end_date || undefined,
    aiReasoning: row.ai_reasoning || undefined,
  };
}

async function loadPortfolio(): Promise<Portfolio> {
  const { data: portfolio, error: pError } = await supabase
    .from("portfolio")
    .select("*")
    .eq("id", 1)
    .single();
  if (pError) throw new Error(`Portfolio load failed: ${pError.message}`);

  const { data: openOrders } = await supabase
    .from("orders")
    .select("*")
    .in("status", ["pending", "filled"])
    .order("created_at", { ascending: false });

  const open = (openOrders || []).map(deserializeOrder);
  const investedInOpen = open.reduce((s, o) => s + (o.totalCost || 0), 0);

  // Self-healing balance check
  const { data: closedRows } = await supabase
    .from("orders")
    .select("pnl, status")
    .in("status", ["won", "lost"]);
  const realizedPnl = (closedRows || []).reduce((s: number, r: any) => s + (r.pnl || 0), 0);
  const initialBal = portfolio.initial_balance || 100;
  const computedBalance = Math.round((initialBal - investedInOpen + realizedPnl) * 100) / 100;
  let finalBalance = portfolio.balance;

  if (Math.abs(portfolio.balance - computedBalance) > 0.02) {
    log(`⚠️ Balance drift: DB=$${portfolio.balance.toFixed(2)} → computed=$${computedBalance.toFixed(2)}. Auto-fixing.`);
    finalBalance = computedBalance;
    await supabase.from("portfolio").update({ balance: computedBalance }).eq("id", 1);
  }

  return {
    balance: finalBalance,
    initialBalance: initialBal,
    totalPnl: realizedPnl,
    openOrders: open,
    closedOrders: [],
    lastUpdated: portfolio.last_updated,
  };
}

// ─── DB: Create Order ────────────────────────────────

async function dbCreateOrder(order: PaperOrder): Promise<void> {
  const { error } = await supabase.from("orders").insert({
    id: order.id,
    market_id: order.marketId,
    condition_id: order.conditionId || "",
    market_question: order.marketQuestion,
    market_slug: order.marketSlug || null,
    outcome: order.outcome,
    outcome_index: order.outcomeIndex,
    side: order.side,
    price: order.price,
    quantity: order.quantity,
    total_cost: order.totalCost,
    potential_payout: order.potentialPayout,
    status: order.status,
    created_at: order.createdAt,
    end_date: order.endDate || null,
    ai_reasoning: order.aiReasoning || null,
  });
  if (error) throw error;

  // Atomically deduct balance
  const { error: rpcError } = await supabase.rpc("deduct_balance", { amount: order.totalCost });
  if (rpcError) log("⚠️ deduct_balance RPC failed:", rpcError);
}

async function dbUpdateOrder(updates: { id: string; aiReasoning?: any; status?: string }): Promise<void> {
  const update: Record<string, any> = {};
  if (updates.status !== undefined) update.status = updates.status;
  if (updates.aiReasoning !== undefined) update.ai_reasoning = updates.aiReasoning;
  if (Object.keys(update).length === 0) return;
  await supabase.from("orders").update(update).eq("id", updates.id);
}

// ─── DB: Save Cycle Log ──────────────────────────────

async function dbSaveCycleLog(logData: any): Promise<void> {
  await supabase.from("cycle_logs").insert({
    timestamp: logData.timestamp,
    total_markets: logData.totalMarkets,
    pool_breakdown: { ...logData.poolBreakdown, skipped: logData.skipped },
    short_term_list: logData.shortTermList,
    prompt: logData.prompt,
    raw_response: logData.rawResponse,
    model: logData.model,
    input_tokens: logData.inputTokens,
    output_tokens: logData.outputTokens,
    cost_usd: logData.costUsd,
    response_time_ms: logData.responseTimeMs,
    summary: logData.summary,
    recommendations: logData.recommendations,
    results: logData.results,
    bets_placed: logData.betsPlaced,
    next_scan_secs: logData.nextScanSecs,
    error: logData.error || null,
  });
  // Cleanup old logs
  try { await supabase.rpc("cleanup_old_cycle_logs"); } catch { /* ignore */ }
}

// ─── DB: AI Cost Tracking ────────────────────────────

async function dbAddAICost(usage: any): Promise<void> {
  const { data: tracker } = await supabase
    .from("ai_cost_tracker")
    .select("total_calls, total_input_tokens, total_output_tokens, total_cost_usd")
    .eq("id", 1)
    .single();

  if (tracker) {
    await supabase.from("ai_cost_tracker").update({
      total_calls: tracker.total_calls + 1,
      total_input_tokens: tracker.total_input_tokens + usage.inputTokens,
      total_output_tokens: tracker.total_output_tokens + usage.outputTokens,
      total_cost_usd: tracker.total_cost_usd + usage.costUsd,
    }).eq("id", 1);
  }

  await supabase.from("ai_usage_history").insert({
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cost_usd: usage.costUsd,
    model: usage.model,
    timestamp: usage.timestamp || new Date().toISOString(),
    prompt: usage.prompt || null,
    raw_response: usage.rawResponse || null,
    response_time_ms: usage.responseTimeMs || 0,
    summary: usage.summary || null,
    recommendations: usage.recommendations || 0,
    web_searches: usage.webSearches || 0,
    search_queries: usage.searchQueries || [],
  });
}

// ─── DB: Activities ──────────────────────────────────

async function dbAddActivitiesBatch(entries: { timestamp: string; message: string; entry_type: string }[]): Promise<void> {
  if (entries.length === 0) return;
  await supabase.from("activities").insert(entries);
  try { await supabase.rpc("cleanup_old_activities"); } catch { /* ignore */ }
}

// ─── DB: Stats (for performance history) ─────────────

async function dbGetStats(): Promise<{ totalTrades: number; wins: number; losses: number; totalPnl: number; winRate: number }> {
  const { count: winsCount } = await supabase.from("orders").select("*", { count: "exact", head: true }).eq("status", "won");
  const { count: lossesCount } = await supabase.from("orders").select("*", { count: "exact", head: true }).eq("status", "lost");
  const { data: pnlRows } = await supabase.from("orders").select("pnl").in("status", ["won", "lost"]);
  const wins = winsCount || 0;
  const losses = lossesCount || 0;
  const totalPnl = (pnlRows || []).reduce((s: number, r: any) => s + (r.pnl || 0), 0);
  const totalTrades = wins + losses;
  return { totalTrades, wins, losses, totalPnl, winRate: totalTrades > 0 ? (wins / totalTrades) * 100 : 0 };
}

// ─── Market Fetching (Direct Gamma API) ──────────────

function categorizeMarket(title: string, description: string, apiRaw?: any): string {
  if (apiRaw) {
    if (apiRaw.sportsMarketType) return "sports";
    if (apiRaw.gameId || apiRaw.teamAID || apiRaw.teamBID) return "sports";
    const tagLabels: string[] = [];
    const catLabels: string[] = [];
    if (Array.isArray(apiRaw.tags)) tagLabels.push(...apiRaw.tags.map((t: any) => (t.label || t.slug || "").toLowerCase()));
    if (Array.isArray(apiRaw.categories)) catLabels.push(...apiRaw.categories.map((c: any) => (c.label || c.slug || "").toLowerCase()));
    if (Array.isArray(apiRaw.events)) {
      for (const ev of apiRaw.events) {
        if (Array.isArray(ev.tags)) tagLabels.push(...ev.tags.map((t: any) => (t.label || t.slug || "").toLowerCase()));
        if (Array.isArray(ev.categories)) catLabels.push(...ev.categories.map((c: any) => (c.label || c.slug || "").toLowerCase()));
      }
    }
    const allLabels = [...tagLabels, ...catLabels];
    const sportsKeywords = ["sports", "sport", "esports", "football", "soccer", "basketball", "baseball", "hockey", "tennis", "mma", "boxing", "cricket", "golf", "motorsport", "racing"];
    if (allLabels.some(l => sportsKeywords.some(k => l.includes(k)))) return "sports";
    if (allLabels.some(l => l.includes("politic") || l.includes("election") || l.includes("government"))) return "politics";
    if (allLabels.some(l => l.includes("crypto") || l.includes("bitcoin") || l.includes("defi") || l.includes("blockchain"))) return "crypto";
    if (allLabels.some(l => l.includes("entertain") || l.includes("culture") || l.includes("pop culture") || l.includes("music") || l.includes("movie"))) return "entertainment";
    if (allLabels.some(l => l.includes("science") || l.includes("tech") || l.includes("space") || l.includes("climate"))) return "science";
    if (allLabels.some(l => l.includes("business") || l.includes("finance") || l.includes("economics") || l.includes("stocks"))) return "business";
  }
  const text = (title + " " + description).toLowerCase();
  if (/trump|biden|election|president|congress|senate|vote|democrat|republican/.test(text)) return "politics";
  if (/bitcoin|btc|ethereum|eth|crypto|solana|token|coin/.test(text)) return "crypto";
  if (/movie|oscar|grammy|album|celebrity|tv|show|award/.test(text)) return "entertainment";
  if (/stock|market|gdp|fed|inflation|earnings|company|revenue/.test(text)) return "business";
  if (/spacex|nasa|ai|research|study|science|climate|weather/.test(text)) return "science";
  return "other";
}

function parseMarket(m: any): PolymarketMarket | null {
  try {
    const question = m.question || m.title || "";
    if (!question) return null;
    const id = m.id || m.market_id || "";
    const conditionId = m.conditionId || m.condition_id || m.conditionID || id;
    let outcomes: string[] = ["Yes", "No"];
    if (m.outcomes) {
      if (typeof m.outcomes === "string") { try { outcomes = JSON.parse(m.outcomes); } catch { outcomes = m.outcomes.split(",").map((s: string) => s.trim()); } }
      else if (Array.isArray(m.outcomes)) outcomes = m.outcomes;
    }
    let outcomePrices: string[] = ["0.50", "0.50"];
    if (m.outcomePrices) {
      if (typeof m.outcomePrices === "string") { try { outcomePrices = JSON.parse(m.outcomePrices); } catch { outcomePrices = m.outcomePrices.split(",").map((s: string) => s.trim()); } }
      else if (Array.isArray(m.outcomePrices)) outcomePrices = m.outcomePrices.map((p: any) => String(p));
    }
    let clobTokenIds: string[] = [];
    if (m.clobTokenIds) {
      if (typeof m.clobTokenIds === "string") { try { clobTokenIds = JSON.parse(m.clobTokenIds); } catch { clobTokenIds = m.clobTokenIds.split(",").map((s: string) => s.trim()); } }
      else if (Array.isArray(m.clobTokenIds)) clobTokenIds = m.clobTokenIds;
    }
    return {
      id, question, conditionId,
      slug: m.slug || "",
      outcomes, outcomePrices, clobTokenIds,
      volume: parseFloat(m.volume) || parseFloat(m.volumeNum) || 0,
      liquidity: parseFloat(m.liquidity) || parseFloat(m.liquidityNum) || 0,
      endDate: m.endDate || m.end_date || m.endDateIso || "",
      active: m.active !== false && m.closed !== true,
      closed: m.closed === true,
      resolved: m.resolved === true || m.resolved === "true" || m.closed === true,
      description: m.description || "",
      category: categorizeMarket(question, m.description || "", m),
    };
  } catch (e) {
    return null;
  }
}

async function fetchAllMarkets(maxTotal = 6000): Promise<PolymarketMarket[]> {
  const PAGE_SIZE = 500;
  const allMarkets: PolymarketMarket[] = [];
  const seenIds = new Set<string>();
  let offset = 0;
  let page = 0;
  const MAX_PAGES = Math.ceil(maxTotal / PAGE_SIZE);
  let consecutiveErrors = 0;

  log(`Fetching markets from Gamma API (max=${maxTotal})...`);

  while (page < MAX_PAGES) {
    try {
      const url = `${GAMMA_API}/markets?limit=${PAGE_SIZE}&offset=${offset}&active=true&closed=false&order=volume&ascending=false&include_tag=true`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!response.ok) {
        consecutiveErrors++;
        if (consecutiveErrors >= 2) break;
        offset += PAGE_SIZE;
        page++;
        await new Promise(r => setTimeout(r, 500));
        continue;
      }

      consecutiveErrors = 0;
      const data = await response.json();
      if (!Array.isArray(data) || data.length === 0) break;

      const parsed = data.map(parseMarket).filter(Boolean) as PolymarketMarket[];
      for (const m of parsed) {
        if (!seenIds.has(m.id)) {
          seenIds.add(m.id);
          allMarkets.push(m);
        }
      }

      if (data.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
      page++;
      if (page < MAX_PAGES) await new Promise(r => setTimeout(r, 100));
    } catch (error: any) {
      consecutiveErrors++;
      if (consecutiveErrors >= 2) break;
      offset += PAGE_SIZE;
      page++;
      await new Promise(r => setTimeout(r, 500));
    }
  }

  log(`Fetched ${allMarkets.length} markets (${page + 1} pages)`);
  return allMarkets;
}

// ─── Pool Building ───────────────────────────────────

function classifyMarketCategory(market: PolymarketMarket): string {
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

function buildShortTermPool(
  allMarkets: PolymarketMarket[],
  openOrderMarketIds: Set<string>,
  now: number,
  bankroll: number,
): { pool: PolymarketMarket[]; breakdown: any } {
  const bd: any = {
    total: allMarkets.length, noEndDate: 0, expired: 0, resolved: 0,
    tooFarOut: 0, junk: 0, sports: 0, crypto: 0, stocks: 0,
    duplicateOpen: 0, lowLiquidity: 0, wideSpread: 0, passed: 0,
    filterLevel: 0, filterLabel: FILTER_LEVEL_LABELS[0],
  };

  const clean: PolymarketMarket[] = [];
  const cryptoBucket: PolymarketMarket[] = [];
  const stocksBucket: PolymarketMarket[] = [];

  for (const m of allMarkets) {
    if (!m.endDate) { bd.noEndDate++; continue; }
    const endTime = new Date(m.endDate).getTime();
    const timeLeft = endTime - now;
    if (timeLeft <= 0) { bd.expired++; continue; }
    if (m.resolved || !m.active) { bd.resolved++; continue; }
    if (timeLeft > MAX_EXPIRY_MS) { bd.tooFarOut++; continue; }
    if (timeLeft <= 10 * 60 * 1000) { bd.expired++; continue; } // ≤10 min auto-reject

    const q = m.question.toLowerCase();
    const isWeatherMarket = WEATHER_RE.test(q) && timeLeft > 12 * 60 * 60 * 1000;
    const dynamicMinLiq = computeMinLiquidity(bankroll);
    const minLiq = isWeatherMarket ? WEATHER_MIN_LIQUIDITY : dynamicMinLiq;
    const minVol = isWeatherMarket ? WEATHER_MIN_VOLUME : MIN_VOLUME;
    if (m.liquidity < minLiq || m.volume < minVol) { bd.lowLiquidity++; continue; }

    if (!isWeatherMarket) {
      const estSpread = estimateSpread(m.liquidity);
      if (estSpread > MAX_SPREAD) { bd.wideSpread++; continue; }
    }

    const yp = parseFloat(m.outcomePrices[0] || "0.5");
    if (yp <= PRICE_FLOOR || yp >= PRICE_CEILING) { bd.junk++; continue; }

    if (JUNK_PATTERNS.some(j => q.includes(j))) { bd.junk++; continue; }
    if (JUNK_REGEXES.some(r => r.test(q))) { bd.junk++; continue; }
    if (openOrderMarketIds.has(m.id)) { bd.duplicateOpen++; continue; }

    if (m.category === 'sports') { bd.sports++; continue; }
    else if (cryptoPatterns.some(p => q.includes(p))) cryptoBucket.push(m);
    else if (stockPatterns.some(p => q.includes(p))) stocksBucket.push(m);
    else clean.push(m);
  }

  bd.crypto = cryptoBucket.length;
  bd.stocks = stocksBucket.length;

  const pool = [...clean];
  let level = 0;
  if (pool.length < MIN_POOL_TARGET && cryptoBucket.length > 0) {
    pool.push(...cryptoBucket); bd.crypto = 0; level = 1;
  }
  if (pool.length < MIN_POOL_TARGET && stocksBucket.length > 0) {
    pool.push(...stocksBucket); bd.stocks = 0; level = 2;
  }

  bd.filterLevel = level;
  bd.filterLabel = FILTER_LEVEL_LABELS[level] || "???";
  bd.passed = pool.length;
  pool.sort((a, b) => b.volume - a.volume);
  return { pool, breakdown: bd };
}

function diversifyPool(markets: PolymarketMarket[], maxSize: number): PolymarketMarket[] {
  const buckets = new Map<string, PolymarketMarket[]>();
  for (const m of markets) {
    const cat = classifyMarketCategory(m);
    if (!buckets.has(cat)) buckets.set(cat, []);
    buckets.get(cat)!.push(m);
  }
  for (const [, arr] of buckets) arr.sort((a, b) => b.volume - a.volume);
  for (const [cat, arr] of buckets) {
    const cap = MAX_PER_CATEGORY[cat] ?? DEFAULT_CAT_CAP;
    if (arr.length > cap) arr.length = cap;
  }
  const categories = CATEGORY_PRIORITY.filter(c => buckets.has(c));
  for (const c of buckets.keys()) if (!categories.includes(c)) categories.push(c);

  const result: PolymarketMarket[] = [];
  let round = 0;
  while (result.length < maxSize) {
    let added = false;
    for (const cat of categories) {
      const arr = buckets.get(cat)!;
      if (round < arr.length) { result.push(arr[round]); added = true; if (result.length >= maxSize) break; }
    }
    if (!added) break;
    round++;
  }
  return result;
}

// ─── Claude OSINT Prompt ─────────────────────────────

function buildOSINTPrompt(
  shortTermMarkets: PolymarketMarket[],
  openOrders: PaperOrder[],
  bankroll: number,
  history?: { totalTrades: number; wins: number; losses: number; totalPnl: number; winRate: number },
): string {
  const now = new Date();
  const activeOrders = openOrders.filter(o => {
    const priceCents = Math.round(o.price * 100);
    return priceCents > 0 && priceCents < 100;
  });
  const blacklist = activeOrders.length > 0
    ? activeOrders.map(o => `  - [ID:${o.marketId}] "${o.marketQuestion.slice(0, 100)}" → ${o.outcome} @ ${(o.price * 100).toFixed(0)}¢`).join("\n")
    : "  (none)";

  const liqStr = (liq: number) => liq >= 1_000 ? `$${(liq / 1_000).toFixed(0)}K` : `$${liq.toFixed(0)}`;
  const marketLines = shortTermMarkets.map((m, i) => {
    const prices = m.outcomePrices.map(p => parseFloat(p));
    const endTime = new Date(m.endDate).getTime();
    const minLeft = Math.max(0, Math.round((endTime - now.getTime()) / 60000));
    const hoursLeft = (minLeft / 60).toFixed(1);
    const volStr = m.volume >= 1_000_000 ? `$${(m.volume / 1_000_000).toFixed(1)}M`
      : m.volume >= 1_000 ? `$${(m.volume / 1_000).toFixed(0)}K` : `$${m.volume.toFixed(0)}`;
    const spread = estimateSpread(m.liquidity);
    const spreadStr = `~${(spread * 100).toFixed(1)}%`;
    return `[${i + 1}] "${m.question}" | YES=${(prices[0] * 100).toFixed(0)}¢ NO=${(prices[1] * 100).toFixed(0)}¢ | Vol=${volStr} | Liq=${liqStr(m.liquidity)} | Spread=${spreadStr} | Expires: ${hoursLeft}h (${minLeft}min) | ID:${m.id}`;
  }).join("\n");

  const historyLine = history && history.totalTrades > 0
    ? `HISTORY: {"trades": ${history.totalTrades}, "wins": ${history.wins}, "losses": ${history.losses}, "winRate": ${(history.winRate / 100).toFixed(2)}, "roi": ${history.totalPnl !== 0 ? (history.totalPnl / 100).toFixed(3) : "0.000"}, "pnl": ${history.totalPnl.toFixed(2)}}\n  → ${history.winRate >= 55 ? "Calibration OK — maintain discipline." : history.winRate >= 45 ? "Marginal — tighten confidence thresholds, require stronger edge." : "Poor — be MORE conservative, raise minimum confidence to 70, minimum edge to 0.12."}`
    : "HISTORY: No resolved trades yet — be conservative, require strong evidence.";

  return `Polymarket mispricing scanner. Deep-analyze ${shortTermMarkets.length} markets using web_search. Find where public data disagrees with market prices.

UTC: ${now.toISOString()} | BANKROLL: $${bankroll.toFixed(2)} | ${historyLine}

═══ DEEP RESEARCH — ANALYZE ALL ${shortTermMarkets.length} MARKETS ═══
You have ONLY ${shortTermMarkets.length} markets. Research EVERY SINGLE ONE thoroughly with web_search.
Use as many web_search calls as you need per market — there is NO limit. Do a THOROUGH job.
For each market:
  1. Search for the most relevant, recent data (forecasts, polls, official results, news)
  2. If first search isn't conclusive, search AGAIN with different terms
  3. Compute pReal based on the data you found
  4. Decide: recommend (if edge exists) or skip (explain why with data)

GOAL: Quality over speed. You have few markets — analyze each one deeply. Multiple searches per market = GOOD.

CATEGORY SEARCH TIPS:
- Weather: Search official forecast for the SPECIFIC city + date. Use NWS (US), Met Office (UK), EnvCanada, KMA (Korea), etc.
  If first search fails, try AccuWeather, Weather.com, or TimeAndDate as fallback.
- Politics/polls: RealClearPolitics, FiveThirtyEight, 270toWin, official statements.
- Entertainment/Netflix: FlixPatrol, Netflix Top 10, Box Office Mojo, Deadline. If no official ranking yet, use FlixPatrol but cap confidence ≤ 65.
- Finance/Stocks: analyst consensus, recent price action, options flow. Cap confidence ≤ 55 without dated catalyst.
- Legal/SCOTUS: see LEGAL METHOD below.

WEATHER ANTI-EXCUSE RULE:
  For ANY city (pop > 100K): official forecasts ALWAYS EXIST. NO EXCUSES.
  FORBIDDEN phrases: "no specific forecast data", "no exact forecast", "no forecast data found",
    "insufficient forecast data", "insufficient weather data", "no weather data",
    "unable to find forecast", "no data available".
  Use official source (NWS/Met Office/EnvCanada/etc.) → if fails, use AccuWeather or Weather.com (cap conf ≤ 65).

WEATHER SEARCH PROTOCOL (mandatory per country):
  US: "NWS point forecast [city] [date]" → weather.gov. If no explicit High, use "Hourly Weather Forecast" and take daily max.
  UK: "Met Office [city] forecast [date]"
  Canada: "Environment Canada [city] forecast [date]"
  South Korea: "KMA [city] forecast [date]" or "기상청 [city] 예보"
  New Zealand: "MetService [city] forecast [date]"
  Australia: "BOM [city] forecast [date]"
  Argentina: "SMN [city] pronóstico [date]"
  Mexico: "SMN México [city] pronóstico [date]"
  Turkey: "MGM [city] tahmin [date]"
  France: "Météo-France [city] prévisions [date]"
  Brazil: "INMET [city] previsão [date]"
  Other: search "[national weather agency] [city] forecast [date]"
  FALLBACK: If official source fails, allow 1 official + 1 secondary (AccuWeather/Windy/Weather.com/TimeAndDate).

WEATHER METHOD — deriving probability from forecasts (MANDATORY — DO NOT skip weather markets):
  You do NOT need an "exact X° forecast". You need the forecast HIGH (or hourly max) and then DERIVE probability.
  1. Get the forecast HIGH (or hourly max for the target day) = μ (mean expected).
  2. Determine uncertainty σ by forecast horizon:
     <24h: σ ≈ 2°F (≈1.1°C)
     24–48h: σ ≈ 3°F (≈1.7°C)
     48–72h: σ ≈ 4°F (≈2.2°C)
     >72h: σ ≈ 5°F (≈2.8°C)
  3. For market types, compute pReal:
     "exactly X°C" → bin [X-0.5, X+0.5]. pReal ≈ P(temp in bin).
     "X–Y°F" (2°F bin) → bin [X, Y]. pReal = Φ((Y-μ)/σ) − Φ((X-μ)/σ).
     "≥T" → pReal = Φ((μ-T)/σ). If μ is 5°F above T → ~0.95. If μ is 2°F below T → ~0.15.
     "≤T" → pReal = Φ((T-μ)/σ).
     Quick reference (|X-μ| in σ units): 0σ→~0.40 per 1°F bin, 1σ→~0.24, 2σ→~0.05, 3σ→~0.01.
  4. NARROW BIN EDGE RULE: For 1°F/1°C bins where YES price is 10¢-40¢, only recommend if forecast μ is >6°F/3°C away from the bin (bet NO). Otherwise too noisy — skip.
  5. Your pReal MUST be consistent with μ, σ, and the bin. Show the math briefly.
  6. NEVER say "exact temperature markets too risky" or "forecast X, exact hit unlikely" — ALWAYS compute the bin probability using the formula above.

LEGAL / SCOTUS METHOD — for "Will the Supreme Court rule on X by [date]?" markets:
  The Supreme Court does NOT pre-announce which opinions come on which day. SCOTUS has ~60 argued cases per term and ~25-30 opinion days (Oct–June). Key rules:
  1. CHECK the docket: search "scotusblog [case name]" or "supremecourt.gov docket [case number]". Determine: (a) Has the case been ARGUED? (b) When was oral argument? (c) Has an opinion already been issued?
  2. If not argued yet → probability of ruling by date is near 0%.
  3. If argued but no opinion yet → estimate probability based on:
     - Average opinion time: 3-6 months after argument. Median ~4 months.
     - Big controversial cases (multiple opinions/concurrences/dissents) tend to come LATER in the term (May-June).
     - Is the Court even in session? Winter recess = mid-Dec through mid-Feb. Summer recess = July onward.
     - Count remaining opinion days between now and the target date.
     - P(ruling on specific single day) ≈ 1/(remaining opinion days in term) for typical cases.
     - P(ruling BY date) ≈ (opinion days between now and target date) / (remaining opinion days in term), adjusted for case complexity.
  4. NEVER set pReal > 50% for "by [specific date]" unless the opinion day is the LAST of the term or there is concrete evidence (e.g., court has already announced the opinion for that day, or there are very few cases left).
  5. "Case exists + opinion day exists" ≠ high probability. The market at 10-20% is often correctly priced for these.
  Example: Tariffs case argued Nov 5, 2025. By Feb 20, 2026 (~3.5 months, first opinion day after winter recess). ~25 opinion days remain. Only 1 opinion day before target. pReal ≈ 15-25%, NOT 85%.

BLACKLIST (already own): ${blacklist}

MARKETS (${shortTermMarkets.length}):
${marketLines}

PROCESS: Research ALL ${shortTermMarkets.length} markets using web_search. No limit on searches — be thorough. For each market, search → analyze → decide (recommend or skip with data-backed reason).

MATH:
  ┌─────────────────────────────────────────────────────────────────────┐
  │ pReal = ALWAYS P(YES outcome happens).                             │
  │ NOT "probability my bet is correct". NOT "probability of the side  │
  │ I recommend". ALWAYS P(YES).                                       │
  │                                                                    │
  │ EXAMPLE: "Seoul ≥12°C?" forecast 6°C → pReal ≈ 0.001 (YES is     │
  │ nearly impossible), side=NO. Do NOT set pReal=0.85 thinking        │
  │ "I'm 85% sure NO wins" — that's the WRONG number.                 │
  │                                                                    │
  │ SELF-CHECK before outputting each recommendation:                  │
  │   • If side=YES → pReal MUST be > pMarket (you think YES is       │
  │     underpriced). If pReal < pMarket, you have a contradiction.   │
  │   • If side=NO → pReal MUST be < pMarket (you think YES is        │
  │     overpriced). If pReal > pMarket, you have a contradiction.    │
  │   • edge = |pReal - pMarket|. If edge > 0.40, your pReal is WRONG.│
  │     Go back and fix it.                                            │
  └─────────────────────────────────────────────────────────────────────┘
  pMarket = YES price shown above.
  edge = |pReal - pMarket| (must be ≥ minEdge for that market).
  minEdge = max(0.06, spread + 0.04). Ejemplo: spread 8% → minEdge 12%. spread 3% → minEdge 7%. spread 15% → minEdge 19%.
  If side=YES: you're betting pReal > pMarket. If side=NO: you're betting pReal < pMarket.
  friction = USE THE Spread SHOWN for each market. Near-expiry(<30min): add +2%.
  Weather with horizon>12h: use LIMIT orders.
  evNet = edge - friction (must be >0)
  kelly = (pReal*b - q)/b where b=(1/price-1), q=1-pReal. Size = kelly*0.50*bankroll. Cap $${(bankroll * 0.1).toFixed(2)}. Min $2.
  Confidence ≥60 required. <2 sources → confidence ≤40 → skip.
  LOW VOLUME RULE: if Vol < $3K, cap confidence at 65 max (price more easily manipulated) unless you have direct primary-source data (official government data, NWS forecast, etc.).
  WEATHER: Use the WEATHER METHOD above to derive pReal from forecast. ALWAYS compute bin probability — do NOT skip weather markets saying "no specific forecast data", "exact temperature too risky", or "spread too wide for confidence". Derive pReal from forecast HIGH + uncertainty σ and let the math decide.
  CLUSTER RULE: Max 1 recommendation per cluster. A cluster = markets about the SAME CITY and SAME METRIC that are mutually exclusive (e.g. "NYC 41°F" and "NYC 42-43°F" are the same cluster because they're both NYC high temp). But "NYC 42°F" and "Miami 72°F" are DIFFERENT clusters — different cities are NEVER the same cluster. "Seoul 3°C" and "Ankara 12°C" are DIFFERENT clusters. You can recommend one market from NYC AND one from Miami AND one from Seoul — they are independent events.
  Price must be 5¢-95¢.

CRITICAL RULES:
  - DO NOT HALLUCINATE. Every factual claim in your reasoning MUST come from a web_search you performed in this session. If you didn't search for it, you don't know it. Say "insufficient data" rather than inventing numbers.
  - NEVER say "already resolved" or "actual result was $X" unless you opened a source URL in THIS session with web_search AND the source explicitly shows the exact number. If you cannot cite a URL you opened, the data is imaginary.
  - EVEN WITH web_search: Be EXTREMELY careful with box office numbers. "Opening weekend" = Friday-Sunday (3 days), NOT 4-day holiday weekends. If a source says "$17.7M 4-day" but the market says "opening weekend", the 3-day number is what matters. DOUBLE-CHECK the exact number format the market uses vs what your source reports.
  - RESOLUTION CLAIM GUARD: If you believe a market is "already resolved", your pReal should STILL reflect uncertainty about resolution criteria interpretation. Cap pReal at 0.80 max for "resolved" markets and cap edge at 0.40 max. Markets that seem too good to be true usually are.
  - EDGE HARD CAP: edge > 0.40 (40%) is ALWAYS wrong. If your math gives edge > 40%, STOP — your pReal is incorrect. Go back, re-derive pReal closer to pMarket. Real prediction market edges are 5-25%.
  - SIDE-PREAL COHERENCE (mandatory check per recommendation):
      If side=YES and pReal < pMarket → CONTRADICTION. You think YES is MORE likely but your pReal says it's LESS likely than market. Fix pReal or flip side.
      If side=NO and pReal > pMarket → CONTRADICTION. You think YES is LESS likely but your pReal says it's MORE likely than market. Fix pReal or flip side.
      This check catches the #1 most common error: confusing P(YES) with P(my bet wins).
  - PREAL ANCHOR: Before setting pReal, ask "Does the market price already reflect what most people know?" If yes, your pReal should be close to pMarket (within ±15%). Only deviate significantly (>20% from pMarket) if you found NEW information via web_search that the market has not yet priced in.
  - NEVER skip a weather market with any variation of "no data"/"insufficient data"/"no forecast". Use the WEATHER METHOD with forecast HIGH + σ.
  - For entertainment/box office: only claim resolved if you found the actual data via web_search with a URL AND the number EXACTLY matches the market's criteria (3-day vs 4-day, domestic vs worldwide, etc.).
  - Netflix/streaming: if no official ranking yet, use FlixPatrol but cap confidence ≤ 65, require 2 signals (position + trend).
  - Stocks "Up/Down": cap confidence ≤ 55 without dated catalyst.
  - You MUST research ALL ${shortTermMarkets.length} markets with web_search. Do NOT skip any market without searching first.
  - GOAL: Find profitable bets based on REAL DATA from web searches, not guesses. The user needs actionable recommendations grounded in evidence.

OUTPUT: Raw JSON only, no code fence.
{
  "summary": "1-2 lines",
  "skipped": [
    {"marketId": "ID", "question": "short", "reason": "brief why (no edge, low confidence, insufficient data, price already fair, etc.)"}
  ],
  "recommendations": [
    {
      "marketId": "ID from market list",
      "question": "exact question",
      "category": "weather|politics|geopolitics|entertainment|finance|crypto|other",
      "clusterId": "cluster-id|null",
      "pMarket": 0.00, "pReal": 0.00, "pLow": 0.00, "pHigh": 0.00,
      "edge": 0.00, "friction": 0.00, "evNet": 0.00,
      "confidence": 0,
      "recommendedSide": "YES|NO",
      "maxEntryPrice": 0.00, "sizeUsd": 0.00, "orderType": "LIMIT",
      "reasoning": "3-5 lines with data + logic",
      "sources": ["Source - YYYY-MM-DD - URL"],
      "risks": "1-2 lines",
      "resolutionCriteria": "how it resolves",
      "expiresInMin": 0, "liqUsd": 0, "volUsd": 0,
      "executionNotes": "spread/timing notes"
    }
  ]
}
IMPORTANT: Always include "skipped" array listing ALL markets you did NOT recommend, with a brief reason each.
If nothing qualifies: {"summary":"reason","skipped":[...],"recommendations":[]}

═══ MANDATORY FINAL STEP ═══
Before outputting the JSON, verify EACH recommendation:
  1. pReal = P(YES happens). NOT P(my bet wins). Check: does the number make sense as "chance YES occurs"?
  2. If side=YES → pReal > pMarket. If side=NO → pReal < pMarket. Any contradiction = FIX NOW.
  3. edge = |pReal - pMarket| ≤ 0.40. If violated, reduce pReal toward pMarket.
Then output the JSON IMMEDIATELY. No commentary after searches — go STRAIGHT to JSON.
Never finish your response without the complete JSON output. The JSON is the ONLY thing that matters.
If you run out of searches, use the data you already have. ALWAYS output JSON.`;
}

// ─── Gemini-Specific OSINT Prompt (forces Google Search grounding) ────

const GEMINI_SYSTEM_INSTRUCTION = `You are an expert prediction market analyst with access to Google Search.
You are a SKEPTICAL, CONSERVATIVE analyst. Your job is to REJECT most markets, not approve them.

CRITICAL REQUIREMENTS:
1. You MUST use Google Search for EVERY SINGLE market you analyze. No exceptions.
2. You MUST be EXTREMELY SKEPTICAL. Most markets are efficiently priced — the market price is usually correct.
3. Only recommend a bet when you find STRONG, CONCRETE evidence from multiple sources that the market is significantly mispriced.
4. Your DEFAULT should be to SKIP a market. Recommending a bet is the EXCEPTION, not the rule.
5. Only recommend when you find STRONG evidence from MULTIPLE sources that contradicts the market price.

SKEPTICISM RULES:
- If you can’t find at least 2 independent, dated sources that contradict the market price → SKIP.
- If the market price is within 10% of your estimated probability → SKIP (the market already knows).
- edges > 25% are almost ALWAYS wrong. Real edges in prediction markets are 5-15%.
- Confidence above 85 requires EXTRAORDINARY evidence (official government data, verified results, etc.).
- "I think" or "it seems likely" is NOT evidence. Only cite specific data points from your Google searches.
- If you’re not sure, SKIP. A missed opportunity costs nothing. A bad bet costs real money.
- NEVER analyze a market based only on your training data. ALWAYS ground your analysis in fresh search results.
- ALWAYS output the full JSON response. NEVER stop before outputting the JSON.`;

function buildGeminiOSINTPrompt(
  shortTermMarkets: PolymarketMarket[],
  openOrders: PaperOrder[],
  bankroll: number,
  history?: { totalTrades: number; wins: number; losses: number; totalPnl: number; winRate: number },
): string {
  // Take the base OSINT prompt and adapt it for Gemini
  let prompt = buildOSINTPrompt(shortTermMarkets, openOrders, bankroll, history);

  // Replace Claude-specific "web_search" references with Gemini-compatible language
  prompt = prompt.replace(
    /Deep-analyze \d+ markets using web_search\./,
    `Deep-analyze ${shortTermMarkets.length} markets using Google Search. You MUST search the web for EVERY market.`
  );
  prompt = prompt.replaceAll('using web_search', 'using Google Search');
  prompt = prompt.replaceAll('with web_search', 'with Google Search');
  prompt = prompt.replaceAll('web_search', 'Google Search');

  // Add Gemini-specific grounding reinforcement at the top
  const geminiHeader = `🔍 GOOGLE SEARCH GROUNDING MODE — You MUST search the internet for each market below.
Do NOT rely on training data alone. For each market, perform at least one Google Search to find current data.
If you analyze a market without searching first, the analysis is INVALID and will be rejected.

⚠️ SKEPTICISM MANDATE: You are being OVER-CONFIDENT in your recommendations.
Most prediction markets are EFFICIENTLY PRICED. The crowd is usually right.
Your job is to find the RARE cases where the crowd is wrong — and skip everything else.
- REQUIRE: At least 2 concrete, dated sources that CONTRADICT the current market price.
- If your pReal is within 10% of pMarket → the market is fairly priced → SKIP.
- If edge > 25%, your pReal is almost certainly wrong. Recalibrate closer to pMarket.
- Confidence 90+ should be RARE (maybe 1 in 20 recommendations). If you’re giving 90 to everything, you’re broken.
- ASK YOURSELF: "What do I know from my Google searches that the thousands of traders who set this price do NOT know?" If the answer is "nothing" → SKIP.

`;

  return geminiHeader + prompt;
}

// ─── Claude API Call (Direct) ────────────────────────

function extractJSON(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) { try { JSON.parse(trimmed); return trimmed; } catch { /* */ } }
  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) { const inner = fenceMatch[1].trim(); try { JSON.parse(inner); return inner; } catch { /* */ } }
  const firstBrace = raw.indexOf("{");
  if (firstBrace >= 0) {
    let depth = 0, lastBrace = -1;
    for (let i = firstBrace; i < raw.length; i++) {
      if (raw[i] === "{") depth++;
      else if (raw[i] === "}") { depth--; if (depth === 0) { lastBrace = i; break; } }
    }
    if (lastBrace > firstBrace) {
      const candidate = raw.substring(firstBrace, lastBrace + 1);
      try {
        const obj = JSON.parse(candidate);
        if (obj.summary !== undefined || obj.recommendations !== undefined) return candidate;
      } catch { /* */ }
    }
  }
  return trimmed;
}

async function callClaudeAPI(
  batch: PolymarketMarket[],
  openOrders: PaperOrder[],
  bankroll: number,
  model: string,
  history?: { totalTrades: number; wins: number; losses: number; totalPnl: number; winRate: number },
): Promise<{
  analyses: MarketAnalysis[];
  skipped: SkippedMarket[];
  usage: { inputTokens: number; outputTokens: number; costUsd: number; model: string };
  summary: string;
  prompt: string;
  rawResponse: string;
  responseTimeMs: number;
  webSearches: number;
  searchQueries: string[];
}> {
  if (batch.length === 0) {
    return { analyses: [], skipped: [], usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, model }, summary: "Empty batch", prompt: "", rawResponse: "", responseTimeMs: 0, webSearches: 0, searchQueries: [] };
  }

  const prompt = buildOSINTPrompt(batch, openOrders, bankroll, history);
  const startTime = Date.now();

  // Call Anthropic API directly (no proxy needed — we have the API key)
  const response = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": CLAUDE_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 16384,
      temperature: 0.3,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Claude API HTTP ${response.status}: ${errorBody.slice(0, 300)}`);
  }

  const data = await response.json();
  const elapsed = Date.now() - startTime;
  const inputTokens = data.usage?.input_tokens || 0;
  const outputTokens = data.usage?.output_tokens || 0;
  const costUsd = calculateTokenCost(inputTokens, outputTokens, model);

  // Extract text from response blocks
  const contentBlocks: any[] = data.content || [];
  const textBlocks = contentBlocks.filter((b: any) => b.type === "text");
  const content = textBlocks.map((b: any) => b.text || "").join("\n");

  // Log web searches
  const webSearchUses = contentBlocks.filter((b: any) => b.type === "server_tool_use" && b.name === "web_search");
  const searchQueries: string[] = webSearchUses.map((s: any) => s.input?.query || "?");
  log(`🌐 Web searches: ${webSearchUses.length} performed`);
  searchQueries.forEach((q, i) => log(`   🔍 Search ${i + 1}: "${q}"`));

  // Parse response
  let analyses: MarketAnalysis[] = [];
  let skippedMarkets: SkippedMarket[] = [];
  let summary = "";

  try {
    const jsonStr = extractJSON(content);
    const parsed = JSON.parse(jsonStr);
    summary = parsed.summary || "";

    if (Array.isArray(parsed.skipped)) {
      skippedMarkets = parsed.skipped.map((s: any) => ({
        marketId: s.marketId || "", question: s.question || "", reason: s.reason || "Sin razón",
      }));
    }

    if (Array.isArray(parsed.recommendations)) {
      analyses = parsed.recommendations
        .filter((item: any) => item.recommendedSide && item.recommendedSide.toUpperCase() !== "SKIP")
        .map((item: any) => {
          let side = (item.recommendedSide || "SKIP").toUpperCase();
          let pReal = parseFloat(item.pReal) || 0;
          const pMarket = parseFloat(item.pMarket) || 0;
          let pLow = parseFloat(item.pLow) || 0;
          let pHigh = parseFloat(item.pHigh) || 0;
          // Auto-fix: if side=NO and pReal > 0.50, Claude confused P(recommended) with P(YES)
          if (side === "NO" && pReal > 0.50) {
            pReal = 1 - pReal;
            const origLow = pLow; pLow = 1 - pHigh; pHigh = 1 - origLow;
          }
          // Side-consistency: ensure side aligns with pReal vs pMarket
          if (pMarket > 0.01 && pMarket < 0.99) {
            if (side === "YES" && pReal < pMarket) {
              log(`⚠️ SIDE-FIX: YES but pReal(${pReal.toFixed(3)}) < pMarket(${pMarket.toFixed(3)}) → NO`);
              side = "NO";
            } else if (side === "NO" && pReal > pMarket) {
              log(`⚠️ SIDE-FIX: NO but pReal(${pReal.toFixed(3)}) > pMarket(${pMarket.toFixed(3)}) → YES`);
              side = "YES";
            }
          }
          return {
            marketId: item.marketId || "", question: item.question || "",
            pMarket, pReal, pLow, pHigh, edge: Math.abs(pReal - pMarket),
            confidence: parseInt(item.confidence) || 0, recommendedSide: side,
            reasoning: item.reasoning || "", sources: item.sources || [],
            evNet: parseFloat(item.evNet) || undefined,
            maxEntryPrice: parseFloat(item.maxEntryPrice) || undefined,
            sizeUsd: parseFloat(item.sizeUsd) || undefined,
            orderType: item.orderType || undefined,
            clusterId: item.clusterId || null, risks: item.risks || "",
            resolutionCriteria: item.resolutionCriteria || "",
            category: item.category || undefined,
            friction: parseFloat(item.friction) || undefined,
            expiresInMin: parseInt(item.expiresInMin) || undefined,
            liqUsd: parseFloat(item.liqUsd) || undefined,
            volUsd: parseFloat(item.volUsd) || undefined,
            dataFreshnessScore: parseInt(item.dataFreshnessScore) || undefined,
            executionNotes: item.executionNotes || undefined,
          };
        });
    }

    // Edge guard
    analyses = analyses.filter(a => {
      if (a.edge > MAX_ENRICHED_EDGE) {
        log(`🚫 EDGE GUARD: Rejected "${a.question}" — edge ${(a.edge * 100).toFixed(1)}%`);
        return false;
      }
      return true;
    });
  } catch (parseError) {
    log("⚠️ Error parsing Claude response:", parseError);
  }

  return {
    analyses, skipped: skippedMarkets,
    usage: { inputTokens, outputTokens, costUsd, model },
    summary, prompt, rawResponse: content, responseTimeMs: elapsed,
    webSearches: webSearchUses.length,
    searchQueries,
  };
}

// ─── Multi-Provider AI Router ────────────────────────

async function callAI(
  provider: AIProviderType,
  model: string,
  batch: PolymarketMarket[],
  openOrders: PaperOrder[],
  bankroll: number,
  history?: { totalTrades: number; wins: number; losses: number; totalPnl: number; winRate: number },
) {
  // For Anthropic, use the existing battle-tested function
  if (provider === "anthropic") {
    return callClaudeAPI(batch, openOrders, bankroll, model, history);
  }
  return callGenericProviderAPI(provider, model, batch, openOrders, bankroll, history);
}

async function callGenericProviderAPI(
  provider: AIProviderType,
  model: string,
  batch: PolymarketMarket[],
  openOrders: PaperOrder[],
  bankroll: number,
  history?: { totalTrades: number; wins: number; losses: number; totalPnl: number; winRate: number },
) {
  if (batch.length === 0) {
    return { analyses: [] as MarketAnalysis[], skipped: [] as SkippedMarket[], usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, model }, summary: "Empty batch", prompt: "", rawResponse: "", responseTimeMs: 0, webSearches: 0, searchQueries: [] as string[] };
  }

  const apiKey = getProviderApiKey(provider);
  if (!apiKey) throw new Error(`API key no configurada para ${provider}`);

  // Use Gemini-specific prompt for Google, base prompt for others
  let prompt = provider === "google"
    ? buildGeminiOSINTPrompt(batch, openOrders, bankroll, history)
    : buildOSINTPrompt(batch, openOrders, bankroll, history);

  // Providers without web search get a note
  const noWeb = provider === "deepseek";
  if (noWeb) {
    prompt = "NOTA: Sin acceso a búsqueda web. Usa datos de entrenamiento.\n\n" + prompt;
  }

  const startTime = Date.now();
  let responseData: any;

  if (provider === "google") {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const geminiBody = {
      system_instruction: { parts: [{ text: GEMINI_SYSTEM_INSTRUCTION }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 16384 },
    };
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(geminiBody) });
    if (!res.ok) throw new Error(`Gemini API HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    responseData = await res.json();

    // ─── Detect empty/blocked Gemini responses and retry ───
    const finishReason = responseData.candidates?.[0]?.finishReason || "UNKNOWN";
    const hasContent = (responseData.candidates?.[0]?.content?.parts || []).some((p: any) => p.text?.trim());
    if (!hasContent || finishReason === "SAFETY" || finishReason === "RECITATION") {
      const blockReason = responseData.candidates?.[0]?.safetyRatings
        ?.filter((r: any) => r.probability !== "NEGLIGIBLE" && r.probability !== "LOW")
        ?.map((r: any) => `${r.category}:${r.probability}`)
        ?.join(", ") || "unknown";
      log(`⚠️ Gemini empty response — finishReason=${finishReason}, blockReason=[${blockReason}]`);
      log(`🔄 Retrying Gemini with higher temperature and safety settings...`);

      // Retry with relaxed safety settings
      const retryBody = {
        ...geminiBody,
        generationConfig: { temperature: 0.5, maxOutputTokens: 16384 },
        safetySettings: [
          { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
        ],
      };
      const retryRes = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(retryBody) });
      if (!retryRes.ok) throw new Error(`Gemini retry HTTP ${retryRes.status}: ${(await retryRes.text()).slice(0, 300)}`);
      const retryData = await retryRes.json();
      const retryFinish = retryData.candidates?.[0]?.finishReason || "UNKNOWN";
      const retryHasContent = (retryData.candidates?.[0]?.content?.parts || []).some((p: any) => p.text?.trim());
      if (retryHasContent) {
        log(`✅ Gemini retry succeeded — finishReason=${retryFinish}`);
        responseData = retryData;
      } else {
        log(`❌ Gemini retry also empty — finishReason=${retryFinish}`);
        throw new Error(`Gemini devolvió respuesta vacía (finishReason=${finishReason}, retry=${retryFinish}, safety=[${blockReason}])`);
      }
    }
  } else {
    // OpenAI-compatible (openai, xai, deepseek)
    const urls: Record<string, string> = { openai: "https://api.openai.com/v1/chat/completions", xai: "https://api.x.ai/v1/chat/completions", deepseek: "https://api.deepseek.com/chat/completions" };
    const body: any = { model, messages: [{ role: "user", content: prompt }], temperature: 0.3, max_tokens: 16384 };
    if (provider === "openai") body.tools = [{ type: "web_search_preview", search_context_size: "medium" }];
    if (provider === "xai") body.search = { mode: "auto" };
    const res = await fetch(urls[provider], { method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`${provider} API HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    responseData = await res.json();
  }

  const elapsed = Date.now() - startTime;

  // Parse tokens and content per provider
  let content = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let webSearches = 0;
  let searchQueries: string[] = [];

  if (provider === "google") {
    const parts = responseData.candidates?.[0]?.content?.parts || [];
    content = parts.map((p: any) => p.text || "").join("\n");
    inputTokens = responseData.usageMetadata?.promptTokenCount || 0;
    outputTokens = responseData.usageMetadata?.candidatesTokenCount || 0;
    // Extract grounding metadata (search queries + sources)
    const grounding = responseData.candidates?.[0]?.groundingMetadata;
    searchQueries = grounding?.webSearchQueries || [];
    webSearches = searchQueries.length;
    // Log grounding details
    if (webSearches > 0) {
      log(`🌐 Gemini Google Search grounding: ${webSearches} queries`);
      searchQueries.forEach((q: string, i: number) => log(`   🔍 Search ${i + 1}: "${q}"`));
    } else {
      log(`⚠️ Gemini did NOT use Google Search grounding — response may be based on training data only`);
    }
    // Extract grounding sources if available
    const groundingChunks = grounding?.groundingChunks || [];
    if (groundingChunks.length > 0) {
      log(`   📄 ${groundingChunks.length} grounding sources cited`);
    }
  } else {
    content = responseData.choices?.[0]?.message?.content || "";
    inputTokens = responseData.usage?.prompt_tokens || 0;
    outputTokens = responseData.usage?.completion_tokens || 0;
  }

  const costUsd = calculateTokenCost(inputTokens, outputTokens, model);
  log(`✅ [${provider}/${model}] ${elapsed}ms, ${inputTokens}↓/${outputTokens}↑, $${costUsd.toFixed(4)}`);

  // Parse analysis JSON (reuse same logic as Claude)
  let analyses: MarketAnalysis[] = [];
  let skippedMarkets: SkippedMarket[] = [];
  let summary = "";

  try {
    const jsonStr = extractJSON(content);
    const parsed = JSON.parse(jsonStr);
    summary = parsed.summary || "";
    if (Array.isArray(parsed.skipped)) {
      skippedMarkets = parsed.skipped.map((s: any) => ({ marketId: s.marketId || "", question: s.question || "", reason: s.reason || "Sin razón" }));
    }
    if (Array.isArray(parsed.recommendations)) {
      analyses = parsed.recommendations
        .filter((item: any) => item.recommendedSide && item.recommendedSide.toUpperCase() !== "SKIP")
        .map((item: any) => {
          let side = (item.recommendedSide || "SKIP").toUpperCase();
          let pReal = parseFloat(item.pReal) || 0;
          const pMarket = parseFloat(item.pMarket) || 0;
          let pLow = parseFloat(item.pLow) || 0;
          let pHigh = parseFloat(item.pHigh) || 0;
          if (side === "NO" && pReal > 0.50) { pReal = 1 - pReal; const oL = pLow; pLow = 1 - pHigh; pHigh = 1 - oL; }
          if (pMarket > 0.01 && pMarket < 0.99) {
            if (side === "YES" && pReal < pMarket) side = "NO";
            else if (side === "NO" && pReal > pMarket) side = "YES";
          }
          return {
            marketId: item.marketId || "", question: item.question || "",
            pMarket, pReal, pLow, pHigh, edge: Math.abs(pReal - pMarket),
            confidence: parseInt(item.confidence) || 0, recommendedSide: side,
            reasoning: item.reasoning || "", sources: item.sources || [],
            evNet: parseFloat(item.evNet) || undefined,
            maxEntryPrice: parseFloat(item.maxEntryPrice) || undefined,
            sizeUsd: parseFloat(item.sizeUsd) || undefined,
            orderType: item.orderType || undefined,
            clusterId: item.clusterId || null, risks: item.risks || "",
            resolutionCriteria: item.resolutionCriteria || "",
            category: item.category || undefined,
          };
        });
    }
    analyses = analyses.filter(a => {
      if (a.edge > MAX_ENRICHED_EDGE) { log(`🚫 EDGE GUARD: Rejected "${a.question}" — edge ${(a.edge * 100).toFixed(1)}%`); return false; }
      return true;
    });
  } catch (parseError) {
    log(`⚠️ Error parsing ${provider} response:`, parseError);
  }

  return { analyses, skipped: skippedMarkets, usage: { inputTokens, outputTokens, costUsd, model }, summary, prompt, rawResponse: content, responseTimeMs: elapsed, webSearches, searchQueries };
}

// ─── Provider Config (from bot_kv) ───────────────────

async function getAIProviderConfig(): Promise<{ provider: AIProviderType; model: string }> {
  try {
    const { data } = await supabase.from("bot_kv").select("key, value").in("key", ["ai_provider", "ai_model"]);
    let provider: AIProviderType = "google";  // Default to Google (Anthropic credits depleted)
    let model = DEFAULT_MODEL;
    for (const row of data || []) {
      if (row.key === "ai_provider") provider = row.value as AIProviderType;
      if (row.key === "ai_model") model = row.value;
    }
    // Verify the selected provider has an API key configured
    const apiKey = getProviderApiKey(provider);
    if (!apiKey) {
      log(`⚠️ No API key for provider "${provider}", falling back to google/gemini-2.5-flash`);
      // Try Google as fallback
      const geminiKey = getProviderApiKey("google");
      if (geminiKey) return { provider: "google", model: "gemini-2.5-flash" };
      // Last resort: try any provider with a key
      for (const p of ["openai", "xai", "deepseek", "anthropic"] as AIProviderType[]) {
        if (getProviderApiKey(p)) return { provider: p, model: DEFAULT_MODEL };
      }
    }
    return { provider, model };
  } catch {
    return { provider: "google", model: DEFAULT_MODEL };
  }
}

// ─── Kelly Criterion ─────────────────────────────────

function rawKellyFraction(pReal: number, pMarket: number): number {
  if (pMarket <= 0 || pMarket >= 1) return 0;
  if (pReal <= pMarket) return 0;
  return (pReal - pMarket) / (1 - pMarket);
}

function calculateKellyBet(
  analysis: MarketAnalysis,
  market: PolymarketMarket,
  bankroll: number,
  aiCostForThisBatch: number,
  marketsInBatch: number,
  model: string = DEFAULT_MODEL,
): KellyResult {
  // Provider-specific thresholds
  const isGemini = model.toLowerCase().includes("gemini");
  const minConfidence = isGemini ? GEMINI_MIN_CONFIDENCE : MIN_CONFIDENCE;
  const minEdge = isGemini ? GEMINI_MIN_EDGE_AFTER_COSTS : MIN_EDGE_AFTER_COSTS;
  const maxBetFrac = isGemini ? GEMINI_MAX_BET_FRACTION : MAX_BET_FRACTION;

  const side = analysis.recommendedSide;
  const skipResult: KellyResult = {
    marketId: market.id, question: market.question, edge: 0, rawKelly: 0,
    fractionalKelly: 0, betAmount: 0, outcomeIndex: 0, outcomeName: "Yes",
    price: 0, expectedValue: 0, aiCostPerBet: aiCostForThisBatch / Math.max(1, marketsInBatch),
    confidence: analysis.confidence, reasoning: "SKIP",
  };

  if (side === "SKIP") { skipResult.reasoning = "AI recommends SKIP"; return skipResult; }
  if (bankroll < MIN_BET_USD) { skipResult.reasoning = `Bankroll $${bankroll.toFixed(2)} < mínimo $${MIN_BET_USD}`; return skipResult; }
  if (analysis.confidence < minConfidence) { skipResult.reasoning = `Confidence ${analysis.confidence} < min ${minConfidence}`; return skipResult; }

  const checkPrices = market.outcomePrices.map(p => parseFloat(p));
  const targetPrice = side === "YES" ? (checkPrices[0] || 0.5) : (checkPrices[1] || 0.5);
  if (targetPrice < MIN_MARKET_PRICE) { skipResult.reasoning = `Precio ${(targetPrice * 100).toFixed(1)}¢ < mínimo`; return skipResult; }
  if (targetPrice > MAX_MARKET_PRICE) { skipResult.reasoning = `Precio ${(targetPrice * 100).toFixed(1)}¢ > máximo`; return skipResult; }

  // Lottery zone gate
  if (targetPrice < LOTTERY_PRICE_THRESHOLD && analysis.confidence < LOTTERY_MIN_CONFIDENCE) {
    skipResult.reasoning = `LOTTERY ZONE: price ${(targetPrice * 100).toFixed(1)}¢ needs confidence ≥ ${LOTTERY_MIN_CONFIDENCE}, got ${analysis.confidence}`;
    return skipResult;
  }

  let pReal: number, pMarket: number, outcomeIndex: number, outcomeName: string;
  const prices = market.outcomePrices.map(p => parseFloat(p));
  const yesPrice = prices[0] || 0.5;
  const noPrice = prices[1] || (1 - yesPrice);

  if (side === "YES") {
    pReal = analysis.pReal; pMarket = yesPrice; outcomeIndex = 0; outcomeName = market.outcomes[0] || "Yes";
  } else {
    pReal = 1 - analysis.pReal; pMarket = noPrice; outcomeIndex = 1; outcomeName = market.outcomes[1] || "No";
  }

  const grossEdge = pReal - pMarket;

  // Narrow bin weather rule
  const NARROW_BIN_RE = /\d+(\.\d+)?\s*°[CF]\s*(to|and|[-–])\s*\d+(\.\d+)?\s*°[CF]/i;
  if (NARROW_BIN_RE.test(market.question)) {
    if (analysis.confidence < 75) { skipResult.edge = grossEdge; skipResult.reasoning = `NARROW BIN: conf ${analysis.confidence} < 75`; return skipResult; }
    if (grossEdge < 0.12) { skipResult.edge = grossEdge; skipResult.reasoning = `NARROW BIN: edge ${(grossEdge * 100).toFixed(1)}% < 12%`; return skipResult; }
  }

  const aiCostPerBet = aiCostForThisBatch / Math.max(1, marketsInBatch);
  const rawKelly = rawKellyFraction(pReal, pMarket);
  const fractional = rawKelly * KELLY_FRACTION;
  const cappedFraction = Math.min(fractional, maxBetFrac);
  let betAmount = bankroll * cappedFraction;

  // Lottery position cap
  if (pMarket < LOTTERY_PRICE_THRESHOLD) {
    const lotteryMax = bankroll * LOTTERY_MAX_BET_FRACTION;
    if (betAmount > lotteryMax) betAmount = lotteryMax;
  }

  if (betAmount < MIN_BET_USD) { skipResult.edge = grossEdge; skipResult.rawKelly = rawKelly; skipResult.reasoning = `Bet $${betAmount.toFixed(2)} < min $${MIN_BET_USD}`; return skipResult; }

  const netEdge = grossEdge - (aiCostPerBet / betAmount);
  if (netEdge < minEdge) { skipResult.edge = grossEdge; skipResult.rawKelly = rawKelly; skipResult.reasoning = `Net edge ${(netEdge * 100).toFixed(1)}% < ${(minEdge * 100).toFixed(1)}%`; return skipResult; }

  const expectedReturnPct = (1 - pMarket) / pMarket;
  if (expectedReturnPct < MIN_RETURN_PCT) { skipResult.edge = grossEdge; skipResult.rawKelly = rawKelly; skipResult.reasoning = `Return ${(expectedReturnPct * 100).toFixed(1)}% < ${(MIN_RETURN_PCT * 100)}%`; return skipResult; }

  betAmount = Math.min(betAmount, bankroll * maxBetFrac);
  betAmount = Math.floor(betAmount * 100) / 100;

  const expectedWin = betAmount * ((1 - pMarket) / pMarket);
  const expectedValue = (pReal * expectedWin) - ((1 - pReal) * betAmount) - aiCostPerBet;

  return {
    marketId: market.id, question: market.question, edge: grossEdge,
    rawKelly, fractionalKelly: cappedFraction, betAmount,
    outcomeIndex, outcomeName, price: pMarket, expectedValue,
    aiCostPerBet, confidence: analysis.confidence,
    reasoning: `Edge ${(grossEdge * 100).toFixed(1)}% | Kelly ${(cappedFraction * 100).toFixed(1)}% | EV $${expectedValue.toFixed(3)}`,
  };
}

// ─── Paper Order Creation ────────────────────────────

function createPaperOrder(
  market: PolymarketMarket,
  outcomeIndex: number,
  side: string,
  quantity: number,
  portfolio: Portfolio,
): { order: PaperOrder | null; portfolio: Portfolio; error?: string } {
  const price = parseFloat(market.outcomePrices[outcomeIndex]);
  if (price < 0.03) return { order: null, portfolio, error: `Precio ${(price * 100).toFixed(1)}¢ demasiado bajo` };
  const totalCost = quantity * price;
  if (totalCost > portfolio.balance) {
    return { order: null, portfolio, error: `Cash insuficiente: need $${totalCost.toFixed(2)}, have $${portfolio.balance.toFixed(2)}` };
  }

  const order: PaperOrder = {
    id: generateOrderId(),
    marketId: market.id,
    conditionId: market.conditionId,
    marketQuestion: market.question,
    marketSlug: market.slug,
    outcome: market.outcomes[outcomeIndex],
    outcomeIndex, side, price, quantity, totalCost,
    potentialPayout: quantity,
    status: "filled",
    createdAt: new Date().toISOString(),
    endDate: market.endDate || "",
  };

  const updatedPortfolio: Portfolio = {
    ...portfolio,
    balance: portfolio.balance - totalCost,
    openOrders: [...portfolio.openOrders, order],
    lastUpdated: new Date().toISOString(),
  };

  return { order, portfolio: updatedPortfolio };
}

// ─── Cluster Dedup ───────────────────────────────────

function deduplicateCorrelatedMarkets(analyses: MarketAnalysis[]): MarketAnalysis[] {
  if (analyses.length <= 1) return analyses;
  const clusterMap = new Map<string, MarketAnalysis[]>();
  for (const a of analyses) {
    let key = a.clusterId || "";
    if (!key) key = computeBroadClusterKey(a.question);
    if (!key) key = computeClusterKey(a.question);
    if (!key) key = `__unique_${a.marketId}`;
    const group = clusterMap.get(key) || [];
    group.push(a);
    clusterMap.set(key, group);
  }
  const result: MarketAnalysis[] = [];
  for (const [, group] of clusterMap) {
    if (group.length === 1) { result.push(group[0]); continue; }
    group.sort((a, b) => {
      const edgeDiff = Math.abs(b.edge) - Math.abs(a.edge);
      if (Math.abs(edgeDiff) > 0.005) return edgeDiff;
      return b.confidence - a.confidence;
    });
    result.push(group[0]);
    log(`🔗 Cluster dedup: ${group.length} → 1 (kept "${group[0].question.slice(0, 50)}")`);
  }
  return result;
}

// ═══════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const startTs = Date.now();
  const activities: { timestamp: string; message: string; entry_type: string }[] = [];

  function act(msg: string, type = "Info") {
    activities.push({ timestamp: new Date().toISOString(), message: msg, entry_type: type });
  }

  // Helper: resetear analyzing en DB para runs manuales (cualquier salida temprana)
  async function resetManualAnalyzing(errorMsg?: string) {
    if (!isManual) return;
    try {
      const upd: Record<string, unknown> = { analyzing: false, last_cycle_at: new Date().toISOString() };
      if (errorMsg) upd.last_error = errorMsg.slice(0, 500);
      await supabase.from("bot_state").update(upd).eq("id", 1);
    } catch { /* ignore */ }
  }

  // ─── Detectar modo manual y chain mode ────────────────────
  let isManual = false;
  let isChainBatch = false; // true = batch intermedio de cadena, no resetear analyzing al final
  try {
    const body = await req.json();
    isManual = body?.manual === true;
    isChainBatch = body?.chainBatch === true; // Frontend indica que hay más batches por venir
  } catch { /* no body or invalid JSON — automatic mode */ }

  // Si es manual: marcar analyzing=true y limpiar throttle/lock/analyzed_map
  if (isManual) {
    log("🔧 Modo MANUAL activado — limpiando throttle, lock y analyzed_map");
    await supabase.from("bot_state").update({
      analyzing: true,
      last_error: null,
      last_cycle_at: new Date().toISOString(),
    }).eq("id", 1);
    const now = new Date().toISOString();
    await supabase.from("bot_kv").upsert([
      { key: "last_claude_call_time", value: "0", updated_at: now },
      { key: "cycle_lock", value: "0", updated_at: now },
      // Limpiar analyzed_map para que el manual analice TODOS los mercados frescos
      ...(isChainBatch ? [] : [{ key: "analyzed_map", value: "[]", updated_at: now }]),
    ], { onConflict: "key" });
  }

  try {
    log("═══════════════════════════════════════════════");
    log(`🤖 ${isManual ? "MANUAL" : "Autonomous"} Smart Trader Cycle (Edge Function)`);
    log(`UTC: ${new Date().toISOString()}`);

    // ─── Validate env ────────────────────────────
    await loadUserApiKeys(); // Load user API keys from bot_kv before checking provider
    const aiConfig = await getAIProviderConfig();
    const activeApiKey = getProviderApiKey(aiConfig.provider);
    if (!activeApiKey) {
      throw new Error(`No API key for ${aiConfig.provider}. Set it via Settings (web) or Supabase secrets.`);
    }
    log(`🤖 Proveedor: ${aiConfig.provider}, Modelo: ${aiConfig.model}`);

    // ─── Cycle Lock ──────────────────────────────
    if (await checkCycleLock()) {
      log("⚠️ Cycle lock active — skipping (another cycle is running)");
      await resetManualAnalyzing("Cycle lock active");
      return new Response(JSON.stringify({ ok: false, reason: "Cycle lock active" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    await setCycleLock();

    try {
      // ─── Load throttle state from DB ─────────────
      const { lastClaudeCallTime, analyzedMap } = await getThrottleState();
      const now = Date.now();
      const timeSinceLastClaude = now - lastClaudeCallTime;

      // Throttle solo aplica a ciclos automáticos — manual puede correr cuando quiera
      if (!isManual && lastClaudeCallTime > 0 && timeSinceLastClaude < MIN_CLAUDE_INTERVAL_MS) {
        const secsLeft = Math.ceil((MIN_CLAUDE_INTERVAL_MS - timeSinceLastClaude) / 1000);
        const msg = `⏳ Throttle: próximo análisis en ${secsLeft}s (${Math.ceil(MIN_CLAUDE_INTERVAL_MS / 60000)}min mínimo entre auto-ciclos)`;
        log(msg);
        act(msg);
        await dbAddActivitiesBatch(activities);
        return new Response(JSON.stringify({ ok: true, reason: msg, secsLeft }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // ─── Daily auto-cycle limit ────────────────────
      if (!isManual) {
        try {
          const todayStr = new Date().toISOString().slice(0, 10);
          const { count } = await supabase
            .from("cycle_logs")
            .select("id", { count: "exact", head: true })
            .gte("timestamp", `${todayStr}T00:00:00Z`)
            .lte("timestamp", `${todayStr}T23:59:59.999Z`);
          if ((count || 0) >= MAX_AUTO_CYCLES_PER_DAY) {
            const msg = `📊 Límite diario alcanzado: ${count}/${MAX_AUTO_CYCLES_PER_DAY} ciclos auto hoy — esperando mañana`;
            log(msg);
            act(msg);
            await dbAddActivitiesBatch(activities);
            return new Response(JSON.stringify({ ok: true, reason: msg }), {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
          log(`📊 Ciclos auto hoy: ${count || 0}/${MAX_AUTO_CYCLES_PER_DAY}`);
        } catch (e) {
          log("⚠️ Could not check daily cycle count:", e);
        }
      }

      // ─── Load Portfolio ────────────────────────────
      const portfolio = await loadPortfolio();
      log(`💰 Bankroll: $${portfolio.balance.toFixed(2)} (initial: $${portfolio.initialBalance.toFixed(2)})`);

      if (portfolio.balance < MIN_BET_USD) {
        const msg = `🛑 Bankroll $${portfolio.balance.toFixed(2)} < mínimo $${MIN_BET_USD} — skipping cycle`;
        log(msg);
        act(msg, "Warning");
        await dbAddActivitiesBatch(activities);
        await resetManualAnalyzing();
        return new Response(JSON.stringify({ ok: true, reason: msg }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      act(`🤖 Ciclo autónomo iniciado — Bankroll: $${portfolio.balance.toFixed(2)}`);

      // ─── Fetch Markets ─────────────────────────────
      log("📡 Fetching markets from Gamma API...");
      const allMarkets = await fetchAllMarkets(3000);
      if (allMarkets.length === 0) {
        const msg = "❌ Failed to fetch markets from Gamma API (0 results)";
        log(msg);
        act(msg, "Error");
        await dbAddActivitiesBatch(activities);
        await resetManualAnalyzing(msg);
        return new Response(JSON.stringify({ ok: false, reason: msg }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      log(`📊 Total markets fetched: ${allMarkets.length}`);

      // ─── Build Pool ────────────────────────────────
      const openOrderIds = new Set(portfolio.openOrders.map(o => o.marketId));
      const { pool, breakdown } = buildShortTermPool(allMarkets, openOrderIds, now, portfolio.balance);

      // Cluster dedup (local, pre-Claude)
      const clusterGroups = new Map<string, PolymarketMarket[]>();
      for (const m of pool) {
        const key = computeClusterKey(m.question) || `__unique_${m.id}`;
        const group = clusterGroups.get(key) || [];
        group.push(m);
        clusterGroups.set(key, group);
      }
      const dedupedPool: PolymarketMarket[] = [];
      for (const [, group] of clusterGroups) {
        group.sort((a, b) => b.volume - a.volume);
        dedupedPool.push(group[0]);
      }
      pool.length = 0;
      pool.push(...dedupedPool);

      // Broad cluster conflict filter (skip markets that conflict with open orders)
      const openOrderBroadKeys = new Set<string>();
      for (const o of portfolio.openOrders) {
        if (o.status !== "filled" && o.status !== "pending") continue;
        const bk = computeBroadClusterKey(o.marketQuestion);
        if (bk) openOrderBroadKeys.add(bk);
      }
      if (openOrderBroadKeys.size > 0) {
        const filtered = pool.filter(m => {
          const bk = computeBroadClusterKey(m.question);
          return !(bk && openOrderBroadKeys.has(bk));
        });
        pool.length = 0;
        pool.push(...filtered);
      }

      log(`⏱️ Pool: ${pool.length} markets (from ${allMarkets.length}) — Filter: ${breakdown.filterLabel}`);
      act(`⏱️ Pool: ${pool.length} mercados [${breakdown.filterLabel}] (${breakdown.junk} junk, ${breakdown.sports} dep, ${breakdown.lowLiquidity} baja liq)`, "Market");

      if (pool.length === 0) {
        const msg = "⏳ No eligible markets in timeframe. Waiting until next cycle.";
        log(msg);
        act(msg);
        // Save cycle log even for empty pool
        await dbSaveCycleLog({
          timestamp: new Date().toISOString(), totalMarkets: allMarkets.length,
          poolBreakdown: breakdown, shortTermList: [], prompt: "", rawResponse: "",
          model: DEFAULT_MODEL, inputTokens: 0, outputTokens: 0, costUsd: 0,
          responseTimeMs: 0, summary: msg, recommendations: 0, skipped: [],
          results: [], betsPlaced: 0, nextScanSecs: SCAN_INTERVAL_SECS, error: msg,
        });
        await dbAddActivitiesBatch(activities);
        await resetManualAnalyzing();
        return new Response(JSON.stringify({ ok: true, reason: msg }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Filter out recently-analyzed markets
      const freshPool = pool.filter(m => !analyzedMap.has(m.id));
      if (freshPool.length > 0) {
        pool.length = 0;
        pool.push(...freshPool);
      } else if (!isManual) {
        // En modo auto: si ya se analizaron todos los mercados frescos, no re-analizar
        const msg = `✅ Todos los mercados del pool ya fueron analizados hoy (${analyzedMap.size} en caché). Esperando nuevos mercados.`;
        log(msg);
        act(msg);
        await dbAddActivitiesBatch(activities);
        await resetManualAnalyzing();
        return new Response(JSON.stringify({ ok: true, reason: msg, hasMoreMarkets: false }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // ─── Diversify and batch ───────────────────────
      const diversified = diversifyPool(pool, Math.min(pool.length, MAX_ANALYZED_PER_CYCLE));
      const batches: PolymarketMarket[][] = [];
      for (let i = 0; i < diversified.length && batches.length < MAX_BATCHES_PER_CYCLE; i += BATCH_SIZE) {
        batches.push(diversified.slice(i, i + BATCH_SIZE));
      }
      // Calcular cuántos mercados frescos quedan después de este batch
      const remainingFreshMarkets = pool.filter(m => !analyzedMap.has(m.id)).length - diversified.length;
      const hasMoreMarkets = remainingFreshMarkets > 0;
      log(`📦 ${diversified.length} selected → ${batches.length} batch(es) of ≤${BATCH_SIZE} | ${remainingFreshMarkets} fresh markets remaining`);

      // shouldAnalyze cost check
      const batchCount = Math.ceil(diversified.length / 4);
      const estCost = batchCount * 220_000 * (MODEL_PRICING[DEFAULT_MODEL]?.input || 3) / 1_000_000;
      if (estCost > portfolio.balance * 0.05) {
        const msg = `💸 AI cost estimate $${estCost.toFixed(2)} > 5% of bankroll — skipping`;
        log(msg); act(msg, "Warning");
        await dbAddActivitiesBatch(activities);
        await resetManualAnalyzing();
        return new Response(JSON.stringify({ ok: true, reason: msg }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Performance history
      let perfHistory;
      try {
        perfHistory = await dbGetStats();
      } catch (e) {
        log("⚠️ Could not fetch performance history:", e);
      }

      // ─── Multi-batch Claude Analysis Loop ──────────
      let updatedPortfolio = { ...portfolio };
      const betsPlaced: KellyResult[] = [];
      let totalBetsThisCycle = 0;
      let totalRecommendations = 0;
      let totalAICostCycle = 0;
      const debugLog: any = {
        timestamp: new Date().toISOString(), totalMarkets: allMarkets.length,
        poolBreakdown: breakdown, shortTermList: pool.slice(0, 20).map(m => ({
          question: m.question, endDate: m.endDate, volume: m.volume,
          yesPrice: parseFloat(m.outcomePrices[0] || "0.5"),
        })),
        prompt: "", rawResponse: "", model: DEFAULT_MODEL,
        inputTokens: 0, outputTokens: 0, costUsd: 0, responseTimeMs: 0,
        summary: "", recommendations: 0, skipped: [], results: [],
        betsPlaced: 0, nextScanSecs: SCAN_INTERVAL_SECS,
      };

      // Update throttle BEFORE starting batches
      const newAnalyzedMap = new Map(analyzedMap);

      const cycleStartMs = Date.now();

      for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
        // Con 1 batch por invocación no necesitamos safety timeout ni delay
        // El frontend encadena múltiples llamadas independientes
        const batch = batches[batchIdx];
        const batchLabel = `Batch ${batchIdx + 1}/${batches.length}`;
        log(`\n═══ ${batchLabel}: ${batch.length} markets ═══`);
        act(`📡 ${batchLabel}: Enviando ${batch.length} mercados a ${aiConfig.provider}...`, "Inference");

        let aiResult;
        try {
          aiResult = await callAI(aiConfig.provider, aiConfig.model, batch, updatedPortfolio.openOrders, updatedPortfolio.balance, perfHistory);
          totalAICostCycle += aiResult.usage.costUsd;

          if (batchIdx === 0) {
            debugLog.prompt = aiResult.prompt;
            debugLog.rawResponse = aiResult.rawResponse;
          } else {
            debugLog.prompt += `\n\n═══ BATCH ${batchIdx + 1} ═══\n[${batch.length} markets]`;
            debugLog.rawResponse += `\n\n═══ BATCH ${batchIdx + 1} ═══\n${aiResult.rawResponse}`;
          }
          debugLog.inputTokens += aiResult.usage.inputTokens;
          debugLog.outputTokens += aiResult.usage.outputTokens;
          debugLog.costUsd += aiResult.usage.costUsd;
          debugLog.responseTimeMs += aiResult.responseTimeMs;
          debugLog.summary = aiResult.summary;
          debugLog.recommendations += aiResult.analyses.length;
          debugLog.skipped = [...debugLog.skipped, ...aiResult.skipped];
          totalRecommendations += aiResult.analyses.length;

          // Mark batch markets as analyzed
          for (const m of batch) newAnalyzedMap.set(m.id, Date.now());

          // Persist AI cost
          await dbAddAICost({
            inputTokens: aiResult.usage.inputTokens,
            outputTokens: aiResult.usage.outputTokens,
            costUsd: aiResult.usage.costUsd,
            model: DEFAULT_MODEL,
            timestamp: new Date().toISOString(),
            prompt: aiResult.prompt,
            rawResponse: aiResult.rawResponse,
            responseTimeMs: aiResult.responseTimeMs,
            summary: aiResult.summary,
            recommendations: aiResult.analyses.length,
            webSearches: aiResult.webSearches,
            searchQueries: aiResult.searchQueries,
          });

          log(`🔬 ${batchLabel}: ${aiResult.analyses.length} recs — ${formatCost(aiResult.usage.costUsd)} (${aiResult.responseTimeMs}ms)`);
          act(`🔬 ${batchLabel}: ${aiResult.analyses.length} recs — ${formatCost(aiResult.usage.costUsd)}`, "Inference");
        } catch (error: any) {
          const errMsg = error?.message || String(error);
          log(`❌ ${batchLabel} error: ${errMsg}`);
          act(`❌ ${batchLabel}: ${errMsg.slice(0, 100)}`, "Error");
          debugLog.error = errMsg;
          break;
        }

        // Process recommendations
        const dedupedAnalyses = deduplicateCorrelatedMarkets(aiResult.analyses);
        const fullPool = [...pool];

        for (const analysis of dedupedAnalyses) {
          // Find market
          let market = fullPool.find(m => m.id === analysis.marketId);
          if (!market && analysis.question) {
            const normQ = analysis.question.toLowerCase().trim();
            market = fullPool.find(m => m.question.toLowerCase().trim() === normQ);
            if (!market) market = fullPool.find(m =>
              m.question.toLowerCase().includes(normQ.slice(0, 40)) ||
              normQ.includes(m.question.toLowerCase().slice(0, 40))
            );
          }
          if (!market) { log(`  ❌ ID "${analysis.marketId}" not found — SKIP`); continue; }

          // Enrich with real prices
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

          // Edge guard (post-enrichment) — negative edge = side contradicts real price
          if (enrichedAnalysis.edge <= 0) {
            log(`  🚫 NEGATIVE EDGE: side=${analysis.recommendedSide} edge=${(enrichedAnalysis.edge * 100).toFixed(1)}% — direction contradicts real price. SKIP`);
            continue;
          }
          if (enrichedAnalysis.edge > MAX_ENRICHED_EDGE) {
            log(`  🚫 EDGE GUARD (enriched): ${(enrichedAnalysis.edge * 100).toFixed(1)}% > ${(MAX_ENRICHED_EDGE * 100)}%`);
            continue;
          }

          // Hard expiry check
          const endMs = new Date(market.endDate).getTime();
          const msLeft = endMs - now;
          if (msLeft > MAX_EXPIRY_MS) continue;

          // Kelly bet
          const kelly = calculateKellyBet(
            enrichedAnalysis, market, updatedPortfolio.balance,
            aiResult.usage.costUsd, Math.max(1, aiResult.analyses.length),
            DEFAULT_MODEL,
          );
          if (kelly.betAmount <= 0) {
            log(`  ⏭️ SKIP — ${kelly.reasoning}`);
            continue;
          }

          // Place order
          const quantity = kelly.betAmount / kelly.price;
          const { order, portfolio: newPortfolio, error } = createPaperOrder(
            market, kelly.outcomeIndex, "buy", quantity, updatedPortfolio,
          );
          if (error || !order) {
            log(`  ❌ Order failed: ${error}`);
            continue;
          }

          // Save AI reasoning
          order.aiReasoning = {
            claudeAnalysis: {
              pMarket: enrichedAnalysis.pMarket, pReal: analysis.pReal,
              pLow: analysis.pLow, pHigh: analysis.pHigh,
              edge: enrichedAnalysis.edge, confidence: analysis.confidence,
              recommendedSide: analysis.recommendedSide, reasoning: analysis.reasoning,
              sources: analysis.sources || [], evNet: analysis.evNet,
              maxEntryPrice: analysis.maxEntryPrice, sizeUsd: analysis.sizeUsd,
              orderType: analysis.orderType, clusterId: analysis.clusterId,
              risks: analysis.risks, resolutionCriteria: analysis.resolutionCriteria,
            },
            kelly: {
              rawKelly: kelly.rawKelly, fractionalKelly: kelly.fractionalKelly,
              betAmount: kelly.betAmount, expectedValue: kelly.expectedValue,
              aiCostPerBet: kelly.aiCostPerBet,
            },
            model: DEFAULT_MODEL,
            costUsd: aiResult.usage.costUsd / Math.max(1, aiResult.analyses.length),
            timestamp: new Date().toISOString(),
            fullPrompt: aiResult.prompt,
            fullResponse: aiResult.rawResponse,
          };

          // Persist to DB
          await dbCreateOrder(order);
          await dbUpdateOrder({ id: order.id, aiReasoning: order.aiReasoning, status: order.status });

          updatedPortfolio = newPortfolio;
          totalBetsThisCycle++;
          betsPlaced.push(kelly);

          const minutesLeft = Math.max(0, Math.round(msLeft / 60000));
          act(`🎯 APUESTA: ${kelly.outcomeName} "${market.question.slice(0, 40)}..." @ ${(kelly.price * 100).toFixed(0)}¢ | $${kelly.betAmount.toFixed(2)} | Edge ${(enrichedAnalysis.edge * 100).toFixed(1)}% | ⏱️${minutesLeft}min`, "Order");
          log(`  ✅ BET: ${kelly.outcomeName} — $${kelly.betAmount.toFixed(2)} @ ${(kelly.price * 100).toFixed(1)}¢`);
        }
      }

      // ─── Save throttle state ─────────────────────
      // Manual runs: guardar analyzed_map pero NO el timestamp (no bloquea auto cron)
      await saveThrottleState(Date.now(), newAnalyzedMap, isManual);

      // ─── Summary ──────────────────────────────────
      debugLog.betsPlaced = totalBetsThisCycle;
      await dbSaveCycleLog(debugLog);

      if (totalBetsThisCycle === 0) {
        let reason = totalRecommendations === 0
          ? `Claude found no mispricing in ${batches.length} batch(es)`
          : "Kelly rejected all recommendations";
        act(`📭 0 bets from ${totalRecommendations} recs. ${reason}. Cost: ${formatCost(totalAICostCycle)}`);
      } else {
        act(`✅ ${totalBetsThisCycle} bets placed | Balance: $${updatedPortfolio.balance.toFixed(2)} | AI: ${formatCost(totalAICostCycle)}`);
      }

      await dbAddActivitiesBatch(activities);

      // Increment cycle count + update bot_state
      try {
        const { data: bs } = await supabase.from("bot_state").select("cycle_count").eq("id", 1).single();
        const updates: Record<string, unknown> = { cycle_count: (bs?.cycle_count || 0) + 1 };
        if (isManual && !isChainBatch) {
          // Solo resetear analyzing en el último batch de la cadena (o si no es cadena)
          updates.analyzing = false;
          updates.last_error = null;
          updates.last_cycle_at = new Date().toISOString();
        } else if (isManual && isChainBatch) {
          // Batch intermedio: mantener analyzing=true, actualizar timestamp
          updates.last_cycle_at = new Date().toISOString();
        }
        await supabase.from("bot_state").update(updates).eq("id", 1);
      } catch { /* ignore */ }

      const elapsed = Date.now() - startTs;
      log("────────────────────────────────────────────────");
      log(`📋 SUMMARY: ${totalBetsThisCycle} bets / ${totalRecommendations} recs / ${pool.length} in pool`);
      log(`💸 Cycle cost: ${formatCost(totalAICostCycle)} | Time: ${elapsed}ms`);
      if (hasMoreMarkets) log(`🔗 hasMoreMarkets=true — frontend can chain another call`);
      log("────────────────────────────────────────────────");

      return new Response(JSON.stringify({
        ok: true,
        betsPlaced: totalBetsThisCycle,
        recommendations: totalRecommendations,
        poolSize: pool.length,
        totalMarkets: allMarkets.length,
        costUsd: totalAICostCycle,
        elapsedMs: elapsed,
        balance: updatedPortfolio.balance,
        hasMoreMarkets,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });

    } finally {
      await clearCycleLock();
    }

  } catch (error: any) {
    const errMsg = error?.message || String(error);
    log(`❌ FATAL: ${errMsg}`);
    act(`❌ FATAL: ${errMsg.slice(0, 200)}`, "Error");
    await dbAddActivitiesBatch(activities);
    try { await clearCycleLock(); } catch { /* */ }
    // Siempre resetear analyzing en runs manuales (incluyendo chain batches)
    await resetManualAnalyzing(errMsg);
    return new Response(JSON.stringify({ ok: false, error: errMsg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
