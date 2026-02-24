/**
 * ConsolePanel — Full debug view of the AI cycle
 * Shows: prompt sent, raw response, match results, Kelly calcs, short-term pool, costs
 */

import { useState, useEffect, useMemo } from "react";
import type { AICostTracker, CycleDebugLog, RecommendationResult } from "../types";
import { dbGetCycleLogs } from "../services/db";
import { useTranslation } from "../i18n";

type ViewMode = "all" | "day" | "month" | "year";

interface ConsolePanelProps {
  isAnalyzing: boolean;
  countdown: number;
  lastCycleCost: number;
  aiCostTracker: AICostTracker;
}

export default function ConsolePanel({ isAnalyzing, countdown, lastCycleCost, aiCostTracker }: ConsolePanelProps) {
  const [logs, setLogs] = useState<CycleDebugLog[]>([]);
  const [selectedIdx, setSelectedIdx] = useState<number>(0);  // index into filteredLogs
  const [activeSection, setActiveSection] = useState<string>("overview");
  const [viewMode, setViewMode] = useState<ViewMode>("all");
  const [viewDate, setViewDate] = useState<Date>(new Date());
  const tracker = aiCostTracker;
  const { t } = useTranslation();

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const saved = await dbGetCycleLogs(50);
        if (!cancelled) setLogs(saved);
      } catch (e) {
        console.error("[ConsolePanel] Error loading cycle logs:", e);
      }
    };
    load();
    const interval = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  // Filter logs by view mode + date
  const filteredLogs = useMemo(() => {
    if (viewMode === "all") return logs;
    return logs.filter(log => {
      const d = new Date(log.timestamp);
      if (viewMode === "day") {
        return d.getFullYear() === viewDate.getFullYear() &&
               d.getMonth() === viewDate.getMonth() &&
               d.getDate() === viewDate.getDate();
      }
      if (viewMode === "month") {
        return d.getFullYear() === viewDate.getFullYear() &&
               d.getMonth() === viewDate.getMonth();
      }
      // year
      return d.getFullYear() === viewDate.getFullYear();
    });
  }, [logs, viewMode, viewDate]);

  // Reset selection when filter changes
  useEffect(() => { setSelectedIdx(0); }, [viewMode, viewDate]);

  // Auto-follow latest cycle when at idx 0 (latest) and new cycles come in
  useEffect(() => {
    if (filteredLogs.length > 0 && selectedIdx >= filteredLogs.length) {
      setSelectedIdx(0);
    }
  }, [filteredLogs.length, selectedIdx]);

  const currentLog = filteredLogs[selectedIdx] || null;

  // Navigate viewDate
  const shiftDate = (dir: -1 | 1) => {
    setViewDate(prev => {
      const d = new Date(prev);
      if (viewMode === "day") d.setDate(d.getDate() + dir);
      else if (viewMode === "month") d.setMonth(d.getMonth() + dir);
      else if (viewMode === "year") d.setFullYear(d.getFullYear() + dir);
      return d;
    });
  };

  const formatViewDate = () => {
    const dd = String(viewDate.getDate()).padStart(2, "0");
    const mm = String(viewDate.getMonth() + 1).padStart(2, "0");
    const yyyy = viewDate.getFullYear();
    if (viewMode === "day") return `${dd}/${mm}/${yyyy}`;
    if (viewMode === "month") return `${mm}/${yyyy}`;
    return `${yyyy}`;
  };

  const handleViewMode = (mode: ViewMode) => {
    setViewMode(mode);
    // When switching to a date-filtered mode, default to current cycle's date or today
    if (mode !== "all" && currentLog) {
      setViewDate(new Date(currentLog.timestamp));
    } else {
      setViewDate(new Date());
    }
  };

  // Format cycle timestamp for display
  const formatCycleTime = (ts: string) => {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  };

  const formatCycleDate = (ts: string) => {
    const d = new Date(ts);
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    return `${dd}/${mm}`;
  };

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
    <div className="h-full flex flex-col gap-2.5">
      {/* Status Bar */}
      <div className="glass-card rounded-xl p-4">
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
                  <div className="text-sm font-display font-bold text-bot-purple animate-pulse">{t("console.analyzing")}</div>
                  <div className="text-[10px] text-bot-muted/50">{t("console.claudeOSINT")}</div>
                </div>
              </>
            ) : (
              <>
                <div className="w-8 h-8 rounded-full bg-bot-green/10 border border-bot-green/30 flex items-center justify-center">
                  <span className="text-sm">✅</span>
                </div>
                <div>
                  <div className="text-sm font-display font-bold text-bot-green">{t("console.ready")}</div>
                  <div className="text-[10px] text-bot-muted/50">{t("console.waitingNext")}</div>
                </div>
              </>
            )}
          </div>

          {/* Countdown */}
          <div className="bg-bot-surface/60 rounded-lg px-4 py-2 border border-bot-border/40">
            <div className="text-[9px] text-bot-muted/50 uppercase font-display font-bold tracking-wider">{t("console.nextAnalysis")}</div>
            <div className={`text-xl font-mono font-black ${countdown < 60 ? "text-amber-400" : "text-bot-cyan"}`}>
              {formatTime(countdown)}
            </div>
          </div>

          {/* Last Cost */}
          <div className="bg-bot-surface/60 rounded-lg px-4 py-2 border border-bot-border/40">
            <div className="text-[9px] text-bot-muted/50 uppercase font-display font-bold tracking-wider">{t("console.lastCycleCost")}</div>
            <div className="text-xl font-mono font-black text-amber-400">
              ${lastCycleCost.toFixed(4)}
            </div>
          </div>

          {/* Total Cost */}
          <div className="bg-bot-surface/60 rounded-lg px-4 py-2 border border-bot-border/40">
            <div className="text-[9px] text-bot-muted/50 uppercase font-display font-bold tracking-wider">{t("console.totalAICost")}</div>
            <div className="text-xl font-mono font-black text-bot-red">
              ${tracker.totalCostUsd.toFixed(4)}
            </div>
          </div>

          {/* Total Calls */}
          <div className="bg-bot-surface/60 rounded-lg px-4 py-2 border border-bot-border/40">
            <div className="text-[9px] text-bot-muted/50 uppercase font-display font-bold tracking-wider">{t("console.aiCalls")}</div>
            <div className="text-xl font-mono font-black text-white">
              {tracker.totalCalls}
            </div>
          </div>

          {/* Cycle Selector — Enhanced */}
          <div className="ml-auto flex flex-col items-end gap-1">
            {/* View mode buttons */}
            <div className="flex items-center gap-0.5">
              {(["all", "day", "month", "year"] as ViewMode[]).map(mode => (
                <button
                  key={mode}
                  onClick={() => handleViewMode(mode)}
                  className={`px-2 py-0.5 text-[9px] font-display font-bold uppercase rounded transition-all ${
                    viewMode === mode
                      ? "bg-bot-green text-black"
                      : "text-bot-muted/50 hover:text-white hover:bg-white/5"
                  }`}
                >
                  {t(`console.view_${mode}`)}
                </button>
              ))}
            </div>

            {/* Date navigator (only when not "all") */}
            {viewMode !== "all" && (
              <div className="flex items-center gap-1">
                <button
                  onClick={() => shiftDate(-1)}
                  className="bg-bot-surface/60 border border-bot-border/40 rounded px-1 py-0.5 text-[10px] text-bot-muted/60 hover:text-white"
                >◀</button>
                <span className="bg-bot-surface/60 border border-bot-border/40 rounded px-2 py-0.5 text-[10px] text-bot-cyan font-mono min-w-[70px] text-center">
                  {formatViewDate()}
                </span>
                <button
                  onClick={() => shiftDate(1)}
                  className="bg-bot-surface/60 border border-bot-border/40 rounded px-1 py-0.5 text-[10px] text-bot-muted/60 hover:text-white"
                >▶</button>
                <span className="text-[9px] text-bot-muted/40 ml-1">
                  ({filteredLogs.length} {t("console.cyclesInPeriod")})
                </span>
              </div>
            )}

            {/* Cycle navigator */}
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-bot-muted/50">{t("console.cycleLabel")}</span>
              <button
                onClick={() => setSelectedIdx(Math.min(selectedIdx + 1, filteredLogs.length - 1))}
                disabled={selectedIdx >= filteredLogs.length - 1}
                className="bg-bot-surface/60 border border-bot-border/40 rounded px-1.5 py-0.5 text-xs text-bot-muted/60 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
                title={t("console.prevCycle")}
              >◀</button>
              <span className="bg-bot-surface/60 border border-bot-border/40 rounded px-2 py-0.5 text-xs text-white font-mono min-w-[110px] text-center">
                #{filteredLogs.length - selectedIdx}/{filteredLogs.length}
                {currentLog && (
                  <span className="text-bot-muted/40 ml-1 text-[10px]">
                    {formatCycleDate(currentLog.timestamp)} {formatCycleTime(currentLog.timestamp)}
                  </span>
                )}
              </span>
              <button
                onClick={() => setSelectedIdx(Math.max(selectedIdx - 1, 0))}
                disabled={selectedIdx <= 0}
                className="bg-bot-surface/60 border border-bot-border/40 rounded px-1.5 py-0.5 text-xs text-bot-muted/60 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
                title={t("console.nextCycle")}
              >▶</button>
              <button
                onClick={() => setSelectedIdx(0)}
                disabled={selectedIdx === 0}
                className="bg-bot-surface/60 border border-bot-border/40 rounded px-1.5 py-0.5 text-[9px] text-bot-muted/60 hover:text-bot-green disabled:opacity-30 disabled:cursor-not-allowed"
                title={t("console.lastCycle")}
              >⟫</button>
            </div>
          </div>
        </div>
      </div>

      {/* Section Tabs */}
      {currentLog && (
        <div className="flex gap-1 bg-bot-surface/50 backdrop-blur-sm border border-bot-border/30 rounded-xl p-1 w-fit">
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
              className={`px-3 py-1.5 rounded-lg text-xs font-display font-medium transition-all ${
                activeSection === tab.id ? "bg-bot-green text-black" : "text-bot-muted/50 hover:text-white hover:bg-white/5"
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
                <div className="glass-card rounded-xl p-4">
                  <div className="text-[10px] text-bot-purple/70 uppercase font-display font-bold tracking-wider mb-2">{t("console.aiSummary")}</div>
                  <div className="text-sm text-bot-muted leading-relaxed">{currentLog.summary || t("console.noSummary")}</div>
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
                  <div className="glass-card rounded-xl p-4">
                    <div className="text-[10px] text-bot-green/70 uppercase font-display font-bold tracking-wider mb-3">{t("console.recommendationsToKelly")}</div>
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
                  <div className="glass-card rounded-xl p-8 text-center">
                    <div className="text-2xl mb-2">🔗</div>
                    <div className="text-bot-muted/60">{t("console.noRecommendations")}</div>
                  </div>
                ) : (
                  currentLog.results.map((rr, i) => (
                    <div key={i} className="glass-card rounded-xl p-4">
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex-1">
                          <div className="text-[13px] font-display font-bold text-white">{rr.question}</div>
                          <div className="text-[10px] text-bot-muted/50 mt-0.5">
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
                      <div className="bg-bot-surface/40 rounded-lg p-3 mb-3">
                        <div className="text-[9px] text-bot-cyan/60 uppercase font-display font-bold tracking-wider mb-2">{t("console.marketLabel")}</div>
                        <div className="text-[11px] text-bot-muted">
                          ID: <span className="text-bot-muted/60">{rr.marketId.slice(0, 20)}...</span>
                        </div>
                      </div>

                      {/* Prices + Edge */}
                      {rr.pMarket > 0 && (
                        <div className="bg-bot-purple/5 border border-bot-purple/15 rounded-lg p-3 mb-3">
                          <div className="text-[9px] text-bot-purple/60 uppercase font-display font-bold tracking-wider mb-2">{t("console.realPricesEdge")}</div>
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
                        <div className="bg-bot-cyan/5 border border-bot-cyan/15 rounded-lg p-3 mb-3">
                          <div className="text-[9px] text-bot-cyan/60 uppercase font-display font-bold tracking-wider mb-2">{t("console.kellySection")}</div>
                          <div className="grid grid-cols-5 gap-2">
                            <div className="text-center bg-bot-surface/40 rounded-lg p-2">
                              <div className="text-[9px] text-bot-muted/40">{t("console.rawKellyCol")}</div>
                              <div className="text-sm font-bold text-bot-cyan">{(rr.kellyResult.rawKelly * 100).toFixed(2)}%</div>
                            </div>
                            <div className="text-center bg-bot-surface/40 rounded-lg p-2">
                              <div className="text-[9px] text-bot-muted/40">{t("console.quarterKellyCol")}</div>
                              <div className="text-sm font-bold text-bot-purple">{(rr.kellyResult.fractionalKelly * 100).toFixed(2)}%</div>
                            </div>
                            <div className="text-center bg-bot-surface/40 rounded-lg p-2">
                              <div className="text-[9px] text-bot-muted/40">{t("console.betCol")}</div>
                              <div className="text-sm font-bold text-bot-green">${rr.kellyResult.betAmount.toFixed(2)}</div>
                            </div>
                            <div className="text-center bg-bot-surface/40 rounded-lg p-2">
                              <div className="text-[9px] text-bot-muted/40">{t("console.evCol")}</div>
                              <div className={`text-sm font-bold ${rr.kellyResult.expectedValue >= 0 ? "text-bot-green" : "text-bot-red"}`}>
                                ${rr.kellyResult.expectedValue.toFixed(4)}
                              </div>
                            </div>
                            <div className="text-center bg-bot-surface/40 rounded-lg p-2">
                              <div className="text-[9px] text-bot-muted/40">{t("console.aiCostCol")}</div>
                              <div className="text-sm font-bold text-amber-400">${rr.kellyResult.aiCostPerBet.toFixed(4)}</div>
                            </div>
                          </div>
                          <div className="text-[10px] text-bot-muted/40 mt-2">{rr.kellyResult.reasoning}</div>
                        </div>
                      )}

                      {/* Sources */}
                      {rr.sources.length > 0 && (
                        <div className="bg-bot-surface/40 rounded-lg p-2 mb-2">
                          <div className="text-[9px] text-amber-400/60 uppercase font-display font-bold tracking-wider mb-1">{t("console.sources")}</div>
                          <div className="text-[10px] text-bot-muted/60">{rr.sources.join(", ")}</div>
                        </div>
                      )}

                      {/* Reasoning */}
                      <div className="text-[11px] text-bot-muted/60 leading-relaxed">{rr.reasoning}</div>
                    </div>
                  ))
                )}
              </div>
            )}

            {/* ─── Short-Term Pool ─── */}
            {activeSection === "pool" && (
              <div className="space-y-3">
                <div className="glass-card rounded-xl p-4">
                  <div className="text-[10px] text-bot-cyan/70 uppercase font-display font-bold tracking-wider mb-3">
                    {t("console.poolTitle", String(currentLog.poolBreakdown.passed), currentLog.totalMarkets.toLocaleString())}
                  </div>
                  {currentLog.shortTermList.length === 0 ? (
                    <div className="text-center py-8">
                      <div className="text-2xl mb-2">⏱️</div>
                      <div className="text-bot-muted/60">{t("console.noMarketsExpiring")}</div>
                      <div className="text-[11px] text-bot-muted/40 mt-1">
                        {t("console.betsOnlyShortTerm")}
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-1 max-h-[400px] overflow-y-auto">
                      {currentLog.shortTermList.map((m, i) => {
                        const timeLeft = new Date(m.endDate).getTime() - new Date(currentLog.timestamp).getTime();
                        const minLeft = Math.max(0, Math.round(timeLeft / 60000));
                        return (
                          <div key={i} className="flex items-center gap-2 py-1.5 px-2 rounded-lg hover:bg-white/5 text-[11px] transition-colors">
                            <span className="text-bot-muted/30 w-6 text-right font-mono">{i + 1}.</span>
                            <span className="text-bot-muted flex-1 truncate">{m.question}</span>
                            <span className="text-bot-cyan/70 w-16 text-right font-mono">{minLeft}min</span>
                            <span className="text-amber-400/70 w-24 text-right font-mono">${m.volume.toLocaleString()}</span>
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
              <div className="glass-card rounded-xl p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="text-[10px] text-amber-400/70 uppercase font-display font-bold tracking-wider">{t("console.promptTitle")}</div>
                  <div className="text-[10px] text-bot-muted/40">
                    {t("console.promptStats", String(currentLog.prompt.length), String(Math.round(currentLog.prompt.length / 4)))}
                  </div>
                </div>
                <pre className="text-[11px] text-bot-muted leading-relaxed whitespace-pre-wrap font-mono bg-bot-surface/40 rounded-lg p-3 max-h-[600px] overflow-auto custom-scrollbar">
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
                <div className="glass-card rounded-xl p-4">
                  <div className="text-[10px] text-bot-green/70 uppercase font-display font-bold tracking-wider mb-3">{t("console.responseTitle")}</div>
                  <pre className="text-[11px] text-bot-muted leading-relaxed whitespace-pre-wrap font-mono bg-bot-surface/40 rounded-lg p-3 max-h-[600px] overflow-auto custom-scrollbar">
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
    <div className={`p-3 rounded-lg border transition-colors ${
      isBet ? "bg-bot-green/5 border-bot-green/20" :
      "bg-bot-surface/40 border-bot-border/30"
    }`}>
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex-1">
          <div className="font-display font-semibold text-[12px] text-white leading-tight">{rr.question}</div>
        </div>
        <span className={`text-[10px] font-display font-bold px-2 py-0.5 rounded-md whitespace-nowrap ${
          isBet ? "bg-bot-green/15 text-bot-green border border-bot-green/20" : "bg-bot-surface/40 text-bot-muted/50 border border-bot-border/30"
        }`}>{rr.decision}</span>
      </div>
      <div className="flex gap-4 text-[10px] font-mono">
        <span className={rr.recommendedSide === "YES" ? "text-bot-green" : "text-bot-red"}>
          {rr.recommendedSide}
        </span>
        <span className="text-bot-muted/40">P(real)={((rr.pReal) * 100).toFixed(1)}%</span>
        <span className="text-bot-muted/40">P(mkt)={((rr.pMarket) * 100).toFixed(1)}%</span>
        <span className={rr.edge > 0 ? "text-bot-green" : "text-bot-red"}>Edge={((rr.edge) * 100).toFixed(1)}%</span>
        <span className="text-bot-muted/40">Conf={rr.confidence}</span>
        {rr.kellyResult && rr.kellyResult.betAmount > 0 && (
          <span className="text-bot-green font-bold">${rr.kellyResult.betAmount.toFixed(2)}</span>
        )}
      </div>
    </div>
  );
}

function StatBox({ label, value, color }: { label: string; value: string; color: string }) {
  const colors: Record<string, string> = {
    white: "text-white", cyan: "text-bot-cyan", purple: "text-bot-purple",
    green: "text-bot-green", yellow: "text-amber-400", blue: "text-bot-cyan",
    red: "text-bot-red", gray: "text-bot-muted", orange: "text-orange-400",
  };
  return (
    <div className="glass-card rounded-lg px-3 py-2">
      <div className="text-[9px] text-bot-muted/40 uppercase font-display font-bold tracking-wider">{label}</div>
      <div className={`text-lg font-display font-black ${colors[color] || "text-white"}`}>{value}</div>
    </div>
  );
}

function MiniStat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="text-center">
      <div className="text-[9px] text-bot-muted/40 font-display">{label}</div>
      <div className={`text-[11px] font-bold ${color || "text-white"}`}>{value}</div>
    </div>
  );
}
