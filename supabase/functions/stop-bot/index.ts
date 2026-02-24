// Edge Function: stop-bot
// Detiene el bot (pone is_running=false en bot_state)
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Método no permitido" }), { status: 405 });
  }
  // TODO: Actualizar bot_state.is_running=false
  return new Response(JSON.stringify({ ok: true, message: "Bot detenido (borrador)" }), { status: 200 });
});
