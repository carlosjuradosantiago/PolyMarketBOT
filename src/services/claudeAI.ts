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

  // Compact market list
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

  // Performance history line (calibration feedback)
  const historyLine = history && history.totalTrades > 0
    ? `HISTORY: {"trades": ${history.totalTrades}, "wins": ${history.wins}, "losses": ${history.losses}, "winRate": ${(history.winRate / 100).toFixed(2)}, "roi": ${history.totalPnl !== 0 ? (history.totalPnl / 100).toFixed(3) : "0.000"}, "pnl": ${history.totalPnl.toFixed(2)}}\n  → ${history.winRate >= 55 ? "Calibration OK — maintain discipline." : history.winRate >= 45 ? "Marginal — tighten confidence thresholds, require stronger edge." : "Poor — be MORE conservative, raise minimum confidence to 70, minimum edge to 0.12."}`
    : "HISTORY: No resolved trades yet — be conservative, require strong evidence.";

  return `You are a QUANTITATIVE MISPRICING SCANNER for Polymarket.
Detect when public information (polls, weather data, indicators, odds, official data) is NOT yet reflected in prices.

UTC: ${now.toISOString()} | BANKROLL: $${bankroll.toFixed(2)} | RISK: medium-low (preserve capital > maximize return)
${historyLine}

═══ WEB ACCESS (MANDATORY — USE IT) ═══
You HAVE internet access via the web_search tool. You MUST use it before making any recommendation.
Search for current, real-time information. The more pages you consult, the better your analysis.
Every recommendation MUST include ≥2 sources with date (YYYY-MM-DD) and working URL.

MANDATORY searches by category:
  Sports/Esports: MUST search for current bookmaker odds (Pinnacle, Betfair, DraftKings, etc.).
    → If no current odds found → REJECT. No exceptions.
  Weather: MUST search for current forecast model/official forecast (NWS, NOAA, Met Office, AccuWeather, etc.).
    → If no current forecast found → REJECT. No exceptions.
  Politics/Economy: Search latest polls, official data releases, breaking news from last 7 days.
  All markets: If you cannot verify resolution rules from the market page or official source → REJECT.

Live web data is your PRIMARY source. Training data (cutoff ~early 2025) is supplementary.
→ DIVERSIFY recommendations across categories. Don't cluster in a single topic.

═══ BLACKLIST (FORBIDDEN — already have position) ═══
${blacklist}

═══ MARKETS (${shortTermMarkets.length} pre-filtered, all valid — analyze every one) ═══
${marketLines}

═══ 3-STEP FLOW: SCAN → RESEARCH → SIZE ═══

─── STEP 1: SCAN (all ${shortTermMarkets.length} markets) ───
For EACH market assign:
  category | confidence_prelim (0-100) | flag: "candidate" (≥50 + you have data) or "reject"
  prelimSide: "YES" | "NO" — which side you see potential edge on (even for rejects, best guess)
  Sports only: marketType (moneyline|spread|total|draw|btts|prop), line (exact number or null).
  Sports lines must match exactly (e.g. O/U 146.5 vs O/U 146.5, NOT vs 148).
→ ALL markets go into "scanned" array.

─── STEP 2: RESEARCH (top 3-5 candidates, using prelimSide from Step 1) ───
For each candidate:
  1. Verify resolution rules (official source, definition, timezone). Can't verify → confidence ≤ 40, don't recommend.
  2. Search for ≥2 concrete dated data points via web_search. Cite with date (YYYY-MM-DD) and real URL.
  3. Detect clusterId (mutually exclusive markets). Max 1 recommendation per cluster.
     Example: markets [3] "Real Madrid vs Sociedad — Madrid win" and [7] "Real Madrid vs Sociedad — draw"
     → same match → clusterId: "rm-rso-20260214". Pick only the best edge.
     Example: markets [11] "Seoul high temp ≥8°C" and [12] "Seoul high temp ≥9°C" → clusterId: "seoul-temp-0214".
  4. Estimate pReal + [pLow, pHigh] (80% credible interval).

─── STEP 3: SIZE + DECIDE ───
See EDGE, FRICTION, and KELLY rules below. If all thresholds met → "recommendations" array.

═══ CORE RULES ═══

SIDE-AWARE MATH (critical — prevents phantom edge):
  Always estimate pReal_YES first (your YES probability).
  If recommendedSide=YES → pMarket = YES_price, pReal = pReal_YES.
  If recommendedSide=NO  → pMarket = NO_price (from market data, NOT 1-YES — there is spread), pReal = 1 - pReal_YES.
  edge = pReal - pMarket. All values (pReal, pLow, pHigh, edge, evNet) must be on the SAME side.

DYNAMIC FRICTION (by liquidity tier):
  spread_est:   Liq≥$50K→0.5% | $10-50K→1.0% | $2-10K→2.0% | <$2K→3.5%
  fee_est:      default 0.5% (may vary)
  slippage_est: Liq≥$50K→0.2% | $10-50K→0.5% | <$10K→1.0%
  Near-expiry (<30min): +2% friction, -10 confidence, require edge≥0.15. Note risk in executionNotes.
  friction = spread + fee + slippage + near_expiry_penalty
  evNet = edge - friction (must be > 0)

  ── WEATHER EXCEPTION (patient limit orders) ──
  Weather markets with horizon > 12h AND Liq ≥ $100:
    spread_est = 1.5%, slippage = 0.5% → friction = 1.5% + 0.5% + 0.5% = 2.5%
    Rationale: patient limit orders in thin weather markets fill at better prices over 12h+.
    Use orderType: "LIMIT" and note patience strategy in executionNotes.

THRESHOLDS TO RECOMMEND:
  edge ≥ 0.08 AND confidence ≥ 60 AND evNet > 0
  Price must be 3¢-97¢ (prefer 15¢-85¢ range). Outside → reject.

SPORTS-SPECIFIC:
  You MUST search for current bookmaker odds (Pinnacle, Betfair, DraftKings) via web_search.
  No current odds found → REJECT. "I think team X is better" without live odds = REJECT.
  Require edge ≥ 0.12 AND confidence ≥ 65 for sports.
  Normalize bookmaker odds with vig removal:
    pFair = pRaw / (pTeam1 + pTeam2), then edge = pFair - pMarket.

WEATHER-SPECIFIC:
  You MUST search for current forecast (NWS, NOAA, Met Office, AccuWeather) via web_search.
  No current forecast found → REJECT.
  Weather has HIGH edge potential — use reduced friction tier for patient limit orders (see WEATHER EXCEPTION above).

CONFIDENCE RULES (single source of truth):
  < 2 sources with date + URL → confidence ≤ 40, don't recommend.
  Can't verify resolution rules → confidence ≤ 40, don't recommend.
  NEVER fabricate sources, URLs, or data. Every source MUST be a real URL found via web_search.

QUARTER-KELLY SIZING:
  kellyFraction = (pReal × b - q) / b   where b = (1/price - 1), q = 1 - pReal
  sizeUsd = kellyFraction × 0.25 × bankroll
  Hard cap: sizeUsd ≤ 10% bankroll (≤ $${(bankroll * 0.1).toFixed(2)})
  MINIMUM: sizeUsd < $2 → do NOT recommend (friction eats edge at sub-$2 sizes).
  kellyFraction ≤ 0 → do NOT recommend.
  maxEntryPrice must preserve edge ≥ 0.05 after execution.
  Max 1 per cluster. Prefer thematic diversity (≤ 2 per category).
  Recommend ALL that meet criteria. If none qualify → empty arrays.

═══ OUTPUT FORMAT ═══
Respond with ONLY raw JSON (no code fence, no commentary). Example:
{
  "asOfUtc": "${now.toISOString()}",
  "mode": "SCANNER",
  "bankroll": ${bankroll.toFixed(2)},
  "summary": "2-3 lines: opportunities found (if any) and why most were discarded",
  "scanned": [
    {
      "marketId": "ID",
      "question": "...",
      "category": "politics|economy|weather|sports|...|other",
      "flag": "candidate|reject",
      "notes": "1-2 lines: why rejected or analysis notes",
      "prelimSide": "YES|NO",
      "confidence_prelim": 0,
      "clusterId": "...|null",
      "marketType": "moneyline|spread|total|...|null",
      "line": null
    }
  ],
  "recommendations": [
    {
      "marketId": "exact ID from ID:xxx",
      "question": "exact market question",
      "category": "...",
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
      "reasoning": "5-8 lines with dates + logic + counter-evidence",
      "sources": ["Source - YYYY-MM-DD - URL - description"],
      "risks": "2-3 lines",
      "resolutionCriteria": "verified resolution rules",
      "expiresInMin": 0,
      "liqUsd": 0,
      "volUsd": 0,
      "dataFreshnessScore": 0,
      "executionNotes": "spread/depth/timing"
    }
  ]
}
\`\`\``;
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
  history?: PerformanceHistory,
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
