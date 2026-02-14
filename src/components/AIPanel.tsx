/**
 * AIPanel — Visual Dashboard for Kelly Criterion + Claude AI Trading System
 * 
 * Shows: AI cost tracking, Kelly bet results, bankroll safety status,
 * market analysis stats, and the next scan countdown.
 */

import { useState, useCallback } from "react";
import { AICostTracker, KellyResult, Portfolio } from "../types";
import { formatCost } from "../services/claudeAI";

/** Tiny copy-to-clipboard helper with visual feedback */
function CopyBtn({ text }: { text: string | null | undefined }) {
  const [copied, setCopied] = useState(false);
  if (!text) return null;
  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  };
  return (
    <button
      onClick={handleCopy}
      title="Copiar al portapapeles"
      className={`ml-2 px-1.5 py-0.5 rounded text-[10px] transition-colors ${
        copied
          ? "bg-green-600/30 text-green-400"
          : "bg-gray-700/50 text-gray-400 hover:bg-gray-600/60 hover:text-gray-200"
      }`}
    >
      {copied ? "✓ Copiado" : "📋 Copiar"}
    </button>
  );
}
import { KELLY_CONFIG } from "../services/kellyStrategy";
import { dbGetAICostDetail } from "../services/db";

interface AIPanelProps {
  aiCostTracker: AICostTracker;
  lastKellyResults: KellyResult[];
  bankrollStatus: string;
  smartMode: boolean;
  marketsEligible: number;
  marketsAnalyzed: number;
  dynamicInterval: number;
  portfolio: Portfolio;
  maxExpiryHours: number;
}

export default function AIPanel({
  aiCostTracker,
  lastKellyResults,
  bankrollStatus,
  smartMode,
  marketsEligible,
  marketsAnalyzed,
  dynamicInterval,
  portfolio,
  maxExpiryHours,
}: AIPanelProps) {
  const [expandedHistoryIdx, setExpandedHistoryIdx] = useState<number | null>(null);
  const [detailCache, setDetailCache] = useState<Record<number, { prompt: string | null; rawResponse: string | null }>>({}); 
  const [loadingDetail, setLoadingDetail] = useState<number | null>(null);

  /** Click on history row: toggle expand + fetch detail from DB on demand */
  const handleHistoryClick = useCallback(async (idx: number, dbId?: number) => {
    if (expandedHistoryIdx === idx) {
      setExpandedHistoryIdx(null);
      return;
    }
    setExpandedHistoryIdx(idx);
    // Fetch detail from DB if we don't have it cached and have a DB id
    if (dbId && !detailCache[dbId]) {
      setLoadingDetail(dbId);
      try {
        const detail = await dbGetAICostDetail(dbId);
        setDetailCache(prev => ({ ...prev, [dbId]: detail }));
      } catch (e) {
        console.error("[AIPanel] Failed to fetch AI cost detail:", e);
        setDetailCache(prev => ({ ...prev, [dbId]: { prompt: null, rawResponse: null } }));
      } finally {
        setLoadingDetail(null);
      }
    }
  }, [expandedHistoryIdx, detailCache]);

  /** Display timestamp — normalize all formats to UTC-5 */
  const fmtLocal = (ts: string) => {
    const pad = (n: number) => String(n).padStart(2, "0");
    const toUTC5 = (d: Date) => {
      // Convert any Date to UTC-5 regardless of system timezone
      const utcMs = d.getTime() + d.getTimezoneOffset() * 60_000;
      const utc5 = new Date(utcMs - 5 * 3600_000);
      return `${utc5.getFullYear()}-${pad(utc5.getMonth() + 1)}-${pad(utc5.getDate())} ${pad(utc5.getHours())}:${pad(utc5.getMinutes())}:${pad(utc5.getSeconds())}`;
    };
    // ISO entries with T/Z → parse as UTC then shift to UTC-5
    if (ts.includes("T") || ts.includes("Z")) {
      const d = new Date(ts);
      if (isNaN(d.getTime())) return ts;
      return toUTC5(d);
    }
    // YYYY-MM-DD HH:MM:SS from DB (SQLite UTC) → treat as UTC, shift to UTC-5
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(ts)) {
      const d = new Date(ts.replace(" ", "T") + "Z");
      if (isNaN(d.getTime())) return ts;
      return toUTC5(d);
    }
    return ts;
  };

  const avgCostPerCall = aiCostTracker.totalCalls > 0
    ? aiCostTracker.totalCostUsd / aiCostTracker.totalCalls
    : 0;
  
  const totalBetsPlaced = lastKellyResults.filter(k => k.betAmount > 0).length;
  const totalSkipped = lastKellyResults.filter(k => k.betAmount === 0).length;

  return (
    <div className="space-y-4 p-2">
      {/* Header Hero */}
      <div className="bg-gradient-to-r from-purple-900/30 via-bot-card to-indigo-900/30 rounded-xl border border-purple-500/30 p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-xl font-bold text-white flex items-center gap-2">
              🧠 Kelly Criterion + Claude AI
            </h2>
            <p className="text-sm text-gray-400 mt-1">
              Sistema inteligente de apuestas con análisis probabilístico
            </p>
          </div>
          <div className={`px-4 py-2 rounded-lg text-sm font-bold ${
            smartMode 
              ? "bg-purple-500/20 text-purple-300 border border-purple-500/50" 
              : "bg-gray-700/50 text-gray-500 border border-gray-600/50"
          }`}>
            {smartMode ? "⚡ ACTIVO" : "💤 INACTIVO"}
          </div>
        </div>
        
        {/* Bankroll Status Bar */}
        {bankrollStatus && (
          <div className="bg-black/30 rounded-lg px-4 py-2 text-sm font-mono">
            {bankrollStatus}
          </div>
        )}
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-4 gap-3">
        {/* AI Costs Card */}
        <div className="bg-bot-card rounded-xl border border-bot-border p-4">
          <div className="text-xs text-gray-500 mb-1">💸 Costo IA Total</div>
          <div className="text-2xl font-bold text-yellow-400">
            {formatCost(aiCostTracker.totalCostUsd)}
          </div>
          <div className="text-xs text-gray-500 mt-1">
            {aiCostTracker.totalCalls} llamadas | avg {formatCost(avgCostPerCall)}/call
          </div>
        </div>

        {/* Markets Analyzed */}
        <div className="bg-bot-card rounded-xl border border-bot-border p-4">
          <div className="text-xs text-gray-500 mb-1">🔍 Mercados</div>
          <div className="text-2xl font-bold text-blue-400">{marketsAnalyzed}</div>
          <div className="text-xs text-gray-500 mt-1">
            de {marketsEligible} elegibles (≤{maxExpiryHours}h)
          </div>
        </div>

        {/* Bets This Cycle */}
        <div className="bg-bot-card rounded-xl border border-bot-border p-4">
          <div className="text-xs text-gray-500 mb-1">🎯 Último Ciclo</div>
          <div className="text-2xl font-bold text-green-400">{totalBetsPlaced}</div>
          <div className="text-xs text-gray-500 mt-1">
            apuestas | {totalSkipped} saltadas
          </div>
        </div>

        {/* Next Scan */}
        <div className="bg-bot-card rounded-xl border border-bot-border p-4">
          <div className="text-xs text-gray-500 mb-1">⏱️ Próximo Escaneo</div>
          <div className="text-2xl font-bold text-purple-400">
            {Math.floor(dynamicInterval / 60)}:{String(dynamicInterval % 60).padStart(2, "0")}
          </div>
          <div className="text-xs text-gray-500 mt-1">
            intervalo dinámico
          </div>
        </div>
      </div>

      {/* Two-Column Layout */}
      <div className="grid grid-cols-2 gap-3">
        {/* Kelly Configuration */}
        <div className="bg-bot-card rounded-xl border border-bot-border p-4">
          <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2">
            ⚙️ Configuración Kelly
          </h3>
          <div className="space-y-2 text-sm">
            {[
              { label: "Kelly Fraction", value: `${KELLY_CONFIG.KELLY_FRACTION * 100}% (Quarter)`, color: "text-purple-400" },
              { label: "Máx por apuesta", value: `${KELLY_CONFIG.MAX_BET_FRACTION * 100}% bankroll`, color: "text-yellow-400" },
              { label: "Apuesta mínima", value: `$${Number(KELLY_CONFIG.MIN_BET_USD).toFixed(2)} (mín Polymarket)`, color: "text-blue-400" },
              { label: "Edge mínimo", value: `${(KELLY_CONFIG.MIN_EDGE_AFTER_COSTS * 100).toFixed(0)}% post-costos`, color: "text-green-400" },
              { label: "Confianza mín", value: `${KELLY_CONFIG.MIN_CONFIDENCE}/100`, color: "text-orange-400" },
              { label: "Precio mín", value: `${(KELLY_CONFIG.MIN_MARKET_PRICE * 100).toFixed(0)}¢`, color: "text-cyan-400" },
              { label: "Precio máx", value: `${(KELLY_CONFIG.MAX_MARKET_PRICE * 100).toFixed(0)}¢`, color: "text-pink-400" },
            ].map(({ label, value, color }) => (
              <div key={label} className="flex justify-between items-center">
                <span className="text-gray-500 text-xs">{label}</span>
                <span className={`font-mono text-xs font-bold ${color}`}>{value}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Token Usage */}
        <div className="bg-bot-card rounded-xl border border-bot-border p-4">
          <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2">
            🪙 Uso de Tokens
          </h3>
          <div className="space-y-3">
            {/* Token Bar */}
            <div>
              <div className="flex justify-between text-xs text-gray-500 mb-1">
                <span>Input tokens</span>
                <span className="text-cyan-400 font-mono">{aiCostTracker.totalInputTokens.toLocaleString()}</span>
              </div>
              <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
                <div 
                  className="h-full bg-gradient-to-r from-cyan-500 to-cyan-400 rounded-full transition-all"
                  style={{ width: `${Math.min(100, (aiCostTracker.totalInputTokens / 100000) * 100)}%` }}
                />
              </div>
            </div>
            <div>
              <div className="flex justify-between text-xs text-gray-500 mb-1">
                <span>Output tokens</span>
                <span className="text-pink-400 font-mono">{aiCostTracker.totalOutputTokens.toLocaleString()}</span>
              </div>
              <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
                <div 
                  className="h-full bg-gradient-to-r from-pink-500 to-pink-400 rounded-full transition-all"
                  style={{ width: `${Math.min(100, (aiCostTracker.totalOutputTokens / 100000) * 100)}%` }}
                />
              </div>
            </div>

            {/* Cost Efficiency */}
            <div className="bg-black/30 rounded-lg p-3 mt-2">
              <div className="text-xs text-gray-500 mb-1">Costo IA vs Bankroll</div>
              <div className="flex items-center gap-2">
                <div className="flex-1 h-3 bg-gray-800 rounded-full overflow-hidden">
                  <div 
                    className="h-full bg-gradient-to-r from-yellow-500 to-orange-500 rounded-full"
                    style={{ width: `${Math.min(100, (aiCostTracker.totalCostUsd / portfolio.balance) * 100)}%` }}
                  />
                </div>
                <span className="text-xs text-yellow-400 font-mono w-16 text-right">
                  {portfolio.balance > 0 
                    ? `${((aiCostTracker.totalCostUsd / portfolio.balance) * 100).toFixed(2)}%`
                    : "N/A"}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Last Kelly Results */}
      {lastKellyResults.length > 0 && (
        <div className="bg-bot-card rounded-xl border border-bot-border p-4">
          <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2">
            📊 Resultados Kelly — Último Ciclo
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-500 text-xs border-b border-bot-border">
                  <th className="text-left py-2 px-2">Outcome</th>
                  <th className="text-right py-2 px-2">Precio</th>
                  <th className="text-right py-2 px-2">Edge</th>
                  <th className="text-right py-2 px-2">Kelly%</th>
                  <th className="text-right py-2 px-2">Apuesta</th>
                  <th className="text-right py-2 px-2">EV</th>
                  <th className="text-right py-2 px-2">Confianza</th>
                  <th className="text-left py-2 px-2">Razonamiento</th>
                </tr>
              </thead>
              <tbody>
                {lastKellyResults.map((k, i) => {
                  const isBet = k.betAmount > 0;
                  return (
                    <tr key={i} className={`border-b border-bot-border/50 ${isBet ? "bg-green-500/5" : ""}`}>
                      <td className="py-2 px-2 font-mono">
                        <span className={isBet ? "text-green-400" : "text-gray-600"}>
                          {k.outcomeName}
                        </span>
                      </td>
                      <td className="py-2 px-2 text-right font-mono text-gray-400">
                        {(k.price * 100).toFixed(0)}¢
                      </td>
                      <td className={`py-2 px-2 text-right font-mono ${k.edge > 0.05 ? "text-green-400" : k.edge > 0 ? "text-yellow-400" : "text-gray-600"}`}>
                        {(k.edge * 100).toFixed(1)}%
                      </td>
                      <td className="py-2 px-2 text-right font-mono text-purple-400">
                        {(k.fractionalKelly * 100).toFixed(1)}%
                      </td>
                      <td className={`py-2 px-2 text-right font-mono font-bold ${isBet ? "text-green-400" : "text-gray-600"}`}>
                        {isBet ? `$${k.betAmount.toFixed(2)}` : "—"}
                      </td>
                      <td className={`py-2 px-2 text-right font-mono ${k.expectedValue > 0 ? "text-green-400" : "text-red-400"}`}>
                        {k.expectedValue !== 0 ? `$${k.expectedValue.toFixed(3)}` : "—"}
                      </td>
                      <td className="py-2 px-2 text-right">
                        <span className={`inline-block px-2 py-0.5 rounded text-xs font-bold ${
                          k.confidence >= 70 ? "bg-green-500/20 text-green-400" :
                          k.confidence >= 50 ? "bg-yellow-500/20 text-yellow-400" :
                          "bg-red-500/20 text-red-400"
                        }`}>
                          {k.confidence}
                        </span>
                      </td>
                      <td className="py-2 px-2 text-xs text-gray-500 max-w-[200px] truncate">
                        {k.reasoning}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Recent AI Calls History */}
      {aiCostTracker.history.length > 0 && (
        <div className="bg-bot-card rounded-xl border border-bot-border p-4">
          <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2">
            📜 Historial de Llamadas AI
            <span className="text-xs text-gray-500 font-normal">
              (últimas {Math.min(10, aiCostTracker.history.length)})
            </span>
          </h3>
          <div className="space-y-2">
            {aiCostTracker.history.slice(-10).reverse().map((h, i) => {
              const isExpanded = expandedHistoryIdx === i;
              const detail = h.id ? detailCache[h.id] : undefined;
              const isLoading = h.id === loadingDetail;
              return (
                <div key={h.id || i} className="rounded-lg border border-bot-border overflow-hidden">
                  {/* Row header — clickable */}
                  <button
                    onClick={() => handleHistoryClick(i, h.id)}
                    className="w-full flex items-center gap-3 text-xs py-2 px-3 hover:bg-white/5 transition-colors cursor-pointer"
                  >
                    <span className={`transition-transform ${isExpanded ? "rotate-90" : ""}`}>▶</span>
                    <span className="text-gray-500 font-mono w-36 text-left">
                      {fmtLocal(h.timestamp)}
                    </span>
                    <span className="text-cyan-400 font-mono w-20">{h.inputTokens}↓</span>
                    <span className="text-pink-400 font-mono w-20">{h.outputTokens}↑</span>
                    <span className="text-yellow-400 font-mono w-24">{formatCost(h.costUsd)}</span>
                    <span className="text-gray-600">{h.model.split("-").slice(-1)[0]}</span>
                    {h.responseTimeMs && <span className="text-gray-600 ml-auto">{(h.responseTimeMs / 1000).toFixed(1)}s</span>}
                  </button>

                  {/* Expanded detail — fetched on demand from DB */}
                  {isExpanded && (
                    <div className="border-t border-bot-border bg-black/20 p-3 space-y-3 max-h-[70vh] overflow-y-auto">
                      {/* Summary line */}
                      {(h.summary || h.recommendations !== undefined) && (
                        <div className="text-xs text-gray-400 flex gap-4">
                          {h.recommendations !== undefined && <span>📊 {h.recommendations} recomendaciones</span>}
                          {h.summary && <span className="truncate">💡 {h.summary}</span>}
                        </div>
                      )}

                      {isLoading ? (
                        <div className="text-xs text-yellow-400 animate-pulse">⏳ Cargando prompt y respuesta desde la base de datos...</div>
                      ) : (
                        <>
                          {/* Prompt sent */}
                          <div>
                            <div className="text-xs font-semibold text-cyan-400 mb-1 flex items-center">📤 Prompt enviado<CopyBtn text={detail?.prompt} /></div>
                            {detail?.prompt ? (
                              <pre className="text-[10px] leading-relaxed text-gray-400 bg-black/40 rounded p-2 max-h-60 overflow-y-auto whitespace-pre-wrap break-words font-mono">
                                {detail.prompt}
                              </pre>
                            ) : (
                              <span className="text-xs text-gray-600 italic">
                                {detail === undefined ? "Haz click para cargar..." : "No disponible (llamada anterior a la migración)"}
                              </span>
                            )}
                          </div>

                          {/* Response received */}
                          <div>
                            <div className="text-xs font-semibold text-pink-400 mb-1 flex items-center">📥 Respuesta recibida<CopyBtn text={detail?.rawResponse} /></div>
                            {detail?.rawResponse ? (
                              <pre className="text-[10px] leading-relaxed text-gray-400 bg-black/40 rounded p-2 max-h-60 overflow-y-auto whitespace-pre-wrap break-words font-mono">
                                {detail.rawResponse}
                              </pre>
                            ) : (
                              <span className="text-xs text-gray-600 italic">
                                {detail === undefined ? "Haz click para cargar..." : "No disponible (llamada anterior a la migración)"}
                              </span>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Empty State */}
      {!smartMode && (
        <div className="bg-bot-card rounded-xl border border-bot-border p-8 text-center">
          <div className="text-4xl mb-3">💤</div>
          <h3 className="text-lg font-semibold text-gray-400">Modo Inteligente Desactivado</h3>
          <p className="text-sm text-gray-600 mt-2">
            Activa el modo "🧠 Smart ON" para usar Kelly Criterion + Claude AI
          </p>
        </div>
      )}

      {smartMode && lastKellyResults.length === 0 && aiCostTracker.totalCalls === 0 && (
        <div className="bg-bot-card rounded-xl border border-purple-500/20 p-8 text-center">
          <div className="text-4xl mb-3">🧠</div>
          <h3 className="text-lg font-semibold text-purple-300">Esperando primer ciclo...</h3>
          <p className="text-sm text-gray-500 mt-2">
            Inicia el bot para que Claude analice mercados y Kelly calcule apuestas óptimas.
          </p>
        </div>
      )}
    </div>
  );
}
