// Supabase Edge Function — Secure proxy for Claude API with web_search
// Runs on Deno Deploy — NO timeout limits like Vercel Hobby (10s)
// The CLAUDE_API_KEY is stored as a Supabase secret, never exposed to browser

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json();

    // Accept API key from request body (user-provided) or fallback to env secret
    const apiKey = body.apiKey || Deno.env.get("CLAUDE_API_KEY");
    if (!apiKey) {
      console.error("[Claude Proxy] No API key available (neither body.apiKey nor CLAUDE_API_KEY secret)");
      return new Response(JSON.stringify({ error: "CLAUDE_API_KEY not configured. Ingresa tu API key en Settings." }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Remove apiKey from payload before forwarding to Anthropic
    const { apiKey: _removed, ...claudePayload } = body;

    // Log request info for debugging
    const model = claudePayload?.model || "unknown";
    const toolNames = (claudePayload?.tools || []).map((t: any) => t.type || t.name).join(", ");
    const keySource = body.apiKey ? "body" : "env";
    console.log(`[Claude Proxy] model=${model}, tools=[${toolNames}], max_tokens=${claudePayload?.max_tokens}, key=${keySource}`);

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(claudePayload),
    });

    const data = await response.json();

    // Log response info
    const contentTypes = (data.content || []).map((b: any) => b.type);
    const webSearches = contentTypes.filter((t: string) => t === "server_tool_use").length;
    console.log(`[Claude Proxy] status=${response.status}, blocks=${contentTypes.length}, webSearches=${webSearches}, tokens=${data.usage?.input_tokens}↓/${data.usage?.output_tokens}↑`);

    if (!response.ok) {
      console.error(`[Claude Proxy] API error ${response.status}:`, JSON.stringify(data).slice(0, 500));
      return new Response(JSON.stringify(data), {
        status: response.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[Claude Proxy] Error:", err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
