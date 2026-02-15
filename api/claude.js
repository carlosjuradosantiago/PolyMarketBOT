// Vercel Serverless Function — Secure proxy for Claude API
// The API key lives server-side only (never exposed to browser)
// web_search tool is forwarded to Anthropic for live internet access

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "CLAUDE_API_KEY not configured on server" });
  }

  try {
    // Log request info (tools, model) for debugging
    const body = req.body;
    const model = body?.model || "unknown";
    const toolNames = (body?.tools || []).map(t => t.type || t.name).join(", ");
    console.log(`[Claude Proxy] model=${model}, tools=[${toolNames}], max_tokens=${body?.max_tokens}`);

    // 115s timeout — leaves headroom within Vercel's 120s maxDuration
    // web_search can take 60-90s with multiple searches
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 115000);

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const data = await response.json();

    // Log response info
    const contentTypes = (data.content || []).map(b => b.type);
    const webSearches = contentTypes.filter(t => t === "server_tool_use").length;
    console.log(`[Claude Proxy] status=${response.status}, blocks=${contentTypes.length}, webSearches=${webSearches}, tokens=${data.usage?.input_tokens}↓/${data.usage?.output_tokens}↑`);

    if (!response.ok) {
      console.error(`[Claude Proxy] API error ${response.status}:`, JSON.stringify(data).slice(0, 500));
      return res.status(response.status).json(data);
    }

    return res.status(200).json(data);
  } catch (err) {
    if (err.name === "AbortError") {
      console.error("[Claude Proxy] Request timed out after 115s (web_search may need more time)");
      return res.status(504).json({ error: "Claude API request timed out (115s). Web search may require more time." });
    }
    console.error("[Claude Proxy] Error:", err);
    return res.status(500).json({ error: err.message });
  }
}
