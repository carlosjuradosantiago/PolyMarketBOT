// ═══════════════════════════════════════════════════════════════════
// Edge Function: cancel-order
// Cancela una orden pendiente/filled y devuelve el balance al portfolio.
// Body: { orderId: string }
// ═══════════════════════════════════════════════════════════════════

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Método no permitido" }, 405);
  }

  try {
    const { orderId } = await req.json();
    if (!orderId) {
      return jsonResponse({ error: "orderId requerido" }, 400);
    }

    // 1. Buscar la orden
    const { data: order, error: fetchErr } = await supabase
      .from("orders")
      .select("*")
      .eq("id", orderId)
      .single();

    if (fetchErr || !order) {
      return jsonResponse({ error: `Orden no encontrada: ${orderId}` }, 404);
    }

    // Solo se pueden cancelar órdenes pending o filled
    if (!["pending", "filled"].includes(order.status)) {
      return jsonResponse({
        error: `No se puede cancelar orden con estado '${order.status}'`,
      }, 400);
    }

    // 2. Actualizar estado de la orden
    const { error: updateErr } = await supabase
      .from("orders")
      .update({
        status: "cancelled",
        resolved_at: new Date().toISOString(),
      })
      .eq("id", orderId);

    if (updateErr) throw new Error(`Error actualizando orden: ${updateErr.message}`);

    // 3. Devolver el costo al portfolio
    const refundAmount = order.total_cost || order.amount || 0;
    if (refundAmount > 0) {
      const { error: rpcErr } = await supabase.rpc("add_balance", { amount: refundAmount });
      if (rpcErr) throw new Error(`Error devolviendo balance: ${rpcErr.message}`);
    }

    // 4. Log de actividad
    const marketName = (order.market_question || order.market_slug || orderId).slice(0, 60);
    await supabase.from("activities").insert({
      timestamp: new Date().toISOString(),
      message: `🚫 Orden cancelada: ${marketName} — $${refundAmount.toFixed(2)} devueltos`,
      entry_type: "Info",
    });

    return jsonResponse({
      ok: true,
      message: `Orden ${orderId} cancelada`,
      refunded: refundAmount,
    });

  } catch (e: unknown) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error("[cancel-order]", errMsg);
    return jsonResponse({ ok: false, error: errMsg }, 500);
  }
});
