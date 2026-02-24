// ═══════════════════════════════════════════════════════════════════
// Edge Function: place-order
// Crea una paper order manual desde el frontend (dashboard).
// Body: { marketId, conditionId, question, slug, outcomes, outcomePrices,
//         outcomeIndex, side, amount, endDate? }
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

function generateOrderId(): string {
  return `paper_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Método no permitido" }, 405);
  }

  try {
    const body = await req.json();
    const {
      marketId,
      conditionId,
      question,
      slug,
      outcomes,
      outcomePrices,
      outcomeIndex,
      side,
      amount,
      endDate,
    } = body;

    // ─── Validaciones ────────────────────────────
    if (!marketId || !question || !outcomes || !outcomePrices || outcomeIndex === undefined || !amount) {
      return jsonResponse({ error: "Campos requeridos: marketId, question, outcomes, outcomePrices, outcomeIndex, amount" }, 400);
    }

    const price = parseFloat(outcomePrices[outcomeIndex]);
    if (isNaN(price) || price <= 0 || price >= 1) {
      return jsonResponse({ error: `Precio inválido: ${outcomePrices[outcomeIndex]}` }, 400);
    }

    const betAmount = parseFloat(amount);
    if (isNaN(betAmount) || betAmount <= 0) {
      return jsonResponse({ error: "Monto inválido" }, 400);
    }

    // Block lottery-ticket prices (< 3¢)
    if (price < 0.03) {
      return jsonResponse({
        error: `Precio ${(price * 100).toFixed(1)}¢ demasiado bajo (mín 3¢). Ticket de lotería rechazado.`,
      }, 400);
    }

    // ─── Cargar portfolio ────────────────────────
    const { data: pf, error: pfErr } = await supabase
      .from("portfolio")
      .select("balance")
      .eq("id", 1)
      .single();

    if (pfErr || !pf) {
      return jsonResponse({ error: "No se pudo cargar el portfolio" }, 500);
    }

    const balance = pf.balance;

    // ─── Calcular equity y cap 10% ──────────────
    const { data: openOrders } = await supabase
      .from("orders")
      .select("total_cost")
      .in("status", ["pending", "filled"]);

    const invested = (openOrders || []).reduce((s: number, o: { total_cost: number }) => s + (o.total_cost || 0), 0);
    const equity = balance + invested;
    const maxBet = equity * 0.10;

    if (betAmount > maxBet) {
      return jsonResponse({
        error: `Max bet: $${maxBet.toFixed(2)} (10% de equity $${equity.toFixed(2)})`,
      }, 400);
    }

    // ─── Calcular cantidad de shares ────────────
    const quantity = betAmount / price;
    const totalCost = quantity * price;

    if (totalCost > balance) {
      return jsonResponse({
        error: `Balance insuficiente. Necesitas $${totalCost.toFixed(2)}, tienes $${balance.toFixed(2)} (equity $${equity.toFixed(2)})`,
      }, 400);
    }

    // ─── Crear orden ─────────────────────────────
    const orderId = generateOrderId();
    const now = new Date().toISOString();

    const { error: insertErr } = await supabase.from("orders").insert({
      id: orderId,
      market_id: marketId,
      condition_id: conditionId || "",
      market_question: question,
      market_slug: slug || null,
      outcome: outcomes[outcomeIndex],
      outcome_index: outcomeIndex,
      side: side || "buy",
      price,
      quantity,
      total_cost: totalCost,
      potential_payout: quantity, // $1 per share if wins
      status: "filled", // Paper orders fill instantly
      created_at: now,
      end_date: endDate || null,
    });

    if (insertErr) throw new Error(`Error insertando orden: ${insertErr.message}`);

    // ─── Deducir balance atómicamente ────────────
    const { error: rpcErr } = await supabase.rpc("deduct_balance", { amount: totalCost });
    if (rpcErr) throw new Error(`Error deduciendo balance: ${rpcErr.message}`);

    // ─── Log de actividad ────────────────────────
    await supabase.from("activities").insert({
      timestamp: now,
      message: `🎯 MANUAL: ${outcomes[outcomeIndex]} "${question.slice(0, 50)}..." @ ${(price * 100).toFixed(0)}¢ | $${totalCost.toFixed(2)}`,
      entry_type: "Order",
    });

    return jsonResponse({
      ok: true,
      order: {
        id: orderId,
        marketId,
        outcome: outcomes[outcomeIndex],
        price,
        quantity,
        totalCost,
        potentialPayout: quantity,
      },
      newBalance: balance - totalCost,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[place-order] Error:", msg);
    return jsonResponse({ ok: false, error: msg }, 500);
  }
});
