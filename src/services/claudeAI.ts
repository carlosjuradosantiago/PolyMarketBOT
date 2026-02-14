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

const CLAUDE_PROXY = "/api/claude/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

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
    : "  (ninguna)";

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
    return `[${i + 1}] "${m.question}" | YES=${(prices[0] * 100).toFixed(0)}¢ NO=${(prices[1] * 100).toFixed(0)}¢ | Vol=${volStr} | Liq=${liqStr(m.liquidity)} | Vence: ${hoursLeft}h (${minLeft}min) | ID:${m.id}`;
  }).join("\n");

  return `Eres un ESCÁNER CUANTITATIVO DE INEFICIENCIAS en mercados de predicción (Polymarket).
Tu función: analizar ${shortTermMarkets.length} mercados activos comparando precios de mercado contra probabilidades reales basadas en DATOS PRIMARIOS.
Actúas como un radar que detecta MISPRICING: cuando la información pública disponible (datos meteorológicos, encuestas, indicadores económicos, comunicados oficiales, datos estadísticos) aún no se ha reflejado plenamente en los precios.

VENTAJA INFORMACIONAL: Tu valor está en procesar DATOS PRIMARIOS antes que el mercado promedio:
- Política/Gobierno: encuestas (RCP, 538, Quinnipiac), votaciones programadas, comunicados oficiales, historial legislativo, calendarios de comités
- Economía/Finanzas: indicadores adelantados, consenso Bloomberg/Reuters, calendario de publicaciones (BLS, BEA, Fed), datos macro
- Eventos/Regulación: decisiones judiciales, fechas de vencimiento regulatorio, calendarios de agencias (FDA, FCC, SEC)
- Meteorología: datos NWS/NOAA, promedios históricos, modelos GFS/ECMWF, estacionalidad
- Geopolítica: cumbres programadas, elecciones, tratados, resoluciones ONU
- Tecnología/Ciencia: lanzamientos programados, publicaciones de datos, conferencias, patentes
- DIVERSIFICA tus recomendaciones: no te concentres en una sola categoría (ej. solo temperatura). Busca edge en MÚLTIPLES temas.

FECHA/HORA (UTC): ${now.toISOString()}
MODE: SCANNER
BANKROLL: $${bankroll.toFixed(2)} | Costo IA acumulado: $${totalAICost.toFixed(4)}
RIESGO: media-baja (preservar capital > maximizar retorno)
MODO BOT: RESPONDE ÚNICAMENTE JSON VÁLIDO. CERO TEXTO FUERA DEL JSON.

═══ BLACKLIST — YA TENGO POSICIÓN (PROHIBIDO analizar/recomendar) ═══
${blacklist}

═══ MERCADOS A ESCANEAR (${shortTermMarkets.length} pre-filtrados y deduplicados localmente) ═══
Ya filtré localmente: deportes, crypto/precios, acciones/bolsa, tweets/redes sociales, baja liquidez (<$5K), bajo volumen (<$15K), mercados resueltos, posiciones abiertas, y cluster-duplicados (ej. múltiples temperaturas para la misma ciudad).
TODOS estos mercados son válidos y de alta calidad. ANALIZA CADA UNO sin excepciones.

${marketLines}

═══ INSTRUCCIONES — NO SKIP, ANALIZA TODO ═══
- PROHIBIDO usar SKIP. Todos los mercados ya pasaron filtros estrictos del bot.
- Si un mercado se ve fuera de categoría, o tiene algún problema → ponlo en "skipped" con análisis parcial (confidence bajo), pero NO marques SKIP.
- DEBES analizar TODOS los mercados que recibes. Son pocos y pre-filtrados.

═══ PASO 0 — ANÁLISIS OBLIGATORIO (para CADA mercado que no sea SKIP) ═══
1. Identifica las reglas de resolución del mercado (fuente oficial, definición, timezone).
2. INVESTIGA activamente: busca en tu conocimiento datos concretos, hechos recientes, tendencias, contexto histórico.
   - Para clima/temperatura: usa datos meteorológicos, promedios históricos, patrones estacionales, previsiones conocidas.
   - Para política: usa encuestas, declaraciones oficiales, historial legislativo, contexto político actual.
   - Para economía: usa indicadores, consenso de analistas, tendencias de datos, calendario económico.
   - Para cualquier tema: USA TODO LO QUE SEPAS. No digas "no puedo verificar" sin intentarlo primero.
3. Si tras investigar genuinamente no tienes suficiente información → asigna confidence bajo (20-40) y NO recomiendes, pero INCLUYE tu análisis parcial en "skipped" con skipReason detallado de qué intentaste y qué falta.
4. Ejecutabilidad: penaliza fuerte baja liquidez, spread, vencimiento muy cercano.
5. Detecta clusterId (mercados mutuamente excluyentes: sube/baja/no cambia; buckets; rangos). Máx 1 recomendación por cluster.

REGLA CLAVE: NUNCA digas "no es factible verificar en X minutos". Tú ya tienes conocimiento — ÚSALO.
El tiempo de vencimiento del mercado NO limita tu capacidad de análisis. Analiza con lo que sabes AHORA.

═══ ESCANEO DE DATOS PRIMARIOS ═══
- PRIORIDAD MÁXIMA: datos de fuentes primarias que el mercado promedio tarda en procesar:
  * Meteorología: NWS, NOAA, Weather.gov, historical averages, modelos numéricos
  * Gobierno/Política: congress.gov, whitehouse.gov, registros federales, encuestas RCP/538
  * Economía: BLS, BEA, Fed, Treasury, consensus estimates
  * Eventos: fuentes oficiales del organizador, datos históricos del evento
- Si tienes datos primarios que contradicen el precio → eso es EDGE INFORMACIONAL.
- Cita fuentes específicas con fechas. Cuanto más primaria la fuente, más confiable el edge.
- Usa promedios históricos, tendencias, estacionalidad como base cuando no hay dato puntual.
- NO descartes mercados. Si no encuentras datos → confidence bajo, pero analiza.

═══ PROBABILIDAD + EDGE ═══
- Estima pReal y rango [pLow, pHigh] conservador (80% creíble).
- pMarket = precio YES como decimal (ya te lo doy).
- edge = pReal - pMarket.
- Estima evNet penalizando spread/fees/slippage (~2-3% fricción).
- Recomendar SOLO si abs(edge) >= 0.08 y confidence >= 60 y evNet > 0.
- Un desvío de 8%+ indica que el mercado NO ha incorporado información disponible → eso es lo que buscamos.

═══ SIZING + EJECUCIÓN (SCALP) ═══
- orderType="LIMIT" siempre.
- maxEntryPrice debe asegurar que, aun con ejecución, quede abs(edge) >= 0.05.
- sizeUsd por trade ≤ 10% bankroll (≤ $${(bankroll * 0.1).toFixed(2)}).
- Máx 1 recomendación por clusterId.
- DIVERSIFICACIÓN: prefiere variedad temática. Evita concentrar más de 2 recomendaciones en la misma categoría (temperatura, política, economía, etc.).
- Si el dato primario contradice el precio actual → hay mispricing → RECOMIENDA.
- Sin límite artificial total: recomienda TODAS las que cumplan los criterios. Si nada cumple → arrays vacíos.

═══ REGLA CRÍTICA — RANGO DE PRECIOS EJECUTABLES ═══
- PROHIBIDO recomendar mercados donde el precio del lado recomendado sea < 3¢ (0.03) o > 97¢ (0.97).
  Precios <3¢ son tickets de lotería con spreads enormes e ilíquidos — Kelly los rechaza automáticamente.
  Precios >97¢ no tienen suficiente upside para justificar el capital.
- Busca oportunidades en el rango 5¢-95¢ donde hay liquidez real y edge ejecutable.
- Si un mercado tiene YES=0¢ o YES=100¢, el precio real probablemente es ~1-2¢ o ~98-99¢ con spread.
  Estos mercados casi siempre son "resueltos de facto" — NO los recomiendes.
- Prioriza mercados con precios entre 15¢-85¢ donde el mispricing es más probable y ejecutable.

═══ FORMATO JSON (ÚNICO PERMITIDO — sin backticks, sin markdown, sin texto fuera) ═══
{
  "asOfUtc": "${now.toISOString()}",
  "mode": "SCANNER",
  "bankroll": ${bankroll.toFixed(2)},
  "summary": "2-3 líneas: oportunidades reales (si hay), y por qué se descartó la mayoría",
  "skipped": [
    {"marketId":"ID","question":"...","status":"SKIP","skipReason":"...","clusterId":"...|null"}
  ],
  "recommendations": [
    {
      "marketId": "ID EXACTO del campo ID:xxx",
      "question": "pregunta exacta del mercado",
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
      "reasoning": "5-8 líneas con fechas + reglas + lógica + contraevidencia + supuestos",
      "sources": ["Fuente - YYYY-MM-DD - título/link", "..."],
      "risks": "2-3 líneas (regla/timing/slippage)",
      "resolutionCriteria": "1 línea según reglas verificadas"
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
  apiKey?: string,
  model?: string,
): Promise<ClaudeResearchResult> {
  const key = apiKey || import.meta.env.VITE_CLAUDE_API_KEY;
  const modelId = model || import.meta.env.VITE_CLAUDE_MODEL || "claude-sonnet-4-20250514";

  if (!key) throw new Error("VITE_CLAUDE_API_KEY no configurada");

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
      "x-api-key": key,
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-dangerous-direct-browser-access": "true",
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
  const modelId = model || import.meta.env.VITE_CLAUDE_MODEL || "claude-sonnet-4-20250514";
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
