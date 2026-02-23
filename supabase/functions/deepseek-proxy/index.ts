// Supabase Edge Function — Secure proxy for DeepSeek API
// Forwards requests to api.deepseek.com/chat/completions
// DEEPSEEK_API_KEY stored as a Supabase secret

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

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const apiKey = body.apiKey || Deno.env.get("DEEPSEEK_API_KEY");
  if (!apiKey) {
    console.error("[DeepSeek Proxy] No API key available");
    return new Response(JSON.stringify({ error: "DEEPSEEK_API_KEY not configured" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { apiKey: _removed, ...deepseekPayload } = body;

  const model = deepseekPayload.model || "deepseek-chat";
  console.log(`[DeepSeek Proxy] model=${model}, max_tokens=${deepseekPayload.max_tokens}`);

  try {
    const response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify(deepseekPayload),
    });

    const data = await response.json();

    const usage = data.usage || {};
    console.log(`[DeepSeek Proxy] status=${response.status}, tokens=${usage.prompt_tokens || 0}↓/${usage.completion_tokens || 0}↑`);

    if (!response.ok) {
      console.error(`[DeepSeek Proxy] API error ${response.status}:`, JSON.stringify(data).slice(0, 500));
    }

    return new Response(JSON.stringify(data), {
      status: response.ok ? 200 : response.status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[DeepSeek Proxy] Error:", err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
