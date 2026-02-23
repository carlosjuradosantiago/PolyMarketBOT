/**
 * Unified AI Service — Multi-provider support for market analysis.
 * Routes requests to the correct provider's proxy, handles response parsing.
 *
 * Providers: Anthropic (Claude), Google (Gemini), OpenAI, xAI (Grok), DeepSeek
 */

import type { MarketAnalysis, AIUsage, PaperOrder, PolymarketMarket } from "../types";
import type { AIProviderType } from "./aiProviders";
import { getModel, calculateModelCost, getProxyUrl } from "./aiProviders";
import {
  analyzeMarketsWithClaude,
  buildOSINTPrompt,
  extractJSON,
  type ClaudeResearchResult,
  type PerformanceHistory,
  type SkippedMarket,
} from "./claudeAI";

// ─── Constants ─────────────────────────────────────

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_KEY;

function log(...args: any[]) {
  console.log("[AIService]", ...args);
}

function localTimestamp(): string {
  return new Date().toISOString();
}

// ─── Rate Limiter (Gemini 250k TPM free tier) ──────
// Gemini 2.5 Flash free tier: 250k tokens/min → una sola llamada de ~300k puede chocar.
// Enforce mínimo 90s (1.5min) entre peticiones a Gemini para respetar TPM.

let _lastProviderCallTime: Record<string, number> = {};

function _loadProviderCallTimes() {
  try {
    const stored = localStorage.getItem('_aiService_providerCallTimes');
    if (stored) _lastProviderCallTime = JSON.parse(stored);
  } catch { /* ignore */ }
}
_loadProviderCallTimes();

function _persistProviderCallTime(key: string, time: number) {
  _lastProviderCallTime[key] = time;
  try {
    localStorage.setItem('_aiService_providerCallTimes', JSON.stringify(_lastProviderCallTime));
  } catch { /* localStorage full — ignore */ }
}

/**
 * Enforce rate limit for providers with TPM constraints (Gemini free tier).
 * Returns the wait time in ms, or 0 if no wait needed.
 */
async function enforceRateLimit(provider: AIProviderType, modelId: string): Promise<void> {
  const model = getModel(provider, modelId);
  const minInterval = model?.freeTier?.minIntervalMs;
  if (!minInterval) return; // No rate limit for this model

  const key = `${provider}:${modelId}`;
  const lastCall = _lastProviderCallTime[key] || 0;
  const now = Date.now();
  const elapsed = now - lastCall;

  if (lastCall > 0 && elapsed < minInterval) {
    const waitMs = minInterval - elapsed;
    const waitSecs = Math.ceil(waitMs / 1000);
    log(`⏳ Rate limit ${provider}/${modelId}: esperando ${waitSecs}s (TPM ${model.freeTier!.tokensPerMinute?.toLocaleString()} free tier)...`);
    await new Promise(resolve => setTimeout(resolve, waitMs));
  }

  _persistProviderCallTime(key, Date.now());
}

// ─── Main Entry Point ──────────────────────────────

/**
 * Analyze markets using the selected AI provider and model.
 * For Anthropic, delegates to the existing `analyzeMarketsWithClaude`.
 * For other providers, uses provider-specific adapters.
 * 
 * @param apiKey — API key from user's frontend config (not server secrets)
 */
export async function analyzeMarketsWithAI(
  provider: AIProviderType,
  modelId: string,
  markets: PolymarketMarket[],
  openOrders: PaperOrder[],
  bankroll: number,
  history?: PerformanceHistory,
  apiKey?: string,
): Promise<ClaudeResearchResult> {
  // Enforce rate limits (Gemini 250k TPM, etc.)
  await enforceRateLimit(provider, modelId);

  // For Anthropic, use the battle-tested existing implementation
  if (provider === "anthropic") {
    return analyzeMarketsWithClaude(markets, openOrders, bankroll, modelId, history, apiKey);
  }

  // For other providers, use the unified adapter
  return analyzeWithProvider(provider, modelId, markets, openOrders, bankroll, history, apiKey);
}

// ─── Generic Provider Adapter ──────────────────────

async function analyzeWithProvider(
  provider: AIProviderType,
  modelId: string,
  markets: PolymarketMarket[],
  openOrders: PaperOrder[],
  bankroll: number,
  history?: PerformanceHistory,
  apiKey?: string,
): Promise<ClaudeResearchResult> {
  const model = getModel(provider, modelId);
  if (!model) {
    throw new Error(`Modelo "${modelId}" no encontrado para proveedor "${provider}"`);
  }

  if (markets.length === 0) {
    return {
      analyses: [],
      skipped: [],
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, model: modelId, timestamp: localTimestamp() },
      summary: "No hay mercados que venzan en ≤1h para analizar.",
      prompt: "", rawResponse: "", responseTimeMs: 0,
    };
  }

  // Build prompt — same OSINT prompt for all providers
  let prompt = buildOSINTPrompt(markets, openOrders, bankroll, history);

  // Adapt prompt for providers without web search
  if (!model.hasWebSearch) {
    prompt = prompt.replace(
      /Research ALL .+ markets using web_search\./g,
      "Analyze ALL markets using your training data and reasoning.",
    );
    prompt = prompt.replace(/using web_search/g, "using your knowledge");
    prompt = prompt.replace(/Use as many web_search calls as you need/g, "Use your best reasoning");
    prompt = "NOTA: Este modelo no tiene acceso a búsqueda web. Usa tus datos de entrenamiento.\n\n" + prompt;
  }

  // Build request body per provider
  const requestBody = buildRequestBody(provider, modelId, prompt, model.hasWebSearch, model.maxOutput);

  // Include user's API key in request body (proxy extracts it and removes before forwarding)
  if (apiKey) {
    requestBody.apiKey = apiKey;
  }

  log(`📡 [${provider}/${modelId}] Enviando ${markets.length} mercados...`);
  log(`Prompt: ~${prompt.length} chars (~${Math.round(prompt.length / 4)} tokens est.)`);

  const proxyUrl = getProxyUrl(provider, SUPABASE_URL);
  const startTime = Date.now();

  const response = await fetch(proxyUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "apikey": SUPABASE_KEY,
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    log(`❌ ${provider} API error:`, response.status, errorBody);
    throw new Error(`${provider} API HTTP ${response.status}: ${errorBody.slice(0, 200)}`);
  }

  const data = await response.json();
  const elapsed = Date.now() - startTime;

  // Parse response per provider
  const parsed = parseProviderResponse(provider, data);

  const costUsd = calculateModelCost(modelId, provider, parsed.inputTokens, parsed.outputTokens);
  log(`✅ [${provider}] Respuesta: ${elapsed}ms, ${parsed.inputTokens}↓ / ${parsed.outputTokens}↑, costo: $${costUsd.toFixed(4)}`);

  if (parsed.webSearches > 0) {
    log(`🌐 Web searches: ${parsed.webSearches} realizadas`);
    parsed.searchQueries.forEach((q, i) => log(`   🔍 Search ${i + 1}: "${q}"`));
  }

  // Parse the analysis JSON from the text content
  const usage: AIUsage = {
    inputTokens: parsed.inputTokens,
    outputTokens: parsed.outputTokens,
    costUsd,
    model: modelId,
    timestamp: localTimestamp(),
    webSearches: parsed.webSearches,
    searchQueries: parsed.searchQueries,
  };

  try {
    const jsonStr = extractJSON(parsed.content);
    const result = JSON.parse(jsonStr);
    const summary = result.summary || "";

    const skipped: SkippedMarket[] = Array.isArray(result.skipped)
      ? result.skipped.map((s: any) => ({
          marketId: s.marketId || "",
          question: s.question || "",
          reason: s.reason || "Sin razón",
        }))
      : [];

    const analyses: MarketAnalysis[] = Array.isArray(result.recommendations)
      ? result.recommendations
          .filter((item: any) => item.recommendedSide && item.recommendedSide.toUpperCase() !== "SKIP")
          .map((item: any) => parseRecommendation(item))
      : [];

    return {
      analyses,
      skipped,
      usage,
      summary,
      prompt,
      rawResponse: parsed.content,
      responseTimeMs: elapsed,
    };
  } catch (err) {
    log(`❌ Error parseando JSON de ${provider}:`, err);
    return {
      analyses: [],
      skipped: [],
      usage,
      summary: `Error: No se pudo parsear la respuesta de ${provider}`,
      prompt,
      rawResponse: parsed.content,
      responseTimeMs: elapsed,
    };
  }
}

// ─── Request Builders ──────────────────────────────

function buildRequestBody(
  provider: AIProviderType,
  modelId: string,
  prompt: string,
  webSearch: boolean,
  maxOutput: number,
): any {
  switch (provider) {
    case "google":
      return buildGeminiRequest(modelId, prompt, webSearch, maxOutput);
    case "openai":
      return buildOpenAIRequest(modelId, prompt, webSearch, maxOutput);
    case "xai":
      return buildXAIRequest(modelId, prompt, webSearch, maxOutput);
    case "deepseek":
      return buildDeepSeekRequest(modelId, prompt, maxOutput);
    default:
      throw new Error(`Proveedor no soportado: ${provider}`);
  }
}

function buildGeminiRequest(modelId: string, prompt: string, webSearch: boolean, maxOutput: number) {
  return {
    model: modelId,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    ...(webSearch ? { tools: [{ google_search: {} }] } : {}),
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: Math.min(maxOutput, 65536),
    },
  };
}

function buildOpenAIRequest(modelId: string, prompt: string, webSearch: boolean, maxOutput: number) {
  const isReasoning = modelId.startsWith("o3") || modelId.startsWith("o4");
  return {
    model: modelId,
    messages: [{ role: "user", content: prompt }],
    ...(isReasoning ? {} : { temperature: 0.3 }),
    max_tokens: Math.min(maxOutput, 32768),
    ...(webSearch ? { tools: [{ type: "web_search_preview", search_context_size: "medium" }] } : {}),
  };
}

function buildXAIRequest(modelId: string, prompt: string, webSearch: boolean, maxOutput: number) {
  return {
    model: modelId,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.3,
    max_tokens: Math.min(maxOutput, 16384),
    ...(webSearch ? { search: { mode: "auto" } } : {}),
  };
}

function buildDeepSeekRequest(modelId: string, prompt: string, maxOutput: number) {
  return {
    model: modelId,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.3,
    max_tokens: Math.min(maxOutput, 8192),
  };
}

// ─── Response Parsers ──────────────────────────────

interface ParsedResponse {
  content: string;
  inputTokens: number;
  outputTokens: number;
  webSearches: number;
  searchQueries: string[];
}

function parseProviderResponse(provider: AIProviderType, data: any): ParsedResponse {
  switch (provider) {
    case "google":
      return parseGeminiResponse(data);
    case "openai":
    case "xai":
    case "deepseek":
      return parseOpenAIResponse(data);
    default:
      throw new Error(`Parser no implementado para: ${provider}`);
  }
}

function parseGeminiResponse(data: any): ParsedResponse {
  const candidates = data.candidates || [];
  const candidate = candidates[0];
  const parts = candidate?.content?.parts || [];
  const content = parts.map((p: any) => p.text || "").join("\n");

  const usage = data.usageMetadata || {};
  const inputTokens = usage.promptTokenCount || 0;
  const outputTokens = usage.candidatesTokenCount || 0;

  // Extract web search info from grounding metadata
  const grounding = candidate?.groundingMetadata;
  const searchQueries: string[] = grounding?.webSearchQueries || [];
  const webSearches = searchQueries.length;

  return { content, inputTokens, outputTokens, webSearches, searchQueries };
}

function parseOpenAIResponse(data: any): ParsedResponse {
  const choices = data.choices || [];
  const content = choices[0]?.message?.content || "";

  const usage = data.usage || {};
  const inputTokens = usage.prompt_tokens || 0;
  const outputTokens = usage.completion_tokens || 0;

  // OpenAI web search results are embedded in the response
  // xAI and DeepSeek use the same format
  return { content, inputTokens, outputTokens, webSearches: 0, searchQueries: [] };
}

// ─── Recommendation Parser ─────────────────────────

function parseRecommendation(item: any): MarketAnalysis {
  let side = (item.recommendedSide || "SKIP").toUpperCase();
  let pReal = Number.parseFloat(item.pReal) || 0;
  const pMarket = Number.parseFloat(item.pMarket) || 0;
  let pLow = Number.parseFloat(item.pLow) || 0;
  let pHigh = Number.parseFloat(item.pHigh) || 0;

  // AUTO-FIX: Claude/AI sometimes reports pReal as P(recommended side)
  if (side === "NO" && pReal > 0.5) {
    log(`⚠️ AUTO-FIX pReal: side=NO but pReal=${pReal} > 0.50 → Flipping to ${(1 - pReal).toFixed(3)}`);
    pReal = 1 - pReal;
    const origLow = pLow;
    pLow = 1 - pHigh;
    pHigh = 1 - origLow;
  }

  // SIDE-CONSISTENCY CHECK
  if (pMarket > 0.01 && pMarket < 0.99) {
    if (side === "YES" && pReal < pMarket) {
      log(`⚠️ SIDE-FIX: side=YES but pReal(${pReal.toFixed(3)}) < pMarket(${pMarket.toFixed(3)}) → auto-flip to NO`);
      side = "NO";
    } else if (side === "NO" && pReal > pMarket) {
      log(`⚠️ SIDE-FIX: side=NO but pReal(${pReal.toFixed(3)}) > pMarket(${pMarket.toFixed(3)}) → auto-flip to YES`);
      side = "YES";
    }
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
    confidence: Number.parseInt(item.confidence) || 0,
    recommendedSide: side,
    reasoning: item.reasoning || "",
    sources: item.sources || [],
    evNet: Number.parseFloat(item.evNet) || undefined,
    maxEntryPrice: Number.parseFloat(item.maxEntryPrice) || undefined,
    sizeUsd: Number.parseFloat(item.sizeUsd) || undefined,
    orderType: item.orderType || undefined,
    clusterId: item.clusterId || null,
    risks: item.risks || "",
    resolutionCriteria: item.resolutionCriteria || "",
    category: item.category || undefined,
  };
}

// ─── API Key Test ──────────────────────────────────
// Hace una llamada mínima directa a la API del proveedor para validar la key.
// No pasa por proxy — contacta directamente para confirmar autenticación.

export interface ApiKeyTestResult {
  valid: boolean;
  provider: AIProviderType;
  message: string;
  latencyMs: number;
}

/**
 * Testea una API key haciendo una petición mínima al proveedor.
 * Prompt ultra-corto ("Say hi") para gastar mínimos tokens (~20 tokens input).
 */
export async function testApiKey(
  provider: AIProviderType,
  apiKey: string,
): Promise<ApiKeyTestResult> {
  if (!apiKey || apiKey.trim().length < 5) {
    return { valid: false, provider, message: "API key vacía o muy corta", latencyMs: 0 };
  }

  const start = Date.now();

  try {
    let response: Response;

    // Usamos endpoints GET de listado de modelos para validar la key
    // sin consumir tokens ni activar rate limits
    switch (provider) {
      case "anthropic":
        // GET /v1/models — solo lista modelos, cero tokens
        response = await fetch("https://api.anthropic.com/v1/models?limit=1", {
          method: "GET",
          headers: {
            "x-api-key": apiKey.trim(),
            "anthropic-version": "2023-06-01",
          },
        });
        break;

      case "google":
        // GET /v1beta/models — solo lista modelos, cero tokens
        response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey.trim()}&pageSize=1`,
          { method: "GET" },
        );
        break;

      case "openai":
        // GET /v1/models — solo lista modelos, cero tokens
        response = await fetch("https://api.openai.com/v1/models", {
          method: "GET",
          headers: { "Authorization": `Bearer ${apiKey.trim()}` },
        });
        break;

      case "xai":
        // GET /v1/models — compatible con OpenAI, cero tokens
        response = await fetch("https://api.x.ai/v1/models", {
          method: "GET",
          headers: { "Authorization": `Bearer ${apiKey.trim()}` },
        });
        break;

      case "deepseek":
        // GET /models — compatible con OpenAI, cero tokens
        response = await fetch("https://api.deepseek.com/models", {
          method: "GET",
          headers: { "Authorization": `Bearer ${apiKey.trim()}` },
        });
        break;
    }

    const latencyMs = Date.now() - start;

    if (response.ok) {
      return {
        valid: true,
        provider,
        message: `✅ API key válida (${latencyMs}ms)`,
        latencyMs,
      };
    }

    // Parse error
    const errorData = await response.json().catch(() => ({}));
    const errorMsg =
      errorData?.error?.message ||
      errorData?.error?.type ||
      `HTTP ${response.status}`;

    // Common error patterns
    if (response.status === 401 || response.status === 403) {
      return {
        valid: false,
        provider,
        message: `API key inválida o sin permisos: ${errorMsg}`,
        latencyMs,
      };
    }

    if (response.status === 429) {
      // Rate limited pero la key SÍ es válida (el servidor la reconoció)
      return {
        valid: true,
        provider,
        message: `✅ API key válida (${latencyMs}ms)`,
        latencyMs,
      };
    }

    return {
      valid: false,
      provider,
      message: `Error ${response.status}: ${errorMsg}`,
      latencyMs,
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    return {
      valid: false,
      provider,
      message: `Error de conexión: ${(err as Error).message}`,
      latencyMs,
    };
  }
}
