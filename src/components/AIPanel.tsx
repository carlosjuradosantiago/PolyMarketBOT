/**
 * AIPanel — Visual Dashboard for Kelly Criterion + Claude AI Trading System
 * 
 * Shows: AI cost tracking, Kelly bet results, bankroll safety status,
 * market analysis stats, and the next scan countdown.
 */

import { useState, useCallback } from "react";
import { AICostTracker, KellyResult, Portfolio } from "../types";
import { formatCost } from "../utils/format";
import { useTranslation } from "../i18n";

/** Tiny copy-to-clipboard helper with visual feedback */
function CopyBtn({ text }: { text: string | null | undefined }) {
  const [copied, setCopied] = useState(false);
  const { t } = useTranslation();
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
      title={t("ai.copyToClipboard")}
      className={`ml-2 px-1.5 py-0.5 rounded text-[10px] transition-colors ${
        copied
          ? "bg-bot-green/20 text-bot-green"
          : "bg-bot-surface/60 text-bot-muted/50 hover:bg-bot-surface hover:text-white"
      }`}
    >
      {copied ? t("ai.copied") : t("ai.copy")}
    </button>
  );
}
// Kelly constants — valores fijos que replica el backend
const KELLY_CONFIG = {
  KELLY_FRACTION: 0.50,
  MAX_BET_FRACTION: 0.10,
  MIN_BET_USD: 1.00,
  MIN_EDGE_AFTER_COSTS: 0.06,
  MIN_CONFIDENCE: 60,
  MIN_MARKET_PRICE: 0.02,
  MAX_MARKET_PRICE: 0.98,
  DEFAULT_SCAN_SECS: 600,
  MIN_SCAN_SECS: 300,
  MAX_SCAN_SECS: 900,
};
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
  const [detailCache, setDetailCache] = useState<Record<number, { prompt: string | null; rawResponse: string | null; skipped: { marketId: string; question: string; reason: string }[] }>>({}); 
  const [loadingDetail, setLoadingDetail] = useState<number | null>(null);
  const { t } = useTranslation();

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
        setDetailCache(prev => ({ ...prev, [dbId]: { prompt: null, rawResponse: null, skipped: [] } }));
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
    <div className="space-y-3 p-2">
      {/* Header Hero */}
      <div className="glass-card glow-border-purple rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-xl font-display font-bold text-white flex items-center gap-2">
              {t("ai.heroTitle")}
            </h2>
            <p className="text-sm text-bot-muted/50 font-display mt-1">
              {t("ai.heroSubtitle")}
            </p>
          </div>
          <div className={`px-4 py-2 rounded-lg text-sm font-display font-bold ${
            smartMode 
              ? "bg-bot-purple/15 text-bot-purple border border-bot-purple/30" 
              : "bg-bot-surface/40 text-bot-muted/40 border border-bot-border/30"
          }`}>
            {smartMode ? t("ai.active") : t("ai.inactive")}
          </div>
        </div>
        
        {/* Bankroll Status Bar */}
        {bankrollStatus && (
          <div className="bg-bot-surface/50 rounded-lg px-4 py-2 text-sm font-mono text-bot-muted">
            {bankrollStatus}
          </div>
        )}
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-4 gap-2.5">
        {/* AI Costs Card */}
        <div className="glass-card rounded-xl p-4">
          <div className="text-[10px] text-bot-muted/40 font-display uppercase tracking-wider mb-1">{t("ai.totalCost")}</div>
          <div className="text-2xl font-display font-bold text-amber-400">
            {formatCost(aiCostTracker.totalCostUsd)}
          </div>
          <div className="text-[11px] text-bot-muted/40 mt-1 font-mono">
            {aiCostTracker.totalCalls} {t("ai.calls")} | {t("ai.avgPerCall")} {formatCost(avgCostPerCall)}{t("ai.perCall")}
          </div>
        </div>

        {/* Markets Analyzed */}
        <div className="glass-card rounded-xl p-4">
          <div className="text-[10px] text-bot-muted/40 font-display uppercase tracking-wider mb-1">{t("ai.marketsLabel")}</div>
          <div className="text-2xl font-display font-bold text-bot-cyan">{marketsAnalyzed}</div>
          <div className="text-[11px] text-bot-muted/40 mt-1">
            {t("ai.ofEligible", String(marketsEligible), String(maxExpiryHours))}
          </div>
        </div>

        {/* Bets This Cycle */}
        <div className="glass-card rounded-xl p-4">
          <div className="text-[10px] text-bot-muted/40 font-display uppercase tracking-wider mb-1">{t("ai.lastCycle")}</div>
          <div className="text-2xl font-display font-bold text-bot-green">{totalBetsPlaced}</div>
          <div className="text-[11px] text-bot-muted/40 mt-1">
            {t("ai.bets")} | {totalSkipped} {t("ai.skipped")}
          </div>
        </div>

        {/* Next Scan */}
        <div className="glass-card rounded-xl p-4">
          <div className="text-[10px] text-bot-muted/40 font-display uppercase tracking-wider mb-1">{t("ai.nextScan")}</div>
          <div className="text-2xl font-display font-bold text-bot-purple">
            {dynamicInterval >= 3600
              ? `${Math.floor(dynamicInterval / 3600)}h${String(Math.floor((dynamicInterval % 3600) / 60)).padStart(2, "0")}m`
              : `${Math.floor(dynamicInterval / 60)}:${String(dynamicInterval % 60).padStart(2, "0")}`
            }
          </div>
          <div className="text-[11px] text-bot-muted/40 mt-1">
            Diario 6:00 AM
          </div>
        </div>
      </div>

      {/* Two-Column Layout */}
      <div className="grid grid-cols-2 gap-2.5">
        {/* Kelly Configuration */}
        <div className="glass-card rounded-xl p-4">
          <h3 className="text-sm font-display font-semibold text-white/80 mb-3 flex items-center gap-2">
            {t("ai.kellyConfig")}
          </h3>
          <div className="space-y-2 text-sm">
            {[
              { label: t("ai.kellyFraction"), value: `${KELLY_CONFIG.KELLY_FRACTION * 100}% (${t("ai.quarter")})`  , color: "text-bot-purple" },
              { label: t("ai.maxPerBet"), value: `${KELLY_CONFIG.MAX_BET_FRACTION * 100}% ${t("ai.bankroll")}`, color: "text-amber-400" },
              { label: t("ai.minBet"), value: `$${Number(KELLY_CONFIG.MIN_BET_USD).toFixed(2)} (${t("ai.minPolymarket")})`, color: "text-bot-cyan" },
              { label: t("ai.minEdge"), value: `${(KELLY_CONFIG.MIN_EDGE_AFTER_COSTS * 100).toFixed(0)}% ${t("ai.postCosts")}`, color: "text-bot-green" },
              { label: t("ai.minConfidence"), value: `${KELLY_CONFIG.MIN_CONFIDENCE}/100`, color: "text-orange-400" },
              { label: t("ai.minPrice"), value: `${(KELLY_CONFIG.MIN_MARKET_PRICE * 100).toFixed(0)}¢`, color: "text-bot-cyan" },
              { label: t("ai.maxPrice"), value: `${(KELLY_CONFIG.MAX_MARKET_PRICE * 100).toFixed(0)}¢`, color: "text-pink-400" },
            ].map(({ label, value, color }) => (
              <div key={label} className="flex justify-between items-center">
                <span className="text-bot-muted/50 text-xs">{label}</span>
                <span className={`font-mono text-xs font-bold ${color}`}>{value}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Token Usage */}
        <div className="glass-card rounded-xl p-4">
          <h3 className="text-sm font-display font-semibold text-white/80 mb-3 flex items-center gap-2">
            {t("ai.tokenUsage")}
          </h3>
          <div className="space-y-3">
            {/* Token Bar */}
            <div>
              <div className="flex justify-between text-xs text-bot-muted/50 mb-1">
                <span>Input tokens</span>
                <span className="text-bot-cyan font-mono">{aiCostTracker.totalInputTokens.toLocaleString()}</span>
              </div>
              <div className="h-1.5 bg-bot-surface/60 rounded-full overflow-hidden">
                <div 
                  className="h-full bg-gradient-to-r from-bot-cyan/80 to-bot-cyan rounded-full transition-all"
                  style={{ width: `${Math.min(100, (aiCostTracker.totalInputTokens / 100000) * 100)}%` }}
                />
              </div>
            </div>
            <div>
              <div className="flex justify-between text-xs text-bot-muted/50 mb-1">
                <span>Output tokens</span>
                <span className="text-pink-400 font-mono">{aiCostTracker.totalOutputTokens.toLocaleString()}</span>
              </div>
              <div className="h-1.5 bg-bot-surface/60 rounded-full overflow-hidden">
                <div 
                  className="h-full bg-gradient-to-r from-pink-500/80 to-pink-400 rounded-full transition-all"
                  style={{ width: `${Math.min(100, (aiCostTracker.totalOutputTokens / 100000) * 100)}%` }}
                />
              </div>
            </div>

            {/* Cost Efficiency */}
            <div className="bg-bot-surface/40 rounded-lg p-3 mt-2">
              <div className="text-[10px] text-bot-muted/40 font-display mb-1">{t("ai.aiCostVsBankroll")}</div>
              <div className="flex items-center gap-2">
                <div className="flex-1 h-2 bg-bot-surface/60 rounded-full overflow-hidden">
                  <div 
                    className="h-full bg-gradient-to-r from-amber-500 to-orange-500 rounded-full"
                    style={{ width: `${Math.min(100, (aiCostTracker.totalCostUsd / portfolio.balance) * 100)}%` }}
                  />
                </div>
                <span className="text-xs text-amber-400 font-mono w-16 text-right">
                  {portfolio.balance > 0 
                    ? `${((aiCostTracker.totalCostUsd / portfolio.balance) * 100).toFixed(2)}%`
                    : t("ai.na")}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Last Kelly Results */}
      {lastKellyResults.length > 0 && (
        <div className="glass-card rounded-xl p-4">
          <h3 className="text-sm font-display font-semibold text-white/80 mb-3 flex items-center gap-2">
            {t("ai.kellyResults")}
          </h3>
          <div className="overflow-x-auto custom-scrollbar">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-bot-muted/40 text-xs border-b border-bot-border/30">
                  <th className="text-left py-2 px-2 font-display">{t("ai.outcome")}</th>
                  <th className="text-right py-2 px-2 font-display">{t("ai.price")}</th>
                  <th className="text-right py-2 px-2 font-display">{t("ai.edge")}</th>
                  <th className="text-right py-2 px-2 font-display">{t("ai.kellyPct")}</th>
                  <th className="text-right py-2 px-2 font-display">{t("ai.bet")}</th>
                  <th className="text-right py-2 px-2 font-display">{t("ai.ev")}</th>
                  <th className="text-right py-2 px-2 font-display">{t("ai.confidence")}</th>
                  <th className="text-left py-2 px-2 font-display">{t("ai.reasoning")}</th>
                </tr>
              </thead>
              <tbody>
                {lastKellyResults.map((k, i) => {
                  const isBet = k.betAmount > 0;
                  return (
                    <tr key={i} className={`border-b border-bot-border/20 ${isBet ? "bg-bot-green/5" : ""}`}>
                      <td className="py-2 px-2 font-mono">
                        <span className={isBet ? "text-bot-green" : "text-bot-muted/30"}>
                          {k.outcomeName}
                        </span>
                      </td>
                      <td className="py-2 px-2 text-right font-mono text-bot-muted/50">
                        {(k.price * 100).toFixed(0)}¢
                      </td>
                      <td className={`py-2 px-2 text-right font-mono ${k.edge > 0.05 ? "text-bot-green" : k.edge > 0 ? "text-amber-400" : "text-bot-muted/30"}`}>
                        {(k.edge * 100).toFixed(1)}%
                      </td>
                      <td className="py-2 px-2 text-right font-mono text-bot-purple">
                        {(k.fractionalKelly * 100).toFixed(1)}%
                      </td>
                      <td className={`py-2 px-2 text-right font-mono font-bold ${isBet ? "text-bot-green" : "text-bot-muted/30"}`}>
                        {isBet ? `$${k.betAmount.toFixed(2)}` : "—"}
                      </td>
                      <td className={`py-2 px-2 text-right font-mono ${k.expectedValue > 0 ? "text-bot-green" : "text-bot-red"}`}>
                        {k.expectedValue !== 0 ? `$${k.expectedValue.toFixed(3)}` : "—"}
                      </td>
                      <td className="py-2 px-2 text-right">
                        <span className={`inline-block px-2 py-0.5 rounded-md text-xs font-display font-bold ${
                          k.confidence >= 70 ? "bg-bot-green/10 text-bot-green border border-bot-green/20" :
                          k.confidence >= 50 ? "bg-amber-400/10 text-amber-400 border border-amber-400/20" :
                          "bg-bot-red/10 text-bot-red border border-bot-red/20"
                        }`}>
                          {k.confidence}
                        </span>
                      </td>
                      <td className="py-2 px-2 text-xs text-bot-muted/40 max-w-[200px] truncate">
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
        <div className="glass-card rounded-xl p-4">
          <h3 className="text-sm font-display font-semibold text-white/80 mb-3 flex items-center gap-2">
            {t("ai.callHistory")}
            <span className="text-[10px] text-bot-muted/40 font-normal">
              ({t("ai.lastN", String(Math.min(10, aiCostTracker.history.length)))})
            </span>
          </h3>
          <div className="space-y-2">
            {aiCostTracker.history.slice(-10).reverse().map((h, i) => {
              const isExpanded = expandedHistoryIdx === i;
              const detail = h.id ? detailCache[h.id] : undefined;
              const isLoading = h.id === loadingDetail;
              return (
                <div key={h.id || i} className="rounded-lg border border-bot-border/30 overflow-hidden">
                  {/* Row header — clickable */}
                  <button
                    onClick={() => handleHistoryClick(i, h.id)}
                    className="w-full flex items-center gap-3 text-xs py-2 px-3 hover:bg-white/5 transition-colors cursor-pointer"
                  >
                    <span className={`transition-transform text-bot-muted/40 ${isExpanded ? "rotate-90" : ""}`}>▶</span>
                    <span className="text-bot-muted/50 font-mono w-36 text-left">
                      {fmtLocal(h.timestamp)}
                    </span>
                    <span className="text-bot-cyan font-mono w-20">{h.inputTokens}↓</span>
                    <span className="text-pink-400 font-mono w-20">{h.outputTokens}↑</span>
                    <span className="text-amber-400 font-mono w-24">{formatCost(h.costUsd)}</span>
                    <span className="text-bot-muted/30">{h.model.split("-").slice(-1)[0]}</span>
                    {h.responseTimeMs && <span className="text-bot-muted/30 ml-auto">{(h.responseTimeMs / 1000).toFixed(1)}s</span>}
                  </button>

                  {/* Expanded detail — fetched on demand from DB */}
                  {isExpanded && (
                    <div className="border-t border-bot-border/20 bg-bot-surface/30 p-3 space-y-3 max-h-[70vh] overflow-y-auto custom-scrollbar">
                      {/* Summary line */}
                      {(h.summary || h.recommendations !== undefined) && (
                        <div className="text-xs text-bot-muted/50 flex gap-4">
                          {h.recommendations !== undefined && <span>{t("ai.recommendations", String(h.recommendations))}</span>}
                          {h.summary && <span className="truncate">💡 {h.summary}</span>}
                        </div>
                      )}

                      {isLoading ? (
                        <div className="text-xs text-amber-400 animate-pulse">{t("ai.loadingPrompt")}</div>
                      ) : (
                        <>
                          {/* Skipped markets (rejection reasons from Claude) */}
                          {detail?.skipped && detail.skipped.length > 0 && (
                            <div>
                              <div className="text-xs font-display font-semibold text-orange-400 mb-1">
                                ⛔ Descartados por IA ({detail.skipped.length})
                              </div>
                              <div className="bg-bot-surface/40 rounded-lg p-2 max-h-40 overflow-y-auto custom-scrollbar space-y-1">
                                {detail.skipped.map((s, si) => (
                                  <div key={si} className="text-[10px] leading-relaxed flex gap-2">
                                    <span className="text-orange-400/50 shrink-0">•</span>
                                    <span className="text-bot-muted/40 truncate max-w-[45%]" title={s.question}>{s.question}</span>
                                    <span className="text-bot-muted/20">→</span>
                                    <span className="text-orange-300/70">{s.reason}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* Prompt sent */}
                          <div>
                            <div className="text-xs font-display font-semibold text-bot-cyan mb-1 flex items-center">{t("ai.promptSent")}<CopyBtn text={detail?.prompt} /></div>
                            {detail?.prompt ? (
                              <pre className="text-[10px] leading-relaxed text-bot-muted/50 bg-bot-surface/40 rounded-lg p-2 max-h-60 overflow-y-auto custom-scrollbar whitespace-pre-wrap break-words font-mono">
                                {detail.prompt}
                              </pre>
                            ) : (
                              <span className="text-xs text-bot-muted/30 italic">
                                {detail === undefined ? t("ai.clickToLoad") : t("ai.notAvailableLegacy")}
                              </span>
                            )}
                          </div>

                          {/* Response received */}
                          <div>
                            <div className="text-xs font-display font-semibold text-pink-400 mb-1 flex items-center">{t("ai.responseReceived")}<CopyBtn text={detail?.rawResponse} /></div>
                            {detail?.rawResponse ? (
                              <pre className="text-[10px] leading-relaxed text-bot-muted/50 bg-bot-surface/40 rounded-lg p-2 max-h-60 overflow-y-auto custom-scrollbar whitespace-pre-wrap break-words font-mono">
                                {detail.rawResponse}
                              </pre>
                            ) : (
                              <span className="text-xs text-bot-muted/30 italic">
                                {detail === undefined ? t("ai.clickToLoad") : t("ai.notAvailableLegacy")}
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
        <div className="glass-card rounded-xl p-8 text-center">
          <div className="text-4xl mb-3">💤</div>
          <h3 className="text-lg font-display font-semibold text-bot-muted/60">{t("ai.smartModeOff")}</h3>
          <p className="text-sm text-bot-muted/40 mt-2">
            {t("ai.enableSmartMode")}
          </p>
        </div>
      )}

      {smartMode && lastKellyResults.length === 0 && aiCostTracker.totalCalls === 0 && (
        <div className="glass-card glow-border-purple rounded-xl p-8 text-center">
          <div className="text-4xl mb-3">🧠</div>
          <h3 className="text-lg font-display font-semibold text-bot-purple">{t("ai.waitingFirstCycle")}</h3>
          <p className="text-sm text-bot-muted/40 mt-2">
            {t("ai.startBotPrompt")}
          </p>
        </div>
      )}
    </div>
  );
}
