// Supabase Edge Function — Secure proxy for Google Gemini API
// Forwards requests to generativelanguage.googleapis.com
// GEMINI_API_KEY stored as a Supabase secret

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Accept API key from request body (client-sent) or fallback to env secret
  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const apiKey = body.apiKey || Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) {
    console.error("[Gemini Proxy] No API key available");
    return new Response(JSON.stringify({ error: "GEMINI_API_KEY not configured" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Extract model and build Gemini-specific payload
  const model = body.model || "gemini-2.0-flash";
  const { apiKey: _removed, model: _m, ...geminiPayload } = body;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  console.log(`[Gemini Proxy] model=${model}, hasSearch=${!!geminiPayload.tools?.length}, maxTokens=${geminiPayload.generationConfig?.maxOutputTokens}`);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(geminiPayload),
    });

    const data = await response.json();

    // Log response info
    const parts = data.candidates?.[0]?.content?.parts?.length || 0;
    const searches = data.candidates?.[0]?.groundingMetadata?.webSearchQueries?.length || 0;
    const usage = data.usageMetadata || {};
    console.log(`[Gemini Proxy] status=${response.status}, parts=${parts}, webSearches=${searches}, tokens=${usage.promptTokenCount || 0}↓/${usage.candidatesTokenCount || 0}↑`);

    if (!response.ok) {
      console.error(`[Gemini Proxy] API error ${response.status}:`, JSON.stringify(data).slice(0, 500));
    }

    return new Response(JSON.stringify(data), {
      status: response.ok ? 200 : response.status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[Gemini Proxy] Error:", err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
