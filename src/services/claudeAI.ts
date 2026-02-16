/**
 * Claude AI Service — OSINT Analysis of Short-Term Polymarket Markets
 * 
 * Sends ONLY markets expiring within 1 hour (~30-50 markets, cheap).
 * Claude analyzes those specific markets for mispricing using OSINT.
 * Also sends open orders so Claude doesn't recommend duplicates.
 * 
 * Cost per call: ~1K-2K input tokens + ~1.5K output = ~$0.01-0.03
 */

import { MarketAnalysis, AIUsage, AICostTracker, PaperOrder, PolymarketMarket, defaultAICostTracker } from "../types";
import { dbLoadCostTracker, dbAddAICost, dbResetAICosts } from "./db";
import { estimateSpread } from "./marketConstants";

/** Pre-format a Date as local time string so display never needs timezone conversion */
function localTimestamp(): string {
  // Store as UTC ISO — the frontend converts to UTC-5 for display
  return new Date().toISOString();
}

// ─── Constants ─────────────────────────────────────

// Claude proxy via Supabase Edge Function (no timeout limits like Vercel Hobby)
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_KEY as string;
const CLAUDE_PROXY = `${SUPABASE_URL}/functions/v1/claude-proxy`;

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // Opus family
  "claude-opus-4-6":               { input: 5,    output: 25 },
  "claude-opus-4-5":               { input: 5,    output: 25 },
  "claude-opus-4-20250514":        { input: 15,   output: 75 },
  // Sonnet family
  "claude-sonnet-4-5":             { input: 3,    output: 15 },
  "claude-sonnet-4-5-20250929":    { input: 3,    output: 15 },
  "claude-sonnet-4-20250514":      { input: 3,    output: 15 },
  // Haiku family
  "claude-haiku-4-5":              { input: 1,    output: 5 },
  "claude-haiku-4-5-20251001":     { input: 1,    output: 5 },
  "claude-3-5-haiku-20241022":     { input: 0.80, output: 4 },
  "default":                        { input: 3,    output: 15 },
};

/** Exported model list for UI selector — ordered cheapest to best */
export const CLAUDE_MODELS = [
  { id: "claude-3-5-haiku-20241022",   name: "Claude 3.5 Haiku",   tag: "Más Barato",       inputPrice: 0.80, outputPrice: 4 },
  { id: "claude-haiku-4-5",            name: "Claude Haiku 4.5",   tag: "Rápido",           inputPrice: 1,    outputPrice: 5 },
  { id: "claude-sonnet-4-20250514",    name: "Claude Sonnet 4",    tag: "Económico",        inputPrice: 3,    outputPrice: 15 },
  { id: "claude-sonnet-4-5",           name: "Claude Sonnet 4.5",  tag: "Mejor Valor",      inputPrice: 3,    outputPrice: 15 },
  { id: "claude-opus-4-5",             name: "Claude Opus 4.5",    tag: "Inteligente",      inputPrice: 5,    outputPrice: 25 },
  { id: "claude-opus-4-6",             name: "Claude Opus 4.6",    tag: "Máxima Calidad",   inputPrice: 5,    outputPrice: 25 },
] as const;

const COST_TRACKER_KEY = "ai_cost_tracker_v1";

function log(...args: unknown[]) {
  console.log("[ClaudeAI]", ...args);
}

// ─── Debug Log Capture ────────────────────────────────

let _lastPrompt = "";
let _lastRawResponse = "";
let _lastResponseTimeMs = 0;

export function getLastPrompt(): string { return _lastPrompt; }
export function getLastRawResponse(): string { return _lastRawResponse; }
export function getLastResponseTimeMs(): number { return _lastResponseTimeMs; }

// ─── Cost Tracker (DB only — no localStorage) ────────

/** Load cost tracker from DB on demand */
export async function loadCostTracker(): Promise<AICostTracker> {
  try {
    const t = await dbLoadCostTracker();
    if (t && t.totalCalls > 0) return t;
  } catch (e) {
    console.warn("[ClaudeAI] DB cost load failed", e);
  }
  return { ...defaultAICostTracker };
}

export function resetCostTracker(): void {
  dbResetAICosts().catch(e => console.error("[ClaudeAI] DB reset failed:", e));
}

export function calculateTokenCost(inputTokens: number, outputTokens: number, model: string): number {
  const pricing = MODEL_PRICING[model] || MODEL_PRICING["default"];
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}

// ─── OSINT Prompt with Short-Term Markets ──────────────

export interface PerformanceHistory {
  totalTrades: number;
  wins: number;
  losses: number;
  totalPnl: number;
  winRate: number;
}

function buildOSINTPrompt(
  shortTermMarkets: PolymarketMarket[],
  openOrders: PaperOrder[],
  bankroll: number,
  history?: PerformanceHistory,
): string {
  const now = new Date();

  // Blacklist: markets we already have positions in
  // Filter out de-facto resolved orders (100¢) from blacklist — they clutter the prompt
  const activeOrders = openOrders.filter(o => {
    const priceCents = Math.round(o.price * 100);
    return priceCents > 0 && priceCents < 100;
  });
  const blacklist = activeOrders.length > 0
    ? activeOrders.map(o => `  - [ID:${o.marketId}] "${o.marketQuestion.slice(0, 100)}" → ${o.outcome} @ ${(o.price * 100).toFixed(0)}¢`).join("\n")
    : "  (none)";

  // Compact market list — includes estimated spread proxy
  const liqStr = (liq: number) => liq >= 1_000 ? `$${(liq / 1_000).toFixed(0)}K` : `$${liq.toFixed(0)}`;
  const marketLines = shortTermMarkets.map((m, i) => {
    const prices = m.outcomePrices.map(p => parseFloat(p));
    const endTime = new Date(m.endDate).getTime();
    const minLeft = Math.max(0, Math.round((endTime - now.getTime()) / 60000));
    const hoursLeft = (minLeft / 60).toFixed(1);
    const volStr = m.volume >= 1_000_000 ? `$${(m.volume / 1_000_000).toFixed(1)}M`
      : m.volume >= 1_000 ? `$${(m.volume / 1_000).toFixed(0)}K`
      : `$${m.volume.toFixed(0)}`;
    const spread = estimateSpread(m.liquidity);
    const spreadStr = `~${(spread * 100).toFixed(1)}%`;
    return `[${i + 1}] "${m.question}" | YES=${(prices[0] * 100).toFixed(0)}¢ NO=${(prices[1] * 100).toFixed(0)}¢ | Vol=${volStr} | Liq=${liqStr(m.liquidity)} | Spread=${spreadStr} | Expires: ${hoursLeft}h (${minLeft}min) | ID:${m.id}`;
  }).join("\n");

  // Performance history line (calibration feedback)
  const historyLine = history && history.totalTrades > 0
    ? `HISTORY: {"trades": ${history.totalTrades}, "wins": ${history.wins}, "losses": ${history.losses}, "winRate": ${(history.winRate / 100).toFixed(2)}, "roi": ${history.totalPnl !== 0 ? (history.totalPnl / 100).toFixed(3) : "0.000"}, "pnl": ${history.totalPnl.toFixed(2)}}\n  → ${history.winRate >= 55 ? "Calibration OK — maintain discipline." : history.winRate >= 45 ? "Marginal — tighten confidence thresholds, require stronger edge." : "Poor — be MORE conservative, raise minimum confidence to 70, minimum edge to 0.12."}`
    : "HISTORY: No resolved trades yet — be conservative, require strong evidence.";

  return `Polymarket mispricing scanner. Find where public data (odds, forecasts, polls) disagrees with market prices.

UTC: ${now.toISOString()} | BANKROLL: $${bankroll.toFixed(2)} | ${historyLine}

TWO-PHASE PROCESS (MANDATORY — follow this exact order):

═══ PHASE 1: SCREENING (no web_search yet — use only the market data shown above) ═══
  Scan ALL ${shortTermMarkets.length} markets. For each one, estimate a preliminary edge based ONLY on:
  - Your general knowledge (weather norms, political context, typical stock behavior)
  - The market price vs. your prior estimate
  - Spread, volume, liquidity quality
  Select your TOP 10 candidates — the markets most likely to have real edge.
  For weather: use your knowledge of typical temperatures for that city/season to do a quick mental filter.
  For politics/polls: use your knowledge of recent trends.
  For entertainment: use your knowledge of box office/streaming patterns.
  Skip obvious no-edge markets (price already fair, topic unknowable, spread too wide for the edge).

═══ PHASE 2: DEEP RESEARCH (web_search — MANDATORY for ALL 10 candidates) ═══
  You have web_search (ONLY 10 uses total — 1 per candidate). You MUST use web_search for EACH of your 10 candidates.
  DO NOT skip any candidate without searching first. "Insufficient data" without a web_search call is FORBIDDEN.
  For EACH candidate: do exactly 1 search, find real data, compute pReal, then decide if it qualifies.
  BUDGET: You have exactly 10 searches. Use 1 per candidate. Batch related cities in 1 search query.
  After searching, if the data shows no edge → move to skipped with the actual data as reason.
  Each recommendation needs ≥1 dated source with URL.
  *** EVERY top-10 candidate MUST have exactly 1 web_search call. No exceptions. ***
  If research shows no edge → move it to skipped with reason. Do NOT backfill with market #11.

CATEGORY SEARCH TIPS:
- Weather: Batch ALL weather cities in 1-2 searches: "NWS forecast Chicago Dallas Atlanta Feb 17". DO NOT search each city individually — use 1 query for all US cities, 1 for non-US.
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

PROCESS: Follow the TWO-PHASE PROCESS above. Phase 1: screen all ${shortTermMarkets.length} markets without searching. Phase 2: search your top 10 (EXACTLY 10 searches, 1 per candidate).

MATH:
  pReal = ALWAYS your probability that YES happens (regardless of which side you recommend).
  pMarket = YES price shown above.
  edge = |pReal - pMarket| (must be ≥ minEdge for that market).
  minEdge = max(0.06, spread + 0.04). Ejemplo: spread 8% → minEdge 12%. spread 3% → minEdge 7%. spread 15% → minEdge 19%.
  If side=YES: you're betting pReal > pMarket. If side=NO: you're betting pReal < pMarket.
  friction = USE THE Spread SHOWN for each market. Near-expiry(<30min): add +2%.
  Weather with horizon>12h: use LIMIT orders.
  evNet = edge - friction (must be >0)
  kelly = (pReal*b - q)/b where b=(1/price-1), q=1-pReal. Size = kelly*0.25*bankroll. Cap $${(bankroll * 0.1).toFixed(2)}. Min $2.
  Confidence ≥60 required. <2 sources → confidence ≤40 → skip.
  LOW VOLUME RULE: if Vol < $3K, cap confidence at 65 max (price more easily manipulated) unless you have direct primary-source data (official government data, NWS forecast, etc.).
  WEATHER: Use the WEATHER METHOD above to derive pReal from forecast. ALWAYS compute bin probability — do NOT skip weather markets saying "no specific forecast data", "exact temperature too risky", or "spread too wide for confidence". Derive pReal from forecast HIGH + uncertainty σ and let the math decide.
  CLUSTER RULE: Max 1 recommendation per cluster. A cluster = markets about the SAME CITY and SAME METRIC that are mutually exclusive (e.g. "NYC 41°F" and "NYC 42-43°F" are the same cluster because they're both NYC high temp). But "NYC 42°F" and "Miami 72°F" are DIFFERENT clusters — different cities are NEVER the same cluster. "Seoul 3°C" and "Ankara 12°C" are DIFFERENT clusters. You can recommend one market from NYC AND one from Miami AND one from Seoul — they are independent events.
  Price must be 5¢-95¢.

CRITICAL RULES:
  - NEVER say "already resolved" or "actual result was $X" unless you opened a source URL and verified it in THIS session with web_search. Hallucinating resolution data is FORBIDDEN.
  - EVEN WITH web_search: Be EXTREMELY careful with box office numbers. "Opening weekend" = Friday-Sunday (3 days), NOT 4-day holiday weekends. If a source says "$17.7M 4-day" but the market says "opening weekend", the 3-day number is what matters. DOUBLE-CHECK the exact number format the market uses vs what your source reports.
  - RESOLUTION CLAIM GUARD: If you believe a market is "already resolved", your pReal should STILL reflect uncertainty about resolution criteria interpretation. Cap pReal at 0.80 max for "resolved" markets and cap edge at 0.40 max. Markets that seem too good to be true usually are.
  - EDGE HARD CAP: No recommendation may have edge > 0.40 (40%). If your math shows edge > 40%, you are likely wrong — recheck your pReal estimate. Real edges in prediction markets are typically 5-25%.
  - NEVER skip a weather market with any variation of "no data"/"insufficient data"/"no forecast". Use the WEATHER METHOD with forecast HIGH + σ.
  - For entertainment/box office: only claim resolved if you found the actual data via web_search with a URL AND the number EXACTLY matches the market's criteria (3-day vs 4-day, domestic vs worldwide, etc.).
  - Netflix/streaming: if no official ranking yet, use FlixPatrol but cap confidence ≤ 65, require 2 signals (position + trend).
  - Stocks "Up/Down": cap confidence ≤ 55 without dated catalyst.
  - PHASE 1 must produce exactly 10 candidates. PHASE 2 must search ALL 10. Do NOT skip Phase 2 or search fewer than 10.
  - GOAL: Find profitable bets. The user needs actionable recommendations, not a wall of skips.

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
      "pMarket": 0.00, "pReal": 0.00, "pLow": 0.00, "pHigh": 0.00,  // pReal/pLow/pHigh = ALWAYS P(YES)
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
After completing ALL web searches, you MUST output the JSON response IMMEDIATELY.
Do NOT write additional commentary or analysis after the searches — go STRAIGHT to the JSON block.
Never finish your response without the complete JSON output. The JSON is the ONLY thing that matters.
If you run out of searches, use the data you already have. ALWAYS output JSON.`;
}

// ─── Types ────────────────────────────────────────────

export interface SkippedMarket {
  marketId: string;
  question: string;
  reason: string;
}

export interface ClaudeResearchResult {
  analyses: MarketAnalysis[];
  skipped: SkippedMarket[];
  usage: AIUsage;
  summary: string;
  prompt: string;
  rawResponse: string;
  responseTimeMs: number;
}

// ─── Robust JSON extractor ──────────────────────────
// Claude sometimes adds reasoning text before/after JSON output.
// This function tries multiple strategies to extract valid JSON.
function extractJSON(raw: string): string {
  const trimmed = raw.trim();

  // Strategy 1: Already valid JSON
  if (trimmed.startsWith("{")) {
    try { JSON.parse(trimmed); return trimmed; } catch { /* fall through */ }
  }

  // Strategy 2: Extract from ```json ... ``` code fence (with possible preamble text)
  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    const inner = fenceMatch[1].trim();
    try { JSON.parse(inner); return inner; } catch { /* fall through */ }
  }

  // Strategy 3: Find the outermost { ... } that contains "summary" or "recommendations"
  const firstBrace = raw.indexOf("{");
  if (firstBrace >= 0) {
    // Walk from the first { and find its matching } by counting braces
    let depth = 0;
    let lastBrace = -1;
    for (let i = firstBrace; i < raw.length; i++) {
      if (raw[i] === "{") depth++;
      else if (raw[i] === "}") {
        depth--;
        if (depth === 0) { lastBrace = i; break; }
      }
    }
    if (lastBrace > firstBrace) {
      const candidate = raw.substring(firstBrace, lastBrace + 1);
      try {
        const obj = JSON.parse(candidate);
        if (obj.summary !== undefined || obj.recommendations !== undefined) {
          log(`🔧 JSON extraído de texto (preamble ${firstBrace} chars descartados)`);
          return candidate;
        }
      } catch { /* fall through */ }
    }
  }

  // Strategy 4: Nothing worked, return trimmed raw and let caller handle parse error
  return trimmed;
}

// ─── API Call ─────────────────────────────────────────

export async function analyzeMarketsWithClaude(
  shortTermMarkets: PolymarketMarket[],
  openOrders: PaperOrder[],
  bankroll: number,
  model?: string,
  history?: PerformanceHistory,
): Promise<ClaudeResearchResult> {
  const modelId = model || "claude-sonnet-4-20250514";

  if (shortTermMarkets.length === 0) {
    return {
      analyses: [],
      skipped: [],
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, model: modelId, timestamp: localTimestamp() },
      summary: "No hay mercados que venzan en ≤1h para analizar.",
      prompt: "", rawResponse: "", responseTimeMs: 0,
    };
  }

  const prompt = buildOSINTPrompt(shortTermMarkets, openOrders, bankroll, history);
  _lastPrompt = prompt;

  log(`📡 Enviando ${shortTermMarkets.length} mercados ≤1h para análisis OSINT (${modelId})...`);
  log(`Prompt: ~${prompt.length} chars (~${Math.round(prompt.length / 4)} tokens est.)`);

  const startTime = Date.now();

  const response = await fetch(CLAUDE_PROXY, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "apikey": SUPABASE_KEY,
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: 16384,
      temperature: 0.3,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 10 }],
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    log("❌ Claude API error:", response.status, errorBody);
    throw new Error(`Claude API HTTP ${response.status}: ${errorBody.slice(0, 200)}`);
  }

  const data = await response.json();
  const elapsed = Date.now() - startTime;
  _lastResponseTimeMs = elapsed;

  const inputTokens = data.usage?.input_tokens || 0;
  const outputTokens = data.usage?.output_tokens || 0;
  const stopReason = data.stop_reason || 'unknown';
  let costUsd = calculateTokenCost(inputTokens, outputTokens, modelId);

  log(`🛑 stop_reason: ${stopReason} (max_tokens would mean output was truncated)`);
  if (stopReason === 'max_tokens') {
    log(`⚠️ OUTPUT TRUNCATED — Claude ran out of output tokens. Response may be incomplete.`);
  }

  // With web_search, response has multiple content blocks:
  // [server_tool_use, web_search_tool_result, ..., text (final JSON)]
  const contentBlocks: any[] = data.content || [];
  const textBlocks = contentBlocks.filter((b: any) => b.type === "text");
  // Combine ALL text blocks — Claude may split its response across multiple text blocks
  // The JSON is usually in the last one, but intermediate blocks may contain partial analysis
  const allText = textBlocks.map((b: any) => b.text || "").join("\n");
  const content = allText;

  // Count and log web searches performed
  const webSearchUses = contentBlocks.filter((b: any) => b.type === "server_tool_use" && b.name === "web_search");
  const webSearchResults = contentBlocks.filter((b: any) => b.type === "web_search_tool_result");
  if (webSearchUses.length > 0) {
    log(`🌐 Web searches: ${webSearchUses.length} performed, ${webSearchResults.length} results received`);
    // Log search queries for transparency
    webSearchUses.forEach((s: any, i: number) => {
      const query = s.input?.query || "?";
      log(`   🔍 Search ${i + 1}: "${query}"`);
    });
  } else {
    log(`⚠️ No web searches performed — Claude should be using web_search tool!`);
  }
  _lastRawResponse = content;

  log(`✅ Respuesta: ${elapsed}ms, ${inputTokens}↓ / ${outputTokens}↑, costo: $${costUsd.toFixed(4)}`);

  // ── Parse response FIRST so we can include summary/recommendations in DB ──
  let analyses: MarketAnalysis[] = [];
  let skippedMarkets: SkippedMarket[] = [];
  let summary = "";

  try {
    const jsonStr = extractJSON(content);

    const parsed = JSON.parse(jsonStr);
    summary = parsed.summary || "";

    // Parse skipped markets
    if (Array.isArray(parsed.skipped)) {
      skippedMarkets = parsed.skipped.map((s: any) => ({
        marketId: s.marketId || "",
        question: s.question || "",
        reason: s.reason || "Sin razón",
      }));
      log(`📋 Skipped: ${skippedMarkets.length} mercados con razón de rechazo`);
    }

    if (Array.isArray(parsed.recommendations)) {
      analyses = parsed.recommendations
        .filter((item: any) => item.recommendedSide && item.recommendedSide.toUpperCase() !== "SKIP")
        .map((item: any) => {
          const side = (item.recommendedSide || "SKIP").toUpperCase();
          let pReal = parseFloat(item.pReal) || 0;
          const pMarket = parseFloat(item.pMarket) || 0;
          let pLow = parseFloat(item.pLow) || 0;
          let pHigh = parseFloat(item.pHigh) || 0;

          // ═══ AUTO-FIX: Claude sometimes reports pReal as P(recommended side)
          // instead of P(YES). Detect and correct:
          // If side=NO and pReal > 0.50 → Claude meant "95% chance my NO is right"
          // but we need P(YES) which would be 1-0.95 = 0.05
          if (side === "NO" && pReal > 0.50) {
            log(`⚠️ AUTO-FIX pReal: side=NO but pReal=${pReal} > 0.50 → Claude confused P(recommended) with P(YES). Flipping to ${(1 - pReal).toFixed(3)}`);
            pReal = 1 - pReal;
            // Also flip pLow/pHigh (they should also be P(YES))
            const origLow = pLow;
            pLow = 1 - pHigh;
            pHigh = 1 - origLow;
          }

          const edge = Math.abs(pReal - pMarket);

          return {
            marketId: item.marketId || "",
            question: item.question || "",
            pMarket,
            pReal,
            pLow,
            pHigh,
            edge,
            confidence: parseInt(item.confidence) || 0,
            recommendedSide: side,
            reasoning: item.reasoning || "",
            sources: item.sources || [],
            // SCALP fields
            evNet: parseFloat(item.evNet) || undefined,
            maxEntryPrice: parseFloat(item.maxEntryPrice) || undefined,
            sizeUsd: parseFloat(item.sizeUsd) || undefined,
            orderType: item.orderType || undefined,
            clusterId: item.clusterId || null,
            risks: item.risks || "",
            resolutionCriteria: item.resolutionCriteria || "",
            // Extra fields from improved prompt
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

    // ── CODE-LEVEL EDGE GUARD: reject any recommendation with edge > 40% ──
    const MAX_EDGE = 0.40;
    const preGuardCount = analyses.length;
    analyses = analyses.filter((a) => {
      if (a.edge > MAX_EDGE) {
        log(`🚫 EDGE GUARD: Rejected "${a.question}" — edge ${(a.edge * 100).toFixed(1)}% > ${MAX_EDGE * 100}% cap (pReal=${a.pReal}, pMarket=${a.pMarket}). Likely hallucinated resolution.`);
        return false;
      }
      return true;
    });
    if (preGuardCount > analyses.length) {
      log(`⚠️ EDGE GUARD removed ${preGuardCount - analyses.length} recommendation(s) with suspiciously high edge`);
    }

    log(`📋 Recommendations: ${analyses.length}`);
  } catch (parseError) {
    log("⚠️ Error parseando respuesta de Claude:", parseError);
    log("Respuesta raw:", content.slice(0, 500));
  }

  log(`📊 Resultado: ${analyses.length} recomendaciones con edge`);

  // ── RETRY: If Claude wasted all tokens on web_search and returned no JSON, retry WITHOUT search ──
  if (analyses.length === 0 && skippedMarkets.length === 0 && !content.includes('"recommendations"')) {
    log(`⚠️ Claude devolvió 0 recs y 0 skipped sin JSON válido. Reintentando SIN web_search...`);
    log(`   (Causa probable: ${inputTokens} input tokens de web_search inflaron el contexto)`);
    try {
      // Build a SIMPLIFIED retry prompt — no two-phase process, just direct analysis
      const retryMarketLines = shortTermMarkets.slice(0, 15).map((m: any, i: number) => {
        const prices = JSON.parse(m.outcomePrices || '["0.5","0.5"]');
        return `[${i+1}] "${m.question}" | YES=${(prices[0]*100).toFixed(0)}¢ NO=${(prices[1]*100).toFixed(0)}¢ | ID:${m.id}`;
      }).join("\n");
      const retryPrompt = `You are a Polymarket analyst. Analyze these markets using ONLY general knowledge (no web search available).
For each market, estimate pReal (probability YES happens) and compare to the market price.
Recommend any market where |pReal - pMarket| > 0.08.

BANKROLL: $${bankroll.toFixed(2)}

MARKETS:
${retryMarketLines}

Output ONLY valid JSON (no code fence, no extra text):
{"summary":"brief","skipped":[{"marketId":"ID","question":"q","reason":"why"}],"recommendations":[{"marketId":"ID","question":"q","category":"cat","pMarket":0.0,"pReal":0.0,"pLow":0.0,"pHigh":0.0,"edge":0.0,"friction":0.02,"evNet":0.0,"confidence":65,"recommendedSide":"YES|NO","maxEntryPrice":0.0,"sizeUsd":0,"orderType":"LIMIT","reasoning":"why","sources":["General knowledge"],"risks":"risks","resolutionCriteria":"how"}]}`;
      const retryStart = Date.now();
      const retryResponse = await fetch(CLAUDE_PROXY, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${SUPABASE_KEY}`,
          "apikey": SUPABASE_KEY,
        },
        body: JSON.stringify({
          model: modelId,
          max_tokens: 8192,
          temperature: 0.3,
          // NO web_search — force Claude to use general knowledge only
          messages: [{ role: "user", content: retryPrompt }],
        }),
      });
      if (retryResponse.ok) {
        const retryData = await retryResponse.json();
        const retryBlocks: any[] = retryData.content || [];
        const retryText = retryBlocks.filter((b: any) => b.type === "text").map((b: any) => b.text || "").join("\n");
        const retryInputTokens = retryData.usage?.input_tokens || 0;
        const retryOutputTokens = retryData.usage?.output_tokens || 0;
        const retryCost = calculateTokenCost(retryInputTokens, retryOutputTokens, modelId);
        const retryElapsed = Date.now() - retryStart;
        log(`✅ Retry: ${retryElapsed}ms, ${retryInputTokens}↓ / ${retryOutputTokens}↑, costo extra: $${retryCost.toFixed(4)}`);
        try {
          const retryJson = extractJSON(retryText);
          const retryParsed = JSON.parse(retryJson);
          if (Array.isArray(retryParsed.recommendations) && retryParsed.recommendations.length > 0) {
            log(`🔄 Retry exitoso: ${retryParsed.recommendations.length} recomendaciones`);
            // Re-parse recommendations from retry
            analyses = retryParsed.recommendations
              .filter((item: any) => item.recommendedSide && item.recommendedSide.toUpperCase() !== "SKIP")
              .map((item: any) => {
                const side = (item.recommendedSide || "SKIP").toUpperCase();
                let pReal = parseFloat(item.pReal) || 0;
                const pMarket = parseFloat(item.pMarket) || 0;
                let pLow = parseFloat(item.pLow) || 0;
                let pHigh = parseFloat(item.pHigh) || 0;
                if (side === "NO" && pReal > 0.50) { pReal = 1 - pReal; const ol = pLow; pLow = 1 - pHigh; pHigh = 1 - ol; }
                return {
                  marketId: item.marketId || "", question: item.question || "",
                  pMarket, pReal, pLow, pHigh, edge: Math.abs(pReal - pMarket),
                  confidence: parseInt(item.confidence) || 0, recommendedSide: side,
                  reasoning: item.reasoning || "", sources: item.sources || [],
                  evNet: parseFloat(item.evNet) || undefined, maxEntryPrice: parseFloat(item.maxEntryPrice) || undefined,
                  sizeUsd: parseFloat(item.sizeUsd) || undefined, orderType: item.orderType || undefined,
                  clusterId: item.clusterId || null, risks: item.risks || "",
                  resolutionCriteria: item.resolutionCriteria || "",
                  category: item.category || undefined, friction: parseFloat(item.friction) || undefined,
                  expiresInMin: parseInt(item.expiresInMin) || undefined,
                  liqUsd: parseFloat(item.liqUsd) || undefined, volUsd: parseFloat(item.volUsd) || undefined,
                  dataFreshnessScore: parseInt(item.dataFreshnessScore) || undefined,
                  executionNotes: item.executionNotes || undefined,
                };
              });
            // ── CODE-LEVEL EDGE GUARD (retry path) ──
            const preGuardRetry = analyses.length;
            analyses = analyses.filter((a) => {
              if (a.edge > 0.40) {
                log(`🚫 EDGE GUARD (retry): Rejected "${a.question}" — edge ${(a.edge * 100).toFixed(1)}%`);
                return false;
              }
              return true;
            });
            if (preGuardRetry > analyses.length) log(`⚠️ EDGE GUARD (retry) removed ${preGuardRetry - analyses.length} rec(s)`);
            summary = retryParsed.summary || "(retry sin web_search)";
            if (Array.isArray(retryParsed.skipped)) {
              skippedMarkets = retryParsed.skipped.map((s: any) => ({ marketId: s.marketId || "", question: s.question || "", reason: s.reason || "" }));
            }
          }
        } catch { log(`⚠️ Retry también falló al parsear JSON`); }
        // Add retry cost to totals
        costUsd += retryCost;
      }
    } catch (retryErr) { log(`❌ Retry failed:`, retryErr); }
  }

  // ── Build complete usage object with parsed data ──
  const usage: AIUsage = {
    inputTokens, outputTokens, costUsd, model: modelId, timestamp: localTimestamp(),
    prompt, rawResponse: content, responseTimeMs: elapsed,
    summary, recommendations: analyses.length,
  };

  // Persist to SQLite (single source of truth)
  try {
    await dbAddAICost(usage);
  } catch (e) {
    console.error("[ClaudeAI] DB cost add failed:", e);
  }

  return { analyses, skipped: skippedMarkets, usage, summary, prompt, rawResponse: content, responseTimeMs: elapsed };
}

// ─── Utility ─────────────────────────────────────────

export function estimateAnalysisCost(marketCount: number, model?: string): number {
  const modelId = model || "claude-sonnet-4-20250514";
  // ~50 tokens per market line + ~400 token prompt scaffold + ~20 per open order
  const estInput = 400 + (marketCount * 50);
  const estOutput = 300 + Math.min(marketCount, 5) * 250; // ~250 tokens per recommendation
  return calculateTokenCost(estInput, estOutput, modelId);
}

export function formatCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `${(usd * 100).toFixed(2)}¢`;
  return `$${usd.toFixed(4)}`;
}
