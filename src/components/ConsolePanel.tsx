/**
 * ConsolePanel — Full debug view of the AI cycle
 * Shows: prompt sent, raw response, match results, Kelly calcs, short-term pool, costs
 */

import { useState, useEffect } from "react";
import { getCycleLogs, hydrateCycleLogs, CycleDebugLog, RecommendationResult } from "../services/smartTrader";
import type { AICostTracker } from "../types";
import { useTranslation } from "../i18n";

interface ConsolePanelProps {
  isAnalyzing: boolean;
  countdown: number;
  lastCycleCost: number;
  aiCostTracker: AICostTracker;
}

export default function ConsolePanel({ isAnalyzing, countdown, lastCycleCost, aiCostTracker }: ConsolePanelProps) {
  const [logs, setLogs] = useState<CycleDebugLog[]>([]);
  const [selectedLog, setSelectedLog] = useState<number>(0);
  const [activeSection, setActiveSection] = useState<string>("overview");
  const tracker = aiCostTracker;
  const { t } = useTranslation();

  useEffect(() => {
    const refresh = () => setLogs([...getCycleLogs()]);
    // Hydrate from Supabase on first mount, then poll in-memory
    hydrateCycleLogs().then(refresh).catch(() => {});
    refresh();
    const interval = setInterval(refresh, 2000);
    return () => clearInterval(interval);
  }, []);

  const currentLog = logs[selectedLog] || null;

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  };

  const formatMs = (ms: number) => {
    if (ms < 0) return "—";
    if (ms < 60000) return `${Math.round(ms / 1000)}s`;
    if (ms < 3600000) return `${Math.round(ms / 60000)}min`;
    const h = ms / 3600000;
    return h >= 24 ? `${(h / 24).toFixed(0)}d` : `${h.toFixed(1)}h`;
  };

  return (
    <div className="h-full flex flex-col gap-3">
      {/* Status Bar */}
      <div className="bg-bot-card border border-bot-border rounded-xl p-4">
        <div className="flex items-center gap-6 flex-wrap">
          {/* AI Status */}
          <div className="flex items-center gap-3">
            {isAnalyzing ? (
              <>
                <div className="relative flex items-center justify-center w-8 h-8">
                  <div className="absolute inset-0 rounded-full border-2 border-purple-500/30 border-t-purple-400 animate-spin" />
                  <span className="text-sm">🔬</span>
                </div>
                <div>
                  <div className="text-sm font-bold text-purple-400 animate-pulse">{t("console.analyzing")}</div>
                  <div className="text-[10px] text-gray-500">{t("console.claudeOSINT")}</div>
                </div>
              </>
            ) : (
              <>
                <div className="w-8 h-8 rounded-full bg-green-500/10 border border-green-500/30 flex items-center justify-center">
                  <span className="text-sm">✅</span>
                </div>
                <div>
                  <div className="text-sm font-bold text-green-400">{t("console.ready")}</div>
                  <div className="text-[10px] text-gray-500">{t("console.waitingNext")}</div>
                </div>
              </>
            )}
          </div>

          {/* Countdown */}
          <div className="bg-black/30 rounded-lg px-4 py-2 border border-gray-700/50">
            <div className="text-[9px] text-gray-500 uppercase font-bold">{t("console.nextAnalysis")}</div>
            <div className={`text-xl font-mono font-black ${countdown < 60 ? "text-yellow-400" : "text-cyan-400"}`}>
              {formatTime(countdown)}
            </div>
          </div>

          {/* Last Cost */}
          <div className="bg-black/30 rounded-lg px-4 py-2 border border-gray-700/50">
            <div className="text-[9px] text-gray-500 uppercase font-bold">{t("console.lastCycleCost")}</div>
            <div className="text-xl font-mono font-black text-yellow-400">
              ${lastCycleCost.toFixed(4)}
            </div>
          </div>

          {/* Total Cost */}
          <div className="bg-black/30 rounded-lg px-4 py-2 border border-gray-700/50">
            <div className="text-[9px] text-gray-500 uppercase font-bold">{t("console.totalAICost")}</div>
            <div className="text-xl font-mono font-black text-red-400">
              ${tracker.totalCostUsd.toFixed(4)}
            </div>
          </div>

          {/* Total Calls */}
          <div className="bg-black/30 rounded-lg px-4 py-2 border border-gray-700/50">
            <div className="text-[9px] text-gray-500 uppercase font-bold">{t("console.aiCalls")}</div>
            <div className="text-xl font-mono font-black text-white">
              {tracker.totalCalls}
            </div>
          </div>

          {/* Cycle Selector */}
          <div className="ml-auto flex items-center gap-1">
            <span className="text-[10px] text-gray-500">{t("console.cycleLabel")}</span>
            <button
              onClick={() => setSelectedLog(Math.min(selectedLog + 1, logs.length - 1))}
              disabled={selectedLog >= logs.length - 1}
              className="bg-black/50 border border-gray-700 rounded px-1.5 py-0.5 text-xs text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
              title={t("console.prevCycle")}
            >◀</button>
            <span className="bg-black/50 border border-gray-700 rounded px-2 py-0.5 text-xs text-white font-mono min-w-[60px] text-center">
              #{logs.length - selectedLog}/{logs.length}
            </span>
            <button
              onClick={() => setSelectedLog(Math.max(selectedLog - 1, 0))}
              disabled={selectedLog <= 0}
              className="bg-black/50 border border-gray-700 rounded px-1.5 py-0.5 text-xs text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
              title={t("console.nextCycle")}
            >▶</button>
            <button
              onClick={() => setSelectedLog(0)}
              disabled={selectedLog === 0}
              className="bg-black/50 border border-gray-700 rounded px-1.5 py-0.5 text-[9px] text-gray-400 hover:text-bot-green disabled:opacity-30 disabled:cursor-not-allowed"
              title={t("console.lastCycle")}
            >⟫</button>
          </div>
        </div>
      </div>

      {/* Section Tabs */}
      {currentLog && (
        <div className="flex gap-1 bg-bot-card border border-bot-border rounded-lg p-1 w-fit">
          {[
            { id: "overview", label: t("console.tabSummary") },
            { id: "matching", label: t("console.tabMatching") },
            { id: "pool", label: `${t("console.tabPool")} (${currentLog.poolBreakdown.passed})` },
            { id: "prompt", label: t("console.tabPrompt") },
            { id: "response", label: t("console.tabResponse") },
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveSection(tab.id)}
              className={`px-3 py-1.5 rounded text-xs font-medium transition-all ${
                activeSection === tab.id ? "bg-bot-green text-black" : "text-gray-400 hover:text-white hover:bg-white/5"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {!currentLog ? (
          <div className="h-full flex items-center justify-center">
            <div className="text-center">
              <div className="text-4xl mb-3">🔬</div>
              <div className="text-lg font-bold text-gray-400">{t("console.noCycles")}</div>
              <div className="text-sm text-gray-600 mt-1">{t("console.startBotToSee")}</div>
            </div>
          </div>
        ) : (
          <>
            {/* ─── Overview ─── */}
            {activeSection === "overview" && (
              <div className="space-y-3">
                {/* Summary */}
                <div className="bg-bot-card border border-bot-border rounded-xl p-4">
                  <div className="text-[10px] text-purple-400/70 uppercase font-bold mb-2">{t("console.aiSummary")}</div>
                  <div className="text-sm text-gray-300 leading-relaxed">{currentLog.summary || t("console.noSummary")}</div>
                </div>

                {/* Stats Grid — Pipeline */}
                <div className="grid grid-cols-8 gap-2">
                  <StatBox label={t("console.marketsDB")} value={currentLog.totalMarkets.toLocaleString()} color="white" />
                  <StatBox label={t("console.finalPool")} value={String(currentLog.poolBreakdown.passed)} color="cyan" />
                  <StatBox label={t("console.aiRecommended")} value={String(currentLog.recommendations)} color="purple" />
                  <StatBox label={t("console.betsPlaced")} value={String(currentLog.betsPlaced)} color="green" />
                  <StatBox label={t("console.filterLevel")} value={currentLog.poolBreakdown.filterLabel || "—"} color="blue" />
                  <StatBox label={t("console.sportsExcl")} value={String(currentLog.poolBreakdown.sports || 0)} color="red" />
                  <StatBox label={t("console.lowLiqExcl")} value={String(currentLog.poolBreakdown.lowLiquidity || 0)} color="orange" />
                  <StatBox label={t("console.outsideWindow")} value={String(currentLog.poolBreakdown.tooFarOut)} color="yellow" />
                </div>

                {/* Match Results Cards */}
                {currentLog.results.length > 0 && (
                  <div className="bg-bot-card border border-bot-border rounded-xl p-4">
                    <div className="text-[10px] text-green-400/70 uppercase font-bold mb-3">{t("console.recommendationsToKelly")}</div>
                    <div className="space-y-3">
                      {currentLog.results.map((rr, i) => (
                        <RecommendationCard key={i} rr={rr} />
                      ))}
                    </div>
                  </div>
                )}

                {currentLog.error && (
                  <div className="bg-red-900/20 border border-red-500/30 rounded-xl p-4">
                    <div className="text-[10px] text-red-400 uppercase font-bold mb-1">{t("console.error")}</div>
                    <div className="text-sm text-red-300">{currentLog.error}</div>
                  </div>
                )}
              </div>
            )}

            {/* ─── Matching Details ─── */}
            {activeSection === "matching" && (
              <div className="space-y-3">
                {currentLog.results.length === 0 ? (
                  <div className="bg-bot-card border border-bot-border rounded-xl p-8 text-center">
                    <div className="text-2xl mb-2">🔗</div>
                    <div className="text-gray-400">{t("console.noRecommendations")}</div>
                  </div>
                ) : (
                  currentLog.results.map((rr, i) => (
                    <div key={i} className="bg-bot-card border border-bot-border rounded-xl p-4">
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex-1">
                          <div className="text-[13px] font-bold text-white">{rr.question}</div>
                          <div className="text-[10px] text-gray-500 mt-0.5">
                            {t("console.claudeRecommends")} <span className={rr.recommendedSide === "YES" ? "text-green-400" : "text-red-400"}>{rr.recommendedSide}</span>
                            {" | "}P(real)={((rr.pReal) * 100).toFixed(1)}% | Conf={rr.confidence}
                          </div>
                        </div>
                        <span className={`text-[10px] font-bold px-2 py-1 rounded ${
                          rr.decision.startsWith("BET") ? "bg-green-500/20 text-green-400 border border-green-500/30" :
                          "bg-red-500/10 text-gray-400 border border-gray-700/30"
                        }`}>{rr.decision}</span>
                      </div>

                      {/* Market info */}
                      <div className="bg-black/20 rounded-lg p-3 mb-3">
                        <div className="text-[9px] text-cyan-400/60 uppercase font-bold mb-2">{t("console.marketLabel")}</div>
                        <div className="text-[11px] text-gray-300">
                          ID: <span className="text-gray-400">{rr.marketId.slice(0, 20)}...</span>
                        </div>
                      </div>

                      {/* Prices + Edge */}
                      {rr.pMarket > 0 && (
                        <div className="bg-purple-900/15 border border-purple-500/15 rounded-lg p-3 mb-3">
                          <div className="text-[9px] text-purple-400/60 uppercase font-bold mb-2">{t("console.realPricesEdge")}</div>
                          <div className="grid grid-cols-5 gap-2">
                            <MiniStat label={t("console.pMarketLabel")} value={`${(rr.pMarket * 100).toFixed(1)}%`} />
                            <MiniStat label={t("console.pRealLabel")} value={`${(rr.pReal * 100).toFixed(1)}%`} />
                            <MiniStat label={t("console.edgeCol")} value={`${(rr.edge * 100).toFixed(1)}%`} color={rr.edge > 0 ? "text-green-400" : "text-red-400"} />
                            <MiniStat label={t("console.confidenceCol")} value={`${rr.confidence}`} />
                            <MiniStat label={t("console.sideCol")} value={rr.recommendedSide} color={rr.recommendedSide === "YES" ? "text-green-400" : "text-red-400"} />
                          </div>
                        </div>
                      )}

                      {/* Kelly (only if calculated) */}
                      {rr.kellyResult && (
                        <div className="bg-blue-900/15 border border-blue-500/15 rounded-lg p-3 mb-3">
                          <div className="text-[9px] text-blue-400/60 uppercase font-bold mb-2">{t("console.kellySection")}</div>
                          <div className="grid grid-cols-5 gap-2">
                            <div className="text-center bg-black/20 rounded p-2">
                              <div className="text-[9px] text-gray-500">{t("console.rawKellyCol")}</div>
                              <div className="text-sm font-bold text-blue-400">{(rr.kellyResult.rawKelly * 100).toFixed(2)}%</div>
                            </div>
                            <div className="text-center bg-black/20 rounded p-2">
                              <div className="text-[9px] text-gray-500">{t("console.quarterKellyCol")}</div>
                              <div className="text-sm font-bold text-purple-400">{(rr.kellyResult.fractionalKelly * 100).toFixed(2)}%</div>
                            </div>
                            <div className="text-center bg-black/20 rounded p-2">
                              <div className="text-[9px] text-gray-500">{t("console.betCol")}</div>
                              <div className="text-sm font-bold text-green-400">${rr.kellyResult.betAmount.toFixed(2)}</div>
                            </div>
                            <div className="text-center bg-black/20 rounded p-2">
                              <div className="text-[9px] text-gray-500">{t("console.evCol")}</div>
                              <div className={`text-sm font-bold ${rr.kellyResult.expectedValue >= 0 ? "text-green-400" : "text-red-400"}`}>
                                ${rr.kellyResult.expectedValue.toFixed(4)}
                              </div>
                            </div>
                            <div className="text-center bg-black/20 rounded p-2">
                              <div className="text-[9px] text-gray-500">{t("console.aiCostCol")}</div>
                              <div className="text-sm font-bold text-yellow-400">${rr.kellyResult.aiCostPerBet.toFixed(4)}</div>
                            </div>
                          </div>
                          <div className="text-[10px] text-gray-500 mt-2">{rr.kellyResult.reasoning}</div>
                        </div>
                      )}

                      {/* Sources */}
                      {rr.sources.length > 0 && (
                        <div className="bg-black/20 rounded-lg p-2 mb-2">
                          <div className="text-[9px] text-yellow-400/60 uppercase font-bold mb-1">{t("console.sources")}</div>
                          <div className="text-[10px] text-gray-400">{rr.sources.join(", ")}</div>
                        </div>
                      )}

                      {/* Reasoning */}
                      <div className="text-[11px] text-gray-400 leading-relaxed">{rr.reasoning}</div>
                    </div>
                  ))
                )}
              </div>
            )}

            {/* ─── Short-Term Pool ─── */}
            {activeSection === "pool" && (
              <div className="space-y-3">
                <div className="bg-bot-card border border-bot-border rounded-xl p-4">
                  <div className="text-[10px] text-cyan-400/70 uppercase font-bold mb-3">
                    {t("console.poolTitle", String(currentLog.poolBreakdown.passed), currentLog.totalMarkets.toLocaleString())}
                  </div>
                  {currentLog.shortTermList.length === 0 ? (
                    <div className="text-center py-8">
                      <div className="text-2xl mb-2">⏱️</div>
                      <div className="text-gray-400">{t("console.noMarketsExpiring")}</div>
                      <div className="text-[11px] text-gray-600 mt-1">
                        {t("console.betsOnlyShortTerm")}
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-1 max-h-[400px] overflow-y-auto">
                      {currentLog.shortTermList.map((m, i) => {
                        const timeLeft = new Date(m.endDate).getTime() - new Date(currentLog.timestamp).getTime();
                        const minLeft = Math.max(0, Math.round(timeLeft / 60000));
                        return (
                          <div key={i} className="flex items-center gap-2 py-1.5 px-2 rounded hover:bg-white/5 text-[11px]">
                            <span className="text-gray-600 w-6 text-right">{i + 1}.</span>
                            <span className="text-gray-300 flex-1 truncate">{m.question}</span>
                            <span className="text-cyan-400/70 w-16 text-right">{minLeft}min</span>
                            <span className="text-yellow-400/70 w-24 text-right">${m.volume.toLocaleString()}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ─── Prompt ─── */}
            {activeSection === "prompt" && (
              <div className="bg-bot-card border border-bot-border rounded-xl p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="text-[10px] text-yellow-400/70 uppercase font-bold">{t("console.promptTitle")}</div>
                  <div className="text-[10px] text-gray-500">
                    {t("console.promptStats", String(currentLog.prompt.length), String(Math.round(currentLog.prompt.length / 4)))}
                  </div>
                </div>
                <pre className="text-[11px] text-gray-300 leading-relaxed whitespace-pre-wrap font-mono bg-black/30 rounded-lg p-3 max-h-[600px] overflow-auto">
                  {currentLog.prompt || t("console.noPrompt")}
                </pre>
              </div>
            )}

            {/* ─── Response ─── */}
            {activeSection === "response" && (
              <div className="space-y-3">
                <div className="grid grid-cols-4 gap-2">
                  <StatBox label={t("console.tokensIn")} value={currentLog.inputTokens.toLocaleString()} color="cyan" />
                  <StatBox label={t("console.tokensOut")} value={currentLog.outputTokens.toLocaleString()} color="purple" />
                  <StatBox label={t("console.costLabel")} value={`$${currentLog.costUsd.toFixed(4)}`} color="yellow" />
                  <StatBox label={t("console.timeLabel")} value={`${(currentLog.responseTimeMs / 1000).toFixed(1)}s`} color="blue" />
                </div>
                <div className="bg-bot-card border border-bot-border rounded-xl p-4">
                  <div className="text-[10px] text-green-400/70 uppercase font-bold mb-3">{t("console.responseTitle")}</div>
                  <pre className="text-[11px] text-gray-300 leading-relaxed whitespace-pre-wrap font-mono bg-black/30 rounded-lg p-3 max-h-[600px] overflow-auto">
                    {currentLog.rawResponse || t("console.noResponse")}
                  </pre>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Helper Components ───────────────────────────────

function RecommendationCard({ rr }: { rr: RecommendationResult }) {
  const isBet = rr.decision.startsWith("BET");
  return (
    <div className={`p-3 rounded-lg border ${
      isBet ? "bg-green-900/20 border-green-500/30" :
      "bg-gray-800/50 border-gray-700/30"
    }`}>
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex-1">
          <div className="font-semibold text-[12px] text-white leading-tight">{rr.question}</div>
        </div>
        <span className={`text-[10px] font-bold px-2 py-0.5 rounded whitespace-nowrap ${
          isBet ? "bg-green-500/20 text-green-400" : "bg-gray-600/20 text-gray-400"
        }`}>{rr.decision}</span>
      </div>
      <div className="flex gap-4 text-[10px]">
        <span className={rr.recommendedSide === "YES" ? "text-green-400" : "text-red-400"}>
          {rr.recommendedSide}
        </span>
        <span className="text-gray-500">P(real)={((rr.pReal) * 100).toFixed(1)}%</span>
        <span className="text-gray-500">P(mkt)={((rr.pMarket) * 100).toFixed(1)}%</span>
        <span className={rr.edge > 0 ? "text-green-400" : "text-red-400"}>Edge={((rr.edge) * 100).toFixed(1)}%</span>
        <span className="text-gray-500">Conf={rr.confidence}</span>
        {rr.kellyResult && rr.kellyResult.betAmount > 0 && (
          <span className="text-green-400 font-bold">${rr.kellyResult.betAmount.toFixed(2)}</span>
        )}
      </div>
    </div>
  );
}

function StatBox({ label, value, color }: { label: string; value: string; color: string }) {
  const colors: Record<string, string> = {
    white: "text-white", cyan: "text-cyan-400", purple: "text-purple-400",
    green: "text-green-400", yellow: "text-yellow-400", blue: "text-blue-400",
    red: "text-red-400", gray: "text-gray-400", orange: "text-orange-400",
  };
  return (
    <div className="bg-bot-card border border-bot-border rounded-lg px-3 py-2">
      <div className="text-[9px] text-gray-500 uppercase font-bold">{label}</div>
      <div className={`text-lg font-black ${colors[color] || "text-white"}`}>{value}</div>
    </div>
  );
}

function MiniStat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="text-center">
      <div className="text-[9px] text-gray-600">{label}</div>
      <div className={`text-[11px] font-bold ${color || "text-white"}`}>{value}</div>
    </div>
  );
}
