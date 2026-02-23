/**
 * AI Providers Registry — Complete catalog of supported AI providers,
 * their models, pricing, free tiers, and capabilities.
 * 
 * This is the SINGLE SOURCE OF TRUTH for all provider/model information.
 */

// ─── Types ─────────────────────────────────────────

export type AIProviderType = "anthropic" | "google" | "openai" | "xai" | "deepseek";

export interface FreeTierInfo {
  dailyRequests: number;
  tokensPerMinute?: number;     // TPM limit (e.g. Gemini 2.5 Flash = 250k)
  requestsPerMinute?: number;   // RPM limit (e.g. Gemini 2.5 Flash = 10)
  minIntervalMs?: number;       // minimum ms between requests to respect rate limits
  description: string;
}

export interface AIModelDef {
  id: string;
  name: string;
  provider: AIProviderType;
  tag: string;
  inputPrice: number;       // $ per 1M input tokens
  outputPrice: number;      // $ per 1M output tokens
  hasWebSearch: boolean;
  contextWindow: number;    // max input tokens
  maxOutput: number;        // max output tokens
  freeTier?: FreeTierInfo;
  note?: string;            // extra info (e.g. "thinking tokens billed at output rate")
}

export interface AIProviderDef {
  id: AIProviderType;
  name: string;
  icon: string;
  color: string;            // brand accent color (hex)
  bgGradient: string;       // CSS gradient for cards
  website: string;
  apiKeyUrl: string;
  apiKeyPrefix: string;     // hint for the placeholder (e.g. "sk-ant-api03-...")
  webSearchMethod: string;  // how this provider does web search
  models: AIModelDef[];
}

// ─── Provider Definitions ───────────────────────────

export const AI_PROVIDERS: AIProviderDef[] = [
  // ── Anthropic (Claude) ──
  {
    id: "anthropic",
    name: "Anthropic",
    icon: "✦",
    color: "#D97706",
    bgGradient: "from-amber-500/10 to-orange-600/5",
    website: "anthropic.com",
    apiKeyUrl: "https://console.anthropic.com/settings/keys",
    apiKeyPrefix: "sk-ant-api03-...",
    webSearchMethod: "web_search tool (nativo)",
    models: [
      { id: "claude-3-5-haiku-20241022", name: "Claude 3.5 Haiku",  provider: "anthropic", tag: "Más Barato",     inputPrice: 0.80, outputPrice: 4,  hasWebSearch: true, contextWindow: 200000, maxOutput: 8192 },
      { id: "claude-haiku-4-5",          name: "Claude Haiku 4.5",  provider: "anthropic", tag: "Rápido",         inputPrice: 1,    outputPrice: 5,  hasWebSearch: true, contextWindow: 200000, maxOutput: 8192 },
      { id: "claude-sonnet-4-20250514",  name: "Claude Sonnet 4",   provider: "anthropic", tag: "Económico",      inputPrice: 3,    outputPrice: 15, hasWebSearch: true, contextWindow: 200000, maxOutput: 16384 },
      { id: "claude-sonnet-4-5",         name: "Claude Sonnet 4.5", provider: "anthropic", tag: "Mejor Valor",    inputPrice: 3,    outputPrice: 15, hasWebSearch: true, contextWindow: 200000, maxOutput: 16384 },
      { id: "claude-opus-4-5",           name: "Claude Opus 4.5",   provider: "anthropic", tag: "Inteligente",    inputPrice: 5,    outputPrice: 25, hasWebSearch: true, contextWindow: 200000, maxOutput: 16384 },
      { id: "claude-opus-4-6",           name: "Claude Opus 4.6",   provider: "anthropic", tag: "Máxima Calidad", inputPrice: 5,    outputPrice: 25, hasWebSearch: true, contextWindow: 200000, maxOutput: 16384 },
    ],
  },

  // ── Google (Gemini) ──
  {
    id: "google",
    name: "Google",
    icon: "◆",
    color: "#4285F4",
    bgGradient: "from-blue-500/10 to-cyan-500/5",
    website: "ai.google.dev",
    apiKeyUrl: "https://aistudio.google.com/apikey",
    apiKeyPrefix: "AIzaSy...",
    webSearchMethod: "Google Search grounding",
    models: [
      { id: "gemini-2.0-flash",  name: "Gemini 2.0 Flash",  provider: "google", tag: "Free Tier",    inputPrice: 0.10, outputPrice: 0.40, hasWebSearch: true, contextWindow: 1000000, maxOutput: 8192, freeTier: { dailyRequests: 1500, description: "1,500 req/día gratis (Search: 500 RPD free)" } },
      { id: "gemini-2.5-flash",  name: "Gemini 2.5 Flash",  provider: "google", tag: "⭐ Mejor Free", inputPrice: 0.15, outputPrice: 0.60, hasWebSearch: true, contextWindow: 1000000, maxOutput: 65536, freeTier: { dailyRequests: 20, tokensPerMinute: 250_000, requestsPerMinute: 5, minIntervalMs: 15_000, description: "20 req/día, 5 RPM, 250k TPM (Search: 500 RPD free)" }, note: "Thinking tokens: $3.50/M output" },
      { id: "gemini-2.5-pro",    name: "Gemini 2.5 Pro",    provider: "google", tag: "Pro",          inputPrice: 1.25, outputPrice: 10,   hasWebSearch: false, contextWindow: 1000000, maxOutput: 65536, freeTier: { dailyRequests: 25, requestsPerMinute: 5, minIntervalMs: 15_000, description: "25 req/día, 5 RPM (⚠️ SIN Google Search en free)" }, note: ">200K ctx: $2.50/$15 per M. Search: solo en plan pago ($35/1K)" },
    ],
  },

  // ── OpenAI ──
  {
    id: "openai",
    name: "OpenAI",
    icon: "◉",
    color: "#10A37F",
    bgGradient: "from-emerald-500/10 to-green-600/5",
    website: "platform.openai.com",
    apiKeyUrl: "https://platform.openai.com/api-keys",
    apiKeyPrefix: "sk-proj-...",
    webSearchMethod: "web_search_preview tool",
    models: [
      { id: "gpt-4o-mini",   name: "GPT-4o Mini",   provider: "openai", tag: "Más Barato", inputPrice: 0.15,  outputPrice: 0.60, hasWebSearch: true,  contextWindow: 128000, maxOutput: 16384 },
      { id: "gpt-4.1-mini",  name: "GPT-4.1 Mini",  provider: "openai", tag: "Rápido",     inputPrice: 0.40,  outputPrice: 1.60, hasWebSearch: true,  contextWindow: 1000000, maxOutput: 32768 },
      { id: "gpt-4o",        name: "GPT-4o",         provider: "openai", tag: "Versátil",   inputPrice: 2.50,  outputPrice: 10,   hasWebSearch: true,  contextWindow: 128000, maxOutput: 16384 },
      { id: "gpt-4.1",       name: "GPT-4.1",        provider: "openai", tag: "Mejor Valor", inputPrice: 2,    outputPrice: 8,    hasWebSearch: true,  contextWindow: 1000000, maxOutput: 32768 },
      { id: "o4-mini",       name: "o4 Mini",        provider: "openai", tag: "Razonamiento", inputPrice: 1.10, outputPrice: 4.40, hasWebSearch: true,  contextWindow: 200000, maxOutput: 100000, note: "Reasoning model" },
      { id: "o3",            name: "o3",             provider: "openai", tag: "Máx Calidad", inputPrice: 10,   outputPrice: 40,   hasWebSearch: true,  contextWindow: 200000, maxOutput: 100000, note: "Reasoning model" },
    ],
  },

  // ── xAI (Grok) ──
  {
    id: "xai",
    name: "xAI",
    icon: "✕",
    color: "#FFFFFF",
    bgGradient: "from-gray-400/10 to-slate-500/5",
    website: "x.ai",
    apiKeyUrl: "https://console.x.ai/team/default/api-keys",
    apiKeyPrefix: "xai-...",
    webSearchMethod: "Live search (nativo)",
    models: [
      { id: "grok-3-mini",  name: "Grok 3 Mini",  provider: "xai", tag: "Barato",     inputPrice: 0.30, outputPrice: 0.50, hasWebSearch: true, contextWindow: 131072, maxOutput: 16384 },
      { id: "grok-3",       name: "Grok 3",       provider: "xai", tag: "Completo",   inputPrice: 3,    outputPrice: 15,   hasWebSearch: true, contextWindow: 131072, maxOutput: 16384 },
    ],
  },

  // ── DeepSeek ──
  {
    id: "deepseek",
    name: "DeepSeek",
    icon: "◈",
    color: "#0066FF",
    bgGradient: "from-blue-600/10 to-indigo-500/5",
    website: "deepseek.com",
    apiKeyUrl: "https://platform.deepseek.com/api_keys",
    apiKeyPrefix: "sk-...",
    webSearchMethod: "Sin búsqueda web (usa datos de entrenamiento)",
    models: [
      { id: "deepseek-chat",     name: "DeepSeek V3",  provider: "deepseek", tag: "Ultra Barato", inputPrice: 0.27, outputPrice: 1.10, hasWebSearch: false, contextWindow: 64000, maxOutput: 8192, note: "Sin web search — usa datos de entrenamiento" },
      { id: "deepseek-reasoner", name: "DeepSeek R1",  provider: "deepseek", tag: "Razonamiento", inputPrice: 0.55, outputPrice: 2.19, hasWebSearch: false, contextWindow: 64000, maxOutput: 8192, note: "Reasoning model, sin web search" },
    ],
  },
];

// ─── Helper Functions ───────────────────────────────

/** Get provider definition by ID */
export function getProvider(id: AIProviderType): AIProviderDef {
  return AI_PROVIDERS.find(p => p.id === id) || AI_PROVIDERS[0];
}

/** Get model definition by provider + model ID */
export function getModel(provider: AIProviderType, modelId: string): AIModelDef | undefined {
  return getProvider(provider).models.find(m => m.id === modelId);
}

/** Get all models across all providers */
export function getAllModels(): AIModelDef[] {
  return AI_PROVIDERS.flatMap(p => p.models);
}

/** Calculate token cost for a specific model, respecting free tier */
export function calculateModelCost(
  modelId: string,
  provider: AIProviderType,
  inputTokens: number,
  outputTokens: number,
  isFreeTier: boolean = false,
): number {
  if (isFreeTier) return 0;
  const model = getModel(provider, modelId);
  if (!model) return 0;
  return (inputTokens / 1_000_000) * model.inputPrice + (outputTokens / 1_000_000) * model.outputPrice;
}

/**
 * Average tokens per cycle based on real usage data (Feb 17-21, 2026).
 * Bot does ~5 API calls per cycle analyzing 8 markets in batches.
 * Each call sends massive market data prompts (~150K-220K input tokens).
 * 
 * Real averages from ai_usage_history:
 *   Feb 17: 1,109,953 in / 6,060 out ($3.42)
 *   Feb 18: 1,108,517 in / 6,882 out ($3.43)
 *   Feb 19: 1,192,361 in / 6,545 out ($3.68)
 *   Feb 21:   886,546 in / 5,882 out ($2.75)
 *   Average: ~1,074,344 in / ~6,342 out per cycle
 */
const AVG_INPUT_TOKENS_PER_CYCLE  = 1_074_344;
const AVG_OUTPUT_TOKENS_PER_CYCLE = 6_342;

/** Estimate cost per cycle for a model (based on real usage averages) */
export function estimateCycleCost(model: AIModelDef): number {
  if (model.freeTier) return 0;
  return (model.inputPrice * AVG_INPUT_TOKENS_PER_CYCLE + model.outputPrice * AVG_OUTPUT_TOKENS_PER_CYCLE) / 1_000_000;
}

/**
 * Estimate monthly cost for a model.
 * Bot runs 1 cycle/day via pg_cron (0 11 * * *).
 * Monthly = cycleCost × 30 days.
 * Free tier models return 0.
 */
export function estimateMonthlyCost(model: AIModelDef): number {
  if (model.freeTier) return 0;
  return estimateCycleCost(model) * 30;
}

/** Check if a model has free tier */
export function hasFreeTier(provider: AIProviderType, modelId: string): boolean {
  const model = getModel(provider, modelId);
  return !!model?.freeTier;
}

/** Get proxy URL for a provider */
export function getProxyUrl(provider: AIProviderType, supabaseUrl: string): string {
  const proxyMap: Record<AIProviderType, string> = {
    anthropic: `${supabaseUrl}/functions/v1/claude-proxy`,
    google:    `${supabaseUrl}/functions/v1/gemini-proxy`,
    openai:    `${supabaseUrl}/functions/v1/openai-proxy`,
    xai:       `${supabaseUrl}/functions/v1/xai-proxy`,
    deepseek:  `${supabaseUrl}/functions/v1/deepseek-proxy`,
  };
  return proxyMap[provider];
}

/** Get the API endpoint URL for a provider (direct, for Edge Functions) */
export function getDirectApiUrl(provider: AIProviderType, modelId?: string): string {
  switch (provider) {
    case "anthropic": return "https://api.anthropic.com/v1/messages";
    case "google":    return `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`;
    case "openai":    return "https://api.openai.com/v1/chat/completions";
    case "xai":       return "https://api.x.ai/v1/chat/completions";
    case "deepseek":  return "https://api.deepseek.com/chat/completions";
  }
}

/** Build provider-specific headers for direct API calls */
export function getApiHeaders(provider: AIProviderType, apiKey: string): Record<string, string> {
  switch (provider) {
    case "anthropic":
      return {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      };
    case "google":
      return {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      };
    case "openai":
    case "xai":
    case "deepseek":
      return {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      };
  }
}
