/**
 * Edge Function callers — TODA mutación va por el backend.
 * El frontend SOLO lee datos y llama estas funciones para acciones.
 */

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_KEY as string;

interface EdgeFunctionResult {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

async function callEdgeFunction(
  name: string,
  method: "GET" | "POST" = "POST",
  body?: Record<string, unknown>,
): Promise<EdgeFunctionResult> {
  const url = `${SUPABASE_URL}/functions/v1/${name}`;
  try {
    const resp = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
      body: method === "POST" && body ? JSON.stringify(body) : undefined,
    });
    const data = await resp.json();
    return data as EdgeFunctionResult;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[EF] ${name} failed:`, msg);
    return { ok: false, error: msg };
  }
}

// ── Ejecutar ciclo de trading manual ──
export interface RunCycleResult extends EdgeFunctionResult {
  betsPlaced?: number;
  recommendations?: number;
  poolSize?: number;
  totalMarkets?: number;
  costUsd?: number;
  elapsedMs?: number;
  balance?: number;
}

export async function callRunCycle(): Promise<RunCycleResult> {
  return callEdgeFunction("run-cycle", "POST") as Promise<RunCycleResult>;
}

// ── Detener bot ──
export async function callStopBot(): Promise<EdgeFunctionResult> {
  return callEdgeFunction("stop-bot", "POST");
}

// ── Obtener estado completo ──
export interface StatusResult extends EdgeFunctionResult {
  botState?: {
    isRunning: boolean;
    analyzing: boolean;
    cycleCount: number;
    dynamicInterval: number;
    startTime: string | null;
    lastError: string | null;
    lastCycleAt: string | null;
  };
  portfolio?: {
    balance: number;
    initialBalance: number;
    pnl: number;
    pnlPercent: number;
  };
  stats?: {
    totalOrders: number;
    won: number;
    lost: number;
    pending: number;
    openOrders: number;
    totalProfit: number;
    winRate: number;
  };
  lastCycle?: {
    timestamp: string;
    summary: string;
    model: string;
    recommendations: number;
    betsPlaced: number;
    error: string | null;
  } | null;
  aiCost?: {
    totalCost: number;
    totalTokens: number;
    totalCalls: number;
  };
  activities?: Array<{
    timestamp: string;
    message: string;
    entry_type: string;
  }>;
}

export async function callGetStatus(): Promise<StatusResult> {
  return callEdgeFunction("get-status", "GET") as Promise<StatusResult>;
}

// ── Cancelar orden ──
export interface CancelOrderResult extends EdgeFunctionResult {
  refunded?: number;
}

export async function callCancelOrder(orderId: string): Promise<CancelOrderResult> {
  return callEdgeFunction("cancel-order", "POST", { orderId }) as Promise<CancelOrderResult>;
}

// ── Resetear bot completamente ──
export interface ResetBotResult extends EdgeFunctionResult {
  initialBalance?: number;
}

export async function callResetBot(initialBalance?: number): Promise<ResetBotResult> {
  return callEdgeFunction("reset-bot", "POST", initialBalance ? { initialBalance } : {}) as Promise<ResetBotResult>;
}
