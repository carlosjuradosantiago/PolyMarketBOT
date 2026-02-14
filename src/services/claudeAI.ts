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

/** Pre-format a Date as local time string so display never needs timezone conversion */
function localTimestamp(): string {
  // Store as UTC ISO — the frontend converts to UTC-5 for display
  return new Date().toISOString();
}

// ─── Constants ─────────────────────────────────────

const CLAUDE_PROXY = "/api/claude";

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

function buildOSINTPrompt(
  shortTermMarkets: PolymarketMarket[],
  openOrders: PaperOrder[],
  bankroll: number,
  totalAICost: number,
): string {
  const now = new Date();

  // Blacklist: markets we already have positions in (send as IDs to exclude)
  const blacklist = openOrders.length > 0
    ? openOrders.map(o => `  - [ID:${o.marketId}] "${o.marketQuestion.slice(0, 60)}" → ${o.outcome} @ ${(o.price * 100).toFixed(0)}¢`).join("\n")
    : "  (none)";

  // Build compact market list — each market ~40-60 tokens
  const liqStr = (liq: number) => liq >= 1_000 ? `$${(liq / 1_000).toFixed(0)}K` : `$${liq.toFixed(0)}`;
  const marketLines = shortTermMarkets.map((m, i) => {
    const prices = m.outcomePrices.map(p => parseFloat(p));
    const endTime = new Date(m.endDate).getTime();
    const minLeft = Math.max(0, Math.round((endTime - now.getTime()) / 60000));
    const hoursLeft = (minLeft / 60).toFixed(1);
    const volStr = m.volume >= 1_000_000 ? `$${(m.volume / 1_000_000).toFixed(1)}M`
      : m.volume >= 1_000 ? `$${(m.volume / 1_000).toFixed(0)}K`
      : `$${m.volume.toFixed(0)}`;
    return `[${i + 1}] "${m.question}" | YES=${(prices[0] * 100).toFixed(0)}¢ NO=${(prices[1] * 100).toFixed(0)}¢ | Vol=${volStr} | Liq=${liqStr(m.liquidity)} | Expires: ${hoursLeft}h (${minLeft}min) | ID:${m.id}`;
  }).join("\n");

  return `You are a QUANTITATIVE INEFFICIENCY SCANNER for prediction markets (Polymarket).
Your function: analyze ${shortTermMarkets.length} active markets comparing market prices against real probabilities based on PRIMARY DATA.
You act as a radar detecting MISPRICING: when publicly available information (weather data, polls, economic indicators, official statements, statistical data) has not yet been fully reflected in prices.

INFORMATIONAL EDGE: Your value is processing PRIMARY DATA before the average market participant:
- Politics/Government: polls (RCP, 538, Quinnipiac), scheduled votes, official statements, legislative history, committee calendars
- Economy/Finance: leading indicators, Bloomberg/Reuters consensus, publication calendars (BLS, BEA, Fed), macro data
- Events/Regulation: court decisions, regulatory deadlines, agency calendars (FDA, FCC, SEC)
- Weather: NWS/NOAA data, historical averages, GFS/ECMWF models, seasonality
- Geopolitics: scheduled summits, elections, treaties, UN resolutions
- Technology/Science: scheduled launches, data publications, conferences, patents
- DIVERSIFY your recommendations: don't focus on a single category (e.g. only temperature). Look for edge across MULTIPLE topics.

DATE/TIME (UTC): ${now.toISOString()}
MODE: SCANNER
BANKROLL: $${bankroll.toFixed(2)} | Accumulated AI cost: $${totalAICost.toFixed(4)}
RISK: medium-low (preserve capital > maximize return)
BOT MODE: RESPOND ONLY WITH VALID JSON. ZERO TEXT OUTSIDE JSON.

═══ BLACKLIST — ALREADY HAVE POSITION (FORBIDDEN to analyze/recommend) ═══
${blacklist}

═══ MARKETS TO SCAN (${shortTermMarkets.length} pre-filtered and deduplicated locally) ═══
Already filtered locally: sports, crypto/prices, stocks/markets, tweets/social media, low liquidity (<$5K), low volume (<$15K), resolved markets, open positions, and cluster-duplicates (e.g. multiple temperatures for the same city).
ALL these markets are valid and high quality. ANALYZE EVERY ONE without exception.

${marketLines}

═══ INSTRUCTIONS — NO SKIP, ANALYZE EVERYTHING ═══
- FORBIDDEN to use SKIP. All markets already passed strict bot filters.
- If a market seems out of category, or has some issue → put it in "skipped" with partial analysis (low confidence), but do NOT mark SKIP.
- You MUST analyze ALL markets you receive. They are few and pre-filtered.

═══ STEP 0 — MANDATORY ANALYSIS (for EACH market that is not SKIP) ═══
1. Identify the market's resolution rules (official source, definition, timezone).
2. ACTIVELY RESEARCH: search your knowledge for concrete data, recent facts, trends, historical context.
   - For weather/temperature: use weather data, historical averages, seasonal patterns, known forecasts.
   - For politics: use polls, official statements, legislative history, current political context.
   - For economy: use indicators, analyst consensus, data trends, economic calendar.
   - For any topic: USE EVERYTHING YOU KNOW. Don't say "I can't verify" without trying first.
3. If after genuinely researching you don't have enough information → assign low confidence (20-40) and do NOT recommend, but INCLUDE your partial analysis in "skipped" with detailed skipReason of what you tried and what's missing.
4. Executability: heavily penalize low liquidity, spread, very near expiry.
5. Detect clusterId (mutually exclusive markets: up/down/unchanged; buckets; ranges). Max 1 recommendation per cluster.

KEY RULE: NEVER say "it's not feasible to verify in X minutes". You already have knowledge — USE IT.
The market's expiry time does NOT limit your analysis capability. Analyze with what you know NOW.

═══ PRIMARY DATA SCANNING ═══
- TOP PRIORITY: data from primary sources that the average market is slow to process:
  * Weather: NWS, NOAA, Weather.gov, historical averages, numerical models
  * Government/Politics: congress.gov, whitehouse.gov, federal registers, RCP/538 polls
  * Economy: BLS, BEA, Fed, Treasury, consensus estimates
  * Events: official organizer sources, historical event data
- If you have primary data that contradicts the price → that is INFORMATIONAL EDGE.
- Cite specific sources with dates. The more primary the source, the more reliable the edge.
- Use historical averages, trends, seasonality as a base when no specific data point exists.
- Do NOT discard markets. If you can't find data → low confidence, but analyze.

═══ PROBABILITY + EDGE ═══
- Estimate pReal and conservative [pLow, pHigh] range (80% credible).
- pMarket = YES price as decimal (already provided).
- edge = pReal - pMarket.
- Estimate evNet penalizing spread/fees/slippage (~2-3% friction).
- Recommend ONLY if abs(edge) >= 0.08 and confidence >= 60 and evNet > 0.
- A deviation of 8%+ indicates the market has NOT incorporated available information → that's what we're looking for.

═══ SIZING + EXECUTION (SCALP) ═══
- orderType="LIMIT" always.
- maxEntryPrice must ensure that, even after execution, abs(edge) >= 0.05 remains.
- sizeUsd per trade ≤ 10% bankroll (≤ $${(bankroll * 0.1).toFixed(2)}).
- Max 1 recommendation per clusterId.
- DIVERSIFICATION: prefer thematic variety. Avoid concentrating more than 2 recommendations in the same category (temperature, politics, economy, etc.).
- If primary data contradicts the current price → there's mispricing → RECOMMEND.
- No artificial total limit: recommend ALL that meet the criteria. If nothing qualifies → empty arrays.

═══ CRITICAL RULE — EXECUTABLE PRICE RANGE ═══
- FORBIDDEN to recommend markets where the recommended side price is < 3¢ (0.03) or > 97¢ (0.97).
  Prices <3¢ are lottery tickets with enormous spreads and illiquid — Kelly rejects them automatically.
  Prices >97¢ don't have enough upside to justify the capital.
- Look for opportunities in the 5¢-95¢ range where there's real liquidity and executable edge.
- If a market has YES=0¢ or YES=100¢, the real price is probably ~1-2¢ or ~98-99¢ with spread.
  These markets are almost always "de facto resolved" — do NOT recommend them.
- Prioritize markets with prices between 15¢-85¢ where mispricing is more likely and executable.

═══ JSON FORMAT (ONLY ALLOWED FORMAT — no backticks, no markdown, no text outside) ═══
{
  "asOfUtc": "${now.toISOString()}",
  "mode": "SCANNER",
  "bankroll": ${bankroll.toFixed(2)},
  "summary": "2-3 lines: real opportunities (if any), and why most were discarded",
  "skipped": [
    {"marketId":"ID","question":"...","status":"SKIP","skipReason":"...","clusterId":"...|null"}
  ],
  "recommendations": [
    {
      "marketId": "EXACT ID from the ID:xxx field",
      "question": "exact market question",
      "clusterId": "...|null",
      "pMarket": 0.00,
      "pReal": 0.00,
      "pLow": 0.00,
      "pHigh": 0.00,
      "edge": 0.00,
      "evNet": 0.00,
      "confidence": 0,
      "recommendedSide": "YES|NO",
      "maxEntryPrice": 0.00,
      "sizeUsd": 0.00,
      "orderType": "LIMIT",
      "reasoning": "5-8 lines with dates + rules + logic + counter-evidence + assumptions",
      "sources": ["Source - YYYY-MM-DD - title/link", "..."],
      "risks": "2-3 lines (rule/timing/slippage)",
      "resolutionCriteria": "1 line per verified rules"
    }
  ]
}`;
}

// ─── Types ────────────────────────────────────────────

export interface ClaudeResearchResult {
  analyses: MarketAnalysis[];
  usage: AIUsage;
  summary: string;
  prompt: string;
  rawResponse: string;
  responseTimeMs: number;
}

// ─── API Call ─────────────────────────────────────────

export async function analyzeMarketsWithClaude(
  shortTermMarkets: PolymarketMarket[],
  openOrders: PaperOrder[],
  bankroll: number,
  model?: string,
): Promise<ClaudeResearchResult> {
  const modelId = model || "claude-sonnet-4-20250514";

  if (shortTermMarkets.length === 0) {
    return {
      analyses: [],
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, model: modelId, timestamp: localTimestamp() },
      summary: "No hay mercados que venzan en ≤1h para analizar.",
      prompt: "", rawResponse: "", responseTimeMs: 0,
    };
  }

  const tracker = await loadCostTracker();
  const prompt = buildOSINTPrompt(shortTermMarkets, openOrders, bankroll, tracker.totalCostUsd);
  _lastPrompt = prompt;

  log(`📡 Enviando ${shortTermMarkets.length} mercados ≤1h para análisis OSINT (${modelId})...`);
  log(`Prompt: ~${prompt.length} chars (~${Math.round(prompt.length / 4)} tokens est.)`);

  const startTime = Date.now();

  const response = await fetch(CLAUDE_PROXY, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: 8192,
      temperature: 0.3,
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

  // Parse response content first so we can store it in usage
  const content = data.content?.[0]?.text || "";
  _lastRawResponse = content;

  log(`✅ Respuesta: ${elapsed}ms, ${inputTokens}↓ / ${outputTokens}↑, costo: $${costUsd.toFixed(4)}`);

  // ── Parse response FIRST so we can include summary/recommendations in DB ──
  let analyses: MarketAnalysis[] = [];
  let summary = "";

  try {
    let jsonStr = content.trim();
    if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }

    const parsed = JSON.parse(jsonStr);
    summary = parsed.summary || "";

    if (Array.isArray(parsed.recommendations)) {
      analyses = parsed.recommendations
        .filter((item: any) => item.recommendedSide && item.recommendedSide.toUpperCase() !== "SKIP")
        .map((item: any) => ({
          marketId: item.marketId || "",
          question: item.question || "",
          pMarket: parseFloat(item.pMarket) || 0,
          pReal: parseFloat(item.pReal) || 0,
          pLow: parseFloat(item.pLow) || 0,
          pHigh: parseFloat(item.pHigh) || 0,
          edge: Math.abs((parseFloat(item.pReal) || 0) - (parseFloat(item.pMarket) || 0)),
          confidence: parseInt(item.confidence) || 0,
          recommendedSide: (item.recommendedSide || "SKIP").toUpperCase(),
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
        }));
    }
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

  return { analyses, usage, summary, prompt, rawResponse: content, responseTimeMs: elapsed };
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
