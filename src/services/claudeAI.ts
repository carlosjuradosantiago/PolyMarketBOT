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

INFORMATIONAL EDGE CATEGORIES — data the average market participant is slow to process:
- Politics/Government: polls (RCP, 538, Quinnipiac), scheduled votes, official statements, legislative history, committee calendars
- Economy/Finance: leading indicators, Bloomberg/Reuters consensus, publication calendars (BLS, BEA, Fed), macro data
- Events/Regulation: court decisions, regulatory deadlines, agency calendars (FDA, FCC, SEC)
- Weather: NWS/NOAA data, historical averages, GFS/ECMWF models, seasonality
- Geopolitics: scheduled summits, elections, treaties, UN resolutions
- Technology/Science: scheduled launches, data publications, conferences, patents
- Sports/Esports: bookmaker lines (Pinnacle, Betfair, DraftKings), injury reports, team stats, head-to-head records
- DIVERSIFY your recommendations: don't focus on a single category (e.g. only temperature). Look for edge across MULTIPLE topics.

DATE/TIME (UTC): ${now.toISOString()}
MODE: SCANNER
BANKROLL: $${bankroll.toFixed(2)}
RISK: medium-low (preserve capital > maximize return)
BOT MODE: RESPOND ONLY WITH VALID JSON. ZERO TEXT OUTSIDE JSON.

═══ BLACKLIST — ALREADY HAVE POSITION (FORBIDDEN to analyze/recommend) ═══
NOTE: The same market ID may appear twice (YES and NO sides). This is intentional — both sides of an open position are blacklisted.
${blacklist}

═══ MARKETS TO SCAN (${shortTermMarkets.length} pre-filtered and deduplicated locally) ═══
Pre-filtered locally: resolved, de-facto resolved (prices ≤2¢ or ≥98¢), junk/social media/tweets, duplicate open positions, low liquidity (<$500), low volume (<$1K), ultra-near expiry (≤5 min).
Category filters (sports, crypto, stocks) are applied progressively — if the clean pool was small, some sports/crypto/stocks markets MAY be present.
ALL markets below passed filters and are valid. ANALYZE EVERY ONE without exception.

${marketLines}

══════════════════════════════════════════════════════════════
               2-STEP ANALYSIS FLOW
══════════════════════════════════════════════════════════════

──── STEP A — QUICK SCAN (all ${shortTermMarkets.length} markets) ────
For EACH market, determine:
  1. category: politics | economy | weather | sports | esports | crypto | entertainment | science | geopolitics | other
  2. dataNeeded: what primary data would resolve this market?
  3. confidence_prelim: 0-100 estimate based on how much relevant data you have
  4. flag: "candidate" (confidence_prelim ≥ 50 AND you have relevant data) | "reject" (no data, junk, extreme price, unresearchable)
  5. FOR SPORTS ONLY — identify bet type and line:
     * marketType: "moneyline" | "spread" | "total" | "draw" | "btts" | "prop" | null (non-sports)
     * line: the exact line number (e.g. 146.5, -13.5) or null for moneyline/non-sports
     * When comparing with bookmaker odds, you MUST match the SAME line and bet type.
       E.g. Polymarket O/U 146.5 can only be compared against bookmaker O/U 146.5, NOT O/U 148.
Put ALL markets (candidates AND rejects) in the "scanned" array in the output.

──── STEP B — DEEP DIVE (only candidate markets from Step A) ────
For the top 3-5 candidates (highest confidence_prelim):
  1. Full source research: find ≥2 concrete, dated data points per market
  2. Probability estimation: pReal, pLow, pHigh (80% credible interval)
  3. Edge and friction calculation (see below)
  4. Sizing via Kelly criterion (capped)
  5. If all thresholds are met → move to "recommendations" array

═══ CATEGORY-SPECIFIC RULES ═══
SPORTS / ESPORTS markets:
  - REQUIRE bookmaker odds as primary sources (Pinnacle, Betfair, DraftKings, FanDuel, or equivalent).
  - If you have NO bookmaker odds data for a sports market → confidence MUST be ≤ 30 and do NOT recommend.
  - VIG REMOVAL: bookmaker lines include a margin (vig). Before comparing, normalize:
      pImplied_fair = pImplied_raw / (pImplied_team1 + pImplied_team2).
      Only compare the vig-free fair probability against pMarket. Without this step you may see phantom edge.
  - Edge = pImplied_fair - pMarket (after vig removal).
  - Include injury reports, recent form, head-to-head records as supporting (not primary) evidence.

ALL OTHER CATEGORIES:
  - Use primary data sources as listed in INFORMATIONAL EDGE CATEGORIES above.
  - If you genuinely have relevant knowledge → use it. Cite sources with dates.
  - If after honest research you have < 2 datable sources → confidence MUST be ≤ 40 and do NOT recommend.

═══ ANTI-HALLUCINATION RULES ═══
- Every recommendation MUST have ≥ 2 items in "sources", each with a date (YYYY-MM-DD or "as of YYYY-MM").
- If you cannot produce ≥ 2 dated sources for a market → confidence ≤ 40 and it MUST NOT appear in "recommendations".
- NEVER fabricate sources, URLs, or data points. If you're uncertain about a fact, say so in reasoning and lower confidence.
- The market's expiry time does NOT limit your analysis capability. Analyze with what you know NOW.
- But do NOT claim certainty you don't have. Honest low confidence is better than fabricated high confidence.

═══ NEAR-EXPIRY PENALTY ═══
If expiresInMin < 30:
  - Add +2% to friction (spread widens near expiry, harder to exit).
  - Reduce confidence by 10 points (less time for price convergence).
  - ONLY recommend if edge ≥ 0.15 (nearly double the normal threshold). Otherwise → reject.
  - executionNotes MUST mention the near-expiry risk.

═══ STEP 0 — MANDATORY ANALYSIS (for EACH candidate market from Step A) ═══
1. Identify the market's resolution rules (official source, definition, timezone).
   If you CANNOT verify the resolution source or official rules → confidence MUST be ≤ 40 and do NOT recommend.
2. ACTIVELY RESEARCH: search your knowledge for concrete data, recent facts, trends, historical context.
   - For weather/temperature: use weather data, historical averages, seasonal patterns, known forecasts.
   - For politics: use polls, official statements, legislative history, current political context.
   - For economy: use indicators, analyst consensus, data trends, economic calendar.
   - For sports: use bookmaker odds, injury reports, team form, head-to-head records.
   - For any topic: USE EVERYTHING YOU KNOW — but only what you actually know.
3. If after genuinely researching you have insufficient data → assign low confidence (20-40), include in "scanned" with detailed analysis of what you tried and what's missing. Do NOT recommend.
4. Executability: heavily penalize low liquidity, wide spread, very near expiry.
5. Detect clusterId (mutually exclusive markets: up/down/unchanged; buckets; ranges). Max 1 recommendation per cluster.

═══ PRIMARY DATA SCANNING ═══
- TOP PRIORITY: data from primary sources that the average market is slow to process:
  * Weather: NWS, NOAA, Weather.gov, historical averages, numerical models
  * Government/Politics: congress.gov, whitehouse.gov, federal registers, RCP/538 polls
  * Economy: BLS, BEA, Fed, Treasury, consensus estimates
  * Sports: Pinnacle/Betfair lines, official league injury reports, team statistics
  * Events: official organizer sources, historical event data
- If you have primary data that contradicts the price → that is INFORMATIONAL EDGE.
- Cite specific sources with dates. The more primary the source, the more reliable the edge.
- Use historical averages, trends, seasonality as a base when no specific data point exists.

═══ PROBABILITY + EDGE + DYNAMIC FRICTION ═══
- Estimate pReal and conservative [pLow, pHigh] range (80% credible).
- CRITICAL — pMarket MUST match the recommended side:
  * If recommendedSide = YES → pMarket = YES price, pReal = your estimated YES probability.
  * If recommendedSide = NO  → pMarket = NO price (= 1 - YES price), pReal = 1 - pReal_YES.
  * edge = pReal_side - pMarket_side. All values (pReal, pLow, pHigh, edge, evNet) must be on the SAME side.
  * If you estimate pReal_YES but recommend NO, you MUST convert: pReal = 1 - pReal_YES, pMarket = 1 - YES_price.
  * Failure to do this produces phantom edge.
- DYNAMIC FRICTION ESTIMATE (do NOT use a fixed percentage):
  * spread_est: if Liq ≥ $50K → 0.5%; $10K-$50K → 1.0%; $2K-$10K → 2.0%; < $2K → 3.5%
  * fee_est: assume 0.5% unless you have specific fee data (fees may vary by program/period — treat 0.5% as default estimate, not a constant)
  * slippage_est: if Liq ≥ $50K → 0.2%; $10K-$50K → 0.5%; < $10K → 1.0%
  * near_expiry_penalty: if expiresInMin < 30 → add +2.0% (see NEAR-EXPIRY PENALTY section)
  * friction = spread_est + fee_est + slippage_est + near_expiry_penalty
  * evNet = edge - friction (must be > 0 to recommend)
- Recommend ONLY if abs(edge) >= 0.08 AND confidence >= 60 AND evNet > 0.
- A deviation of 8%+ indicates the market has NOT incorporated available information → that's what we're looking for.

═══ SIZING + EXECUTION (FRACTIONAL KELLY) ═══
- SIZING METHOD: Quarter-Kelly (¼ Kelly). This is critical — prediction market probability estimates have calibration error.
  Full Kelly is too aggressive; ¼ Kelly balances growth with drawdown protection.
  * kellyFraction = (pReal * b - q) / b   where b = (1/price - 1), q = 1 - pReal
  * sizeUsd = kellyFraction * 0.25 * bankroll   (the 0.25 is the ¼ Kelly multiplier)
  * Hard cap: sizeUsd ≤ 10% bankroll (≤ $${(bankroll * 0.1).toFixed(2)}) regardless of Kelly output.
  * If kellyFraction ≤ 0 → do NOT recommend (negative edge after friction).
- orderType="LIMIT" always.
- maxEntryPrice must ensure that, even after execution, abs(edge) >= 0.05 remains.
- Max 1 recommendation per clusterId.
- DIVERSIFICATION: prefer thematic variety. Avoid concentrating more than 2 recommendations in the same category.
- If primary data contradicts the current price → there's mispricing → RECOMMEND.
- No artificial total limit: recommend ALL that meet the criteria. If nothing qualifies → empty arrays.

═══ CRITICAL RULE — EXECUTABLE PRICE RANGE ═══
- FORBIDDEN to recommend markets where the recommended side price is < 3¢ (0.03) or > 97¢ (0.97).
  Prices <3¢ are lottery tickets with enormous spreads — Kelly rejects them automatically.
  Prices >97¢ don't have enough upside to justify the capital.
- Look for opportunities in the 5¢-95¢ range where there's real liquidity and executable edge.
- If a market has YES=0¢ or YES=100¢, it's probably de-facto resolved — do NOT recommend.
- Prioritize markets with prices between 15¢-85¢ where mispricing is more likely and executable.

═══ JSON FORMAT (ONLY ALLOWED FORMAT — no backticks, no markdown, no text outside) ═══
{
  "asOfUtc": "${now.toISOString()}",
  "mode": "SCANNER",
  "bankroll": ${bankroll.toFixed(2)},
  "summary": "2-3 lines: real opportunities (if any), and why most were discarded",
  "scanned": [
    {
      "marketId": "ID",
      "question": "...",
      "category": "politics|economy|weather|sports|esports|crypto|entertainment|science|geopolitics|other",
      "flag": "candidate|reject",
      "notes": "1-2 lines: analysis notes — why rejected, data gaps, partial findings, or why not recommended",
      "confidence_prelim": 0,
      "clusterId": "...|null",
      "marketType": "moneyline|spread|total|draw|btts|prop|null",
      "line": "number|null"
    }
  ],
  "recommendations": [
    {
      "marketId": "EXACT ID from the ID:xxx field",
      "question": "exact market question",
      "category": "politics|economy|weather|sports|esports|crypto|entertainment|science|geopolitics|other",
      "clusterId": "...|null",
      "pMarket": 0.00,
      "pReal": 0.00,
      "pLow": 0.00,
      "pHigh": 0.00,
      "edge": 0.00,
      "friction": 0.00,
      "evNet": 0.00,
      "confidence": 0,
      "recommendedSide": "YES|NO",
      "maxEntryPrice": 0.00,
      "sizeUsd": 0.00,
      "orderType": "LIMIT",
      "reasoning": "5-8 lines with dates + rules + logic + counter-evidence + assumptions",
      "sources": ["Source - YYYY-MM-DD - title/description", "Source2 - YYYY-MM-DD - ..."],
      "risks": "2-3 lines (rule/timing/slippage)",
      "resolutionCriteria": "1 line per verified rules",
      "expiresInMin": 0,
      "liqUsd": 0,
      "volUsd": 0,
      "dataFreshnessScore": 0,
      "executionNotes": "spread/depth/timing notes"
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

  const prompt = buildOSINTPrompt(shortTermMarkets, openOrders, bankroll);
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
          // Extra fields from improved prompt
          category: item.category || undefined,
          friction: parseFloat(item.friction) || undefined,
          expiresInMin: parseInt(item.expiresInMin) || undefined,
          liqUsd: parseFloat(item.liqUsd) || undefined,
          volUsd: parseFloat(item.volUsd) || undefined,
          dataFreshnessScore: parseInt(item.dataFreshnessScore) || undefined,
          executionNotes: item.executionNotes || undefined,
        }));
    }

    // Log scanned markets count (supports both new "scanned" and legacy "skipped" key)
    const scannedArr = parsed.scanned || parsed.skipped || [];
    if (Array.isArray(scannedArr) && scannedArr.length > 0) {
      const candidates = scannedArr.filter((s: any) => s.flag === "candidate").length;
      const rejects = scannedArr.filter((s: any) => s.flag === "reject").length;
      log(`📋 Scanned: ${scannedArr.length} markets (${candidates} candidates, ${rejects} rejects)`);
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
