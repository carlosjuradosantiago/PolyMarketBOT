/**
 * API Key test utility — validates provider keys via proxy Edge Functions.
 * Envía "hi" con max_tokens=1 para consumo prácticamente cero.
 */
import type { AIProviderType } from "./aiProviders";
import { getProxyUrl } from "./aiProviders";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_KEY;

export interface ApiKeyTestResult {
  valid: boolean;
  provider: AIProviderType;
  message: string;
  latencyMs: number;
}

export async function testApiKey(
  provider: AIProviderType,
  apiKey: string,
): Promise<ApiKeyTestResult> {
  if (!apiKey || apiKey.trim().length < 5) {
    return { valid: false, provider, message: "API key vacía o muy corta", latencyMs: 0 };
  }

  const start = Date.now();

  try {
    const proxyUrl = getProxyUrl(provider, SUPABASE_URL);
    let requestBody: Record<string, unknown>;

    switch (provider) {
      case "anthropic":
        requestBody = {
          apiKey: apiKey.trim(),
          model: "claude-3-5-haiku-20241022",
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        };
        break;
      case "google":
        requestBody = {
          apiKey: apiKey.trim(),
          model: "gemini-2.0-flash",
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
          generationConfig: { maxOutputTokens: 1 },
        };
        break;
      case "openai":
        requestBody = {
          apiKey: apiKey.trim(),
          model: "gpt-4o-mini",
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        };
        break;
      case "xai":
        requestBody = {
          apiKey: apiKey.trim(),
          model: "grok-3-mini",
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        };
        break;
      case "deepseek":
        requestBody = {
          apiKey: apiKey.trim(),
          model: "deepseek-chat",
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        };
        break;
    }

    const response = await fetch(proxyUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SUPABASE_KEY}`,
        "apikey": SUPABASE_KEY,
      },
      body: JSON.stringify(requestBody),
    });

    const latencyMs = Date.now() - start;
    const data = await response.json().catch(() => ({}));

    if (response.ok) {
      return { valid: true, provider, message: `API key válida (${latencyMs}ms)`, latencyMs };
    }

    const errorMsg =
      data?.error?.message ||
      data?.error?.type ||
      data?.error ||
      `HTTP ${response.status}`;

    if (response.status === 401 || response.status === 403) {
      return { valid: false, provider, message: `API key inválida o sin permisos: ${errorMsg}`, latencyMs };
    }

    // 429 = rate limited pero key SÍ es válida
    if (response.status === 429) {
      return { valid: true, provider, message: `API key válida (${latencyMs}ms)`, latencyMs };
    }

    return {
      valid: false, provider,
      message: `Error ${response.status}: ${typeof errorMsg === "string" ? errorMsg : JSON.stringify(errorMsg)}`,
      latencyMs,
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    return { valid: false, provider, message: `Error de conexión: ${(err as Error).message}`, latencyMs };
  }
}
