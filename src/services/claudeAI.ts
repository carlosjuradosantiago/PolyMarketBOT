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

WEB SEARCH: You have web_search (up to ${shortTermMarkets.length * 5} uses — 5 per market). BUDGET ALLOCATION:
  Weather markets: MAX 2 searches per city (1 official + 1 backup). Batch nearby cities: "NWS forecast Chicago Dallas Atlanta Feb 17" = 1 search for 3 cities.
  Non-weather markets: 3-5 searches each.
  PROCESS ORDER: Search NON-WEATHER markets FIRST (politics, entertainment, finance, polls — they need more research). THEN weather (only needs 1-2 quick searches each).
  "Insufficient search budget" is NEVER a valid skip reason unless you have truly exhausted ALL ${shortTermMarkets.length * 5} searches. COUNT your searches — if you've used less than half, you have budget.
  Each recommendation needs ≥2 dated sources with URLs (1 official + 1 secondary, or 2 secondary).

CATEGORY RULES:
- Politics/geopolitics: polls, official statements, vote counts. ALWAYS search — these often have clear edge.
- Polls/approval ratings: search RealClearPolitics, FiveThirtyEight, 270toWin. Approval markets often have predictable trends.
- Entertainment/Netflix: FlixPatrol daily charts + Netflix official Top 10. If no official ranking published yet, use FlixPatrol but cap confidence ≤ 65 and require 2 signals (chart position + trend direction).
- Entertainment/box office: search Box Office Mojo, The Numbers, Deadline. Always verify with actual data.
- Finance/Stocks "Up/Down": These are harder — cap confidence ≤ 60 unless you find a dated catalyst (earnings, Fed decision, macro data release) within expiry. With catalyst, normal confidence. Without catalyst, only recommend if strong technical momentum AND confidence ≤ 55.
- Legal/SCOTUS: see LEGAL METHOD below.

WEATHER SEARCH — ANTI-EXCUSE RULE (MANDATORY):
  For ANY city (pop > 100K): official forecasts ALWAYS EXIST. You MUST find them. NO EXCUSES.
  Step 1: Search the official source (see WEATHER SEARCH PROTOCOL). This ALWAYS works for Miami, NYC, Chicago, Dallas, Atlanta, London, Toronto, São Paulo, Seoul, Buenos Aires, Wellington, Ankara.
  Step 2: If official source fails → use AccuWeather or Weather.com (they cover EVERY city on Earth). Cap confidence ≤ 65.
  Step 3: If budget truly exhausted (you've used 80+ searches) → mark "NOT SEARCHED (budget exhausted)".
  FORBIDDEN phrases — if you write ANY of these, your analysis is WRONG:
    "no specific forecast data", "no exact forecast", "no forecast data found",
    "insufficient forecast data", "could not find forecast",
    "insufficient weather data", "insufficient specific weather data",
    "no weather data", "unable to find forecast", "no data available".
  These phrases are IMPOSSIBLE for cities with pop > 100K — official agencies + AccuWeather + Weather.com ALL have data.

WEATHER PRE-FILTER (saves searches — apply BEFORE searching):
  For "exactly X°C" or narrow 1-2°F bin markets: quick-check if any source you already have shows forecast HIGH near that bin. If forecast HIGH is > ±3°C (±5°F) away from the bin → auto-skip with reason "forecast μ far from bin, no edge" without burning a search.
  For markets with spread ≥ 8% AND Vol < $3K: only search if official source is easy (US/NWS, Canada/EnvCanada, UK/MetOffice). Otherwise skip — not worth the search budget.

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

PROCESS: Scan ALL markets. web_search ALL weather markets first (batch cities to save searches). Then search top non-weather candidates. Recommend any with confirmed edge.

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
  Max 1 per cluster (mutually exclusive markets). Price must be 5¢-95¢.

CRITICAL RULES:
  - NEVER say "already resolved" or "actual result was $X" unless you opened a source URL and verified it in THIS session with web_search. Hallucinating resolution data is FORBIDDEN. If you haven't verified with a URL, treat the market as unresolved.
  - NEVER skip a weather market with any variation of "no data"/"insufficient data"/"no forecast". For cities pop > 100K, forecasts ALWAYS exist on NWS/AccuWeather/Weather.com. Use the WEATHER METHOD with forecast HIGH + σ to compute bin probability.
  - "Insufficient search budget" is NOT valid if you've used fewer than 80% of your total searches. COUNT before claiming budget exhaustion.
  - For entertainment/box office: only claim resolved if you found the actual data via web_search with a URL. Weekend estimates ≠ final results.
  - Netflix/streaming: if no official ranking yet, use FlixPatrol but cap confidence ≤ 65, require 2 signals (position + trend).
  - Stocks "Up/Down": prefer to analyze WITH catalyst. Without catalyst, you may still recommend with confidence ≤ 55 if strong technical signal.
  - GOAL: Find profitable bets. Do NOT skip everything — the user needs actionable recommendations. If 20+ markets are sent, at least SEARCH all of them before skipping.

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
If nothing qualifies: {"summary":"reason","skipped":[...],"recommendations":[]}`;
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
      max_tokens: 4096,
      temperature: 0.3,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: shortTermMarkets.length * 5 }],
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
  const costUsd = calculateTokenCost(inputTokens, outputTokens, modelId);

  // With web_search, response has multiple content blocks:
  // [server_tool_use, web_search_tool_result, ..., text (final JSON)]
  const contentBlocks: any[] = data.content || [];
  const textBlocks = contentBlocks.filter((b: any) => b.type === "text");
  const content = textBlocks.length > 0 ? textBlocks[textBlocks.length - 1].text : "";

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

    log(`📋 Recommendations: ${analyses.length}`);
  } catch (parseError) {
    log("⚠️ Error parseando respuesta de Claude:", parseError);
    log("Respuesta raw:", content.slice(0, 500));
  }

  log(`📊 Resultado: ${analyses.length} recomendaciones con edge`);

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
