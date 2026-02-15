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

WEB SEARCH: You have web_search. Use it for your top 3-5 candidates. Search for:
- Weather: official forecast from the national meteorological agency for that location (e.g. Met Office UK, KMA Korea, Environment Canada, MetService NZ, etc.) OR ECMWF/GFS consensus from reputable hosts. No forecast → skip. For US, use NWS/NOAA/AccuWeather. For other countries, use their official agency. Always cite agency name and URL. Each recommendation needs 1 official + 1 secondary source (or 2 secondary if no official available).
- Politics/geopolitics: polls, official statements, vote counts.
- Other: recent news, official data, expert analysis.
Each recommendation needs ≥2 dated sources with URLs.

BLACKLIST (already own): ${blacklist}

MARKETS (${shortTermMarkets.length}):
${marketLines}

PROCESS: Scan ALL markets. Pick up to 5 with likely edge. web_search your top candidates. Recommend if edge confirmed.

MATH:
  pReal = ALWAYS your probability that YES happens (regardless of which side you recommend).
  pMarket = YES price shown above.
  edge = |pReal - pMarket| (must be ≥ minEdge for that market).
  minEdge = max(0.06, 2*spread) (conservador) o max(0.05, 1.5*spread) (más jugable). Ejemplo: spread 8% → minEdge 12% (conservador) o 10% (jugable).
  If side=YES: you're betting pReal > pMarket. If side=NO: you're betting pReal < pMarket.
  friction = USE THE Spread SHOWN for each market. Near-expiry(<30min): add +2%.
  Weather with horizon>12h: use LIMIT orders.
  evNet = edge - friction (must be >0)
  kelly = (pReal*b - q)/b where b=(1/price-1), q=1-pReal. Size = kelly*0.25*bankroll. Cap $${(bankroll * 0.1).toFixed(2)}. Min $2.
  Confidence ≥60 required. <2 sources → confidence ≤40 → skip.
  LOW VOLUME RULE: if Vol < $3K, cap confidence at 65 max (price more easily manipulated) unless you have direct primary-source data (official government data, NWS forecast, etc.).
  WEATHER SANITY CHECK: If your forecast says high=X°F/°C and the market asks about a SPECIFIC temperature T:
    - If T is >5°F/3°C away from forecast: pReal ≤ 0.15 (very unlikely exact hit).
    - If market asks "≥T" and forecast < T: pReal must reflect that (likely low).
    - NEVER assign pReal > 0.50 for exact-temperature markets unless forecast is within ±2°F/1°C.
    - Your reasoning MUST be consistent with the data you found. Do NOT say "forecast shows 4°C" then assign pReal=0.85 for ≥7°C.
  Max 1 per cluster (mutually exclusive markets). Price must be 5¢-95¢.

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
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
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
