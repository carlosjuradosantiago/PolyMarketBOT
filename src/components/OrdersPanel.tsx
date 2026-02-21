import { useMemo, useState, useEffect } from "react";
import { Portfolio, PaperOrder } from "../types";
import { cancelPaperOrder } from "../services/paperTrading";
import { PaperPriceMap } from "../services/polymarket";
import { translateMarketQuestion, translateOutcome } from "../utils/translate";
import { useTranslation } from "../i18n";

interface OrdersPanelProps {
  portfolio: Portfolio;
  onPortfolioUpdate: (portfolio: Portfolio) => void;
  onActivity: (message: string, type: string) => void;
  paperPrices: PaperPriceMap;
}

type OrderTab = "active" | "won" | "lost" | "cancelled";
type TFunc = (...args: any[]) => string;

// ─── Helpers ────────────────────────────────────────────────

function formatDate(dateStr: string, locale: string) {
  return new Date(dateStr).toLocaleString(locale === "es" ? "es-ES" : "en-US", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
  });
}

function formatDateShort(dateStr: string, locale: string) {
  return new Date(dateStr).toLocaleDateString(locale === "es" ? "es-ES" : "en-US", {
    day: "2-digit", month: "short", year: "2-digit",
  });
}

function formatTimeAgo(dateStr: string, t: TFunc) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const m = Math.floor(diff / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return t("orders.ago.days", String(d));
  if (h > 0) return t("orders.ago.hours", String(h));
  if (m > 0) return t("orders.ago.minutes", String(m));
  return t("orders.ago.now");
}

function formatTimeRemaining(endDateStr?: string, t?: TFunc) {
  if (!endDateStr) return null;
  const _t: TFunc = t || ((k: string, ..._a: any[]) => k);
  const endMs = new Date(endDateStr).getTime();
  const now = Date.now();
  const diff = endMs - now;
  
  if (diff <= 0) {
    const agoMs = now - endMs;
    const agoMin = Math.floor(agoMs / 60000);
    const agoH = Math.floor(agoMin / 60);
    const agoD = Math.floor(agoH / 24);
    const agoStr = agoD > 0 ? `${agoD}d ${agoH % 24}h` : agoH > 0 ? `${agoH}h ${agoMin % 60}m` : `${agoMin}m`;
    
    const locale = "es-ES";
    const closedDate = new Date(endDateStr).toLocaleString(locale, {
      day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
    });
    
    return { 
      text: _t("orders.closed.oraclePending", agoStr), 
      detail: _t("orders.closedDate", closedDate),
      expired: true 
    };
  }
  
  const totalSecs = Math.floor(diff / 1000);
  const d = Math.floor(totalSecs / 86400);
  const h = Math.floor((totalSecs % 86400) / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  const timeStr = d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${String(m).padStart(2,'0')}m ${String(s).padStart(2,'0')}s` : `${m}m ${String(s).padStart(2,'0')}s`;
  
  return { text: _t("orders.bettingCloses", timeStr), detail: null, expired: false };
}

/** Estimated resolution: endDate + small buffer. Returns human-readable date + estimate label. */
function formatResolutionEstimate(endDateStr?: string, t?: TFunc): { label: string; dateStr: string; isPast: boolean } | null {
  if (!endDateStr) return null;
  const _t: TFunc = t || ((k: string, ..._a: any[]) => k);
  const endDate = new Date(endDateStr);
  if (isNaN(endDate.getTime())) return null;
  const now = Date.now();
  const endMs = endDate.getTime();

  const dateFormatted = endDate.toLocaleString("es-ES", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });

  if (now > endMs) {
    return { label: _t("orders.pendingOracle"), dateStr: dateFormatted, isPast: true };
  }

  const diffMs = endMs - now;
  const diffDays = diffMs / 86400000;

  let estimate: string;
  if (diffDays < 1) {
    estimate = _t("orders.resolveTodayTomorrow");
  } else if (diffDays < 2) {
    estimate = _t("orders.resolveInDays", "1-2");
  } else if (diffDays < 7) {
    estimate = _t("orders.resolveInDays", String(Math.ceil(diffDays)));
  } else if (diffDays < 30) {
    estimate = _t("orders.resolveInWeeks", String(Math.ceil(diffDays / 7)));
  } else {
    estimate = _t("orders.resolveInMonths", String(Math.ceil(diffDays / 30)));
  }

  return { label: estimate, dateStr: dateFormatted, isPast: false };
}

function formatDuration(fromDate: string, toDate: string) {
  const diff = new Date(toDate).getTime() - new Date(fromDate).getTime();
  const m = Math.floor(diff / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
}

function getTimeProgress(createdAt: string, endDate?: string): number {
  if (!endDate) return 0;
  const start = new Date(createdAt).getTime();
  const end = new Date(endDate).getTime();
  const now = Date.now();
  const total = end - start;
  if (total <= 0) return 100;
  return Math.min(100, Math.max(0, ((now - start) / total) * 100));
}

// ─── Main Component ─────────────────────────────────────────

export default function OrdersPanel({ portfolio, onPortfolioUpdate, onActivity, paperPrices }: OrdersPanelProps) {
  const [activeTab, setActiveTab] = useState<OrderTab>("active");
  const { t } = useTranslation();

  // Live tick every 1s so countdowns update in real-time with seconds
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick(t => t + 1), 1_000);
    return () => clearInterval(id);
  }, []);

  const openOrders = portfolio.openOrders;
  const wonOrders = useMemo(() =>
    portfolio.closedOrders
      .filter(o => o.status === "won")
      .sort((a, b) => new Date(b.resolvedAt || b.createdAt).getTime() - new Date(a.resolvedAt || a.createdAt).getTime()),
    [portfolio.closedOrders]
  );
  const lostOrders = useMemo(() =>
    portfolio.closedOrders
      .filter(o => o.status === "lost")
      .sort((a, b) => new Date(b.resolvedAt || b.createdAt).getTime() - new Date(a.resolvedAt || a.createdAt).getTime()),
    [portfolio.closedOrders]
  );
  const cancelledOrders = useMemo(() =>
    portfolio.closedOrders
      .filter(o => o.status === "cancelled")
      .sort((a, b) => new Date(b.resolvedAt || b.createdAt).getTime() - new Date(a.resolvedAt || a.createdAt).getTime()),
    [portfolio.closedOrders]
  );

  const handleCancelOrder = (order: PaperOrder) => {
    const updatedPortfolio = cancelPaperOrder(order.id, portfolio);
    onPortfolioUpdate(updatedPortfolio);
    onActivity(t("orders.cancelledActivity", order.marketQuestion.slice(0, 40)), "Warning");
  };

  // Stats
  const totalInvested = openOrders.reduce((sum, o) => sum + o.totalCost, 0);
  const totalPendingPayout = openOrders.reduce((sum, o) => sum + o.potentialPayout, 0);
  const totalWonPnl = wonOrders.reduce((sum, o) => sum + (o.pnl || 0), 0);
  const totalLostPnl = lostOrders.reduce((sum, o) => sum + (o.pnl || 0), 0);
  const netPnl = totalWonPnl + totalLostPnl;
  const winRate = wonOrders.length + lostOrders.length > 0
    ? ((wonOrders.length / (wonOrders.length + lostOrders.length)) * 100)
    : 0;
  const avgReturn = wonOrders.length > 0
    ? (wonOrders.reduce((s, o) => s + ((o.pnl || 0) / o.totalCost) * 100, 0) / wonOrders.length)
    : 0;

  // Compute unrealized P&L from live paper prices
  const hasPrices = Object.keys(paperPrices).length > 0;
  let unrealizedPnl = 0;
  let currentMarketValue = 0;
  if (hasPrices) {
    openOrders.forEach(o => {
      const priceData = paperPrices[o.conditionId];
      if (priceData && priceData.outcomePrices[o.outcomeIndex] != null) {
        const curPrice = priceData.outcomePrices[o.outcomeIndex];
        const val = curPrice * o.quantity;
        currentMarketValue += val;
        unrealizedPnl += val - o.totalCost;
      } else {
        currentMarketValue += o.totalCost;
      }
    });
  }

  const tabs: { id: OrderTab; label: string; count: number; icon: string; color: string; activeColor: string }[] = [
    { id: "active",    label: t("orders.tabActive"),    count: openOrders.length,      icon: "⚡", color: "text-bot-cyan",    activeColor: "bg-bot-cyan"    },
    { id: "won",       label: t("orders.tabWon"),       count: wonOrders.length,       icon: "🏆", color: "text-bot-green",   activeColor: "bg-bot-green"   },
    { id: "lost",      label: t("orders.tabLost"),      count: lostOrders.length,      icon: "💀", color: "text-bot-red",     activeColor: "bg-bot-red"     },
    { id: "cancelled", label: t("orders.tabCancelled"), count: cancelledOrders.length, icon: "🚫", color: "text-bot-muted/50", activeColor: "bg-bot-muted"   },
  ];

  return (
    <div className="space-y-4">
      {/* ── Hero Stats ──────────────────────────────────── */}
      <div className="bg-bot-card border border-bot-border rounded-2xl p-5">
        <div className="grid grid-cols-7 gap-4">
          {/* Balance en juego */}
          <div className="col-span-1">
            <div className="text-[10px] text-bot-muted/50 uppercase tracking-wider font-semibold mb-1">{t("orders.inPlay")}</div>
            <div className="text-2xl font-black text-yellow-400">${totalInvested.toFixed(2)}</div>
            <div className="text-xs text-bot-muted/50 mt-0.5">{openOrders.length} {t("orders.positions")}</div>
          </div>
          {/* Valor actual (live) */}
          <div className="col-span-1">
            <div className="text-[10px] text-bot-muted/50 uppercase tracking-wider font-semibold mb-1">VALOR ACTUAL</div>
            <div className={`text-2xl font-black ${hasPrices && openOrders.length > 0 ? (unrealizedPnl >= 0 ? "text-green-400" : "text-red-400") : "text-bot-muted/60"}`}>
              {hasPrices && openOrders.length > 0 ? `$${currentMarketValue.toFixed(2)}` : "---"}
            </div>
            {hasPrices && openOrders.length > 0 && (
              <div className={`text-xs mt-0.5 font-bold ${unrealizedPnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                {unrealizedPnl >= 0 ? "+" : ""}{unrealizedPnl.toFixed(2)} ({totalInvested > 0 ? ((unrealizedPnl / totalInvested) * 100).toFixed(1) : "0"}%)
              </div>
            )}
          </div>
          {/* Pago potencial */}
          <div className="col-span-1">
            <div className="text-[10px] text-bot-muted/50 uppercase tracking-wider font-semibold mb-1">{t("orders.potentialPayout")}</div>
            <div className="text-2xl font-black text-cyan-400">${totalPendingPayout.toFixed(2)}</div>
            <div className="text-xs text-bot-muted/50 mt-0.5">
              {totalInvested > 0 ? `+${((totalPendingPayout / totalInvested - 1) * 100).toFixed(0)}% ${t("orders.return")}` : "—"}
            </div>
          </div>
          {/* Ganado */}
          <div className="col-span-1">
            <div className="text-[10px] text-bot-muted/50 uppercase tracking-wider font-semibold mb-1">{t("orders.won")}</div>
            <div className="text-2xl font-black text-green-400">+${totalWonPnl.toFixed(2)}</div>
            <div className="text-xs text-bot-muted/50 mt-0.5">{wonOrders.length} {t("orders.trades")}</div>
          </div>
          {/* Perdido */}
          <div className="col-span-1">
            <div className="text-[10px] text-bot-muted/50 uppercase tracking-wider font-semibold mb-1">{t("orders.lost")}</div>
            <div className="text-2xl font-black text-red-400">${totalLostPnl.toFixed(2)}</div>
            <div className="text-xs text-bot-muted/50 mt-0.5">{lostOrders.length} {t("orders.trades")}</div>
          </div>
          {/* P&L Neto */}
          <div className="col-span-1">
            <div className="text-[10px] text-bot-muted/50 uppercase tracking-wider font-semibold mb-1">{t("orders.netPnl")}</div>
            <div className={`text-2xl font-black ${netPnl >= 0 ? "text-green-400" : "text-red-400"}`}>
              {netPnl >= 0 ? "+" : ""}${netPnl.toFixed(2)}
            </div>
            <div className="text-xs text-bot-muted/50 mt-0.5">{t("orders.lifetime")}</div>
          </div>
          {/* Win Rate */}
          <div className="col-span-1">
            <div className="text-[10px] text-bot-muted/50 uppercase tracking-wider font-semibold mb-1">{t("orders.winRate")}</div>
            <div className="text-2xl font-black text-white">{winRate.toFixed(0)}%</div>
            <div className="flex items-center gap-2 mt-1">
              <div className="flex-1 h-1.5 bg-bot-surface/60 rounded-full overflow-hidden">
                <div className="h-full bg-gradient-to-r from-green-500 to-green-400 rounded-full transition-all" 
                     style={{ width: `${winRate}%` }} />
              </div>
              <span className="text-[10px] text-bot-muted/50">
                {wonOrders.length}W / {lostOrders.length}L
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* ── Tabs ─────────────────────────────────────── */}
      <div className="flex gap-1 bg-bot-card rounded-xl p-1 border border-bot-border">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold transition-all
              ${activeTab === tab.id
                ? `${tab.activeColor} text-white shadow-lg`
                : "text-bot-muted/50 hover:text-bot-muted/70 hover:bg-white/5"
              }`}
          >
            <span>{tab.icon}</span>
            <span>{tab.label}</span>
            <span className={`inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full text-[10px] font-bold
              ${activeTab === tab.id ? "bg-white/25 text-white" : "bg-white/5 text-bot-muted/50"}`}>
              {tab.count}
            </span>
          </button>
        ))}
      </div>

      {/* ── Content ──────────────────────────────────── */}

      {/* Active Orders */}
      {activeTab === "active" && (
        <div>
          {openOrders.length === 0 ? (
            <EmptyState icon="📭" title={t("orders.emptyActive")} subtitle={t("orders.emptyActiveHint")} />
          ) : (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
              {openOrders.map(order => (
                <ActiveOrderCard key={order.id} order={order} onCancel={handleCancelOrder} paperPrices={paperPrices} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Won Orders */}
      {activeTab === "won" && (
        <div>
          {wonOrders.length === 0 ? (
            <EmptyState icon="🏆" title={t("orders.emptyWon")} subtitle={t("orders.emptyWonHint")} />
          ) : (
            <>
              <WonSummaryBar orders={wonOrders} avgReturn={avgReturn} />
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 mt-3">
                {wonOrders.map(order => (
                  <WonOrderCard key={order.id} order={order} />
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* Lost Orders */}
      {activeTab === "lost" && (
        <div>
          {lostOrders.length === 0 ? (
            <EmptyState icon="🛡️" title={t("orders.emptyLost")} subtitle={t("orders.emptyLostHint")} />
          ) : (
            <>
              <LostSummaryBar orders={lostOrders} />
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 mt-3">
                {lostOrders.map(order => (
                  <LostOrderCard key={order.id} order={order} />
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* Cancelled Orders */}
      {activeTab === "cancelled" && (
        <div>
          {cancelledOrders.length === 0 ? (
            <EmptyState icon="📋" title={t("orders.emptyCancelled")} subtitle={t("orders.emptyCancelledHint")} />
          ) : (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
              {cancelledOrders.map(order => (
                <CancelledOrderCard key={order.id} order={order} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Empty State ─────────────────────────────────────────

function EmptyState({ icon, title, subtitle }: { icon: string; title: string; subtitle: string }) {
  return (
    <div className="glass-card rounded-2xl p-16 text-center">
      <div className="text-6xl mb-4">{icon}</div>
      <div className="text-lg text-bot-muted/60 font-display font-semibold">{title}</div>
      <div className="text-sm text-bot-muted/40 mt-1">{subtitle}</div>
    </div>
  );
}

// ─── Expandable Raw Section (for prompt/response) ────────

function ExpandableRawSection({ title, content, color }: { title: string; content?: string; color: "amber" | "teal" }) {
  const [open, setOpen] = useState(false);
  const { t } = useTranslation();
  if (!content) return null;

  const borderColor = color === "amber" ? "border-amber-500/20" : "border-teal-500/20";
  const bgColor = color === "amber" ? "bg-amber-900/15" : "bg-teal-900/15";
  const headerText = color === "amber" ? "text-amber-400" : "text-teal-400";
  const headerBg = color === "amber" ? "hover:bg-amber-900/25" : "hover:bg-teal-900/25";
  const charCount = content.length;
  const lineCount = content.split("\n").length;

  return (
    <div className={`${bgColor} border ${borderColor} rounded-lg overflow-hidden`}>
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        className={`w-full flex items-center gap-2 px-3 py-2.5 ${headerBg} transition-colors`}
      >
        <span className={`text-[11px] font-bold ${headerText} uppercase tracking-wider flex-1 text-left`}>
          {title}
        </span>
        <span className="text-[9px] text-bot-muted/50 font-mono">{t("orders.linesChars", String(lineCount), String(charCount))}</span>
        <span className={`text-xs ${headerText} transition-transform ${open ? "rotate-180" : ""}`}>▼</span>
      </button>
      {open && (
        <div className="px-3 pb-3" onClick={(e) => e.stopPropagation()}>
          <pre className="text-[10px] text-bot-muted/70 leading-relaxed whitespace-pre-wrap font-mono bg-bot-surface/40 rounded-md p-3 max-h-[500px] overflow-y-auto scrollbar-thin scrollbar-thumb-gray-700">
            {content}
          </pre>
        </div>
      )}
    </div>
  );
}

// ─── AI Reasoning Panel (shared by all card types) ───────

function AIReasoningPanel({ order }: { order: PaperOrder }) {
  const ai = order.aiReasoning;
  const { t } = useTranslation();
  if (!ai) return (
    <div className="mt-3 p-3 bg-bot-surface/60/50 rounded-lg border border-gray-700/50 text-xs text-bot-muted/50 italic">
      {t("orders.noAIData")}
    </div>
  );

  const ca = ai.claudeAnalysis;
  const k = ai.kelly;
  const edgePct = (ca.edge * 100).toFixed(1);
  const pMarketPct = (ca.pMarket * 100).toFixed(1);
  const pRealPct = (ca.pReal * 100).toFixed(1);
  const pLowPct = (ca.pLow * 100).toFixed(1);
  const pHighPct = (ca.pHigh * 100).toFixed(1);

  return (
    <div className="mt-3 space-y-3 animate-in fade-in">
      {/* Claude Analysis */}
      <div className="bg-purple-900/20 border border-purple-500/20 rounded-lg p-3">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-sm">🤖</span>
          <span className="text-[11px] font-bold text-purple-300 uppercase tracking-wider">{t("orders.aiAnalysis")}</span>
          <span className="ml-auto text-[10px] text-bot-muted/50 font-mono">{ai.model}</span>
        </div>

        {/* Probability comparison */}
        <div className="grid grid-cols-3 gap-2 mb-3">
          <div className="bg-bot-surface/30 rounded-md p-2">
            <div className="text-[9px] text-bot-muted/50 uppercase font-semibold">{t("orders.pMarket")}</div>
            <div className="text-base font-black text-yellow-400">{pMarketPct}%</div>
          </div>
          <div className="bg-bot-surface/30 rounded-md p-2">
            <div className="text-[9px] text-bot-muted/50 uppercase font-semibold">{t("orders.pRealAI")}</div>
            <div className="text-base font-black text-cyan-400">{pRealPct}%</div>
            <div className="text-[9px] text-bot-muted/40">[{pLowPct}% - {pHighPct}%]</div>
          </div>
          <div className="bg-bot-surface/30 rounded-md p-2">
            <div className="text-[9px] text-bot-muted/50 uppercase font-semibold">{t("orders.edgeLabel")}</div>
            <div className={`text-base font-black ${parseFloat(edgePct) > 0 ? "text-green-400" : "text-red-400"}`}>
              {parseFloat(edgePct) > 0 ? "+" : ""}{edgePct}%
            </div>
          </div>
        </div>

        {/* Edge visual bar */}
        <div className="mb-3">
          <div className="flex items-center gap-2 text-[10px] text-bot-muted/50 mb-1">
            <span className="text-[10px] text-bot-muted/50">{t("orders.market")} {pMarketPct}%</span>
            <div className="flex-1" />
            <span className="text-[10px] text-bot-muted/50">{t("orders.ia")} {pRealPct}%</span>
          </div>
          <div className="h-2 bg-bot-surface/60 rounded-full overflow-hidden relative">
            <div className="absolute h-full bg-yellow-500/40 rounded-full" 
                 style={{ width: `${ca.pMarket * 100}%` }} />
            <div className="absolute h-full bg-cyan-400 rounded-full opacity-70" 
                 style={{ width: `${ca.pReal * 100}%` }} />
          </div>
        </div>

        {/* Confidence + Side */}
        <div className="flex items-center gap-3 mb-2">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-bot-muted/50">{t("orders.confidenceLabel")}</span>
            <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
              ca.confidence >= 70 ? "bg-green-500/20 text-green-400" :
              ca.confidence >= 50 ? "bg-yellow-500/20 text-yellow-400" :
              "bg-red-500/20 text-red-400"
            }`}>{ca.confidence}/100</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-bot-muted/50">{t("orders.recommendation")}</span>
            <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
              ca.recommendedSide === "YES" ? "bg-green-500/20 text-green-400" :
              ca.recommendedSide === "NO" ? "bg-red-500/20 text-red-400" :
              "bg-gray-500/20 text-bot-muted/60"
            }`}>{ca.recommendedSide}</span>
          </div>
        </div>

        {/* Reasoning */}
        <div className="bg-bot-surface/30 rounded-md p-2 mt-2">
          <div className="text-[9px] text-purple-400/60 uppercase font-bold mb-1">{t("orders.reasoningLabel")}</div>
          <div className="text-[11px] text-bot-muted/70 leading-relaxed whitespace-pre-wrap">{ca.reasoning}</div>
        </div>

        {/* Risks */}
        {ca.risks && (
          <div className="bg-red-900/10 border border-red-500/15 rounded-md p-2 mt-2">
            <div className="text-[9px] text-red-400/60 uppercase font-bold mb-1">{t("orders.risks")}</div>
            <div className="text-[11px] text-bot-muted/70 leading-relaxed">{ca.risks}</div>
          </div>
        )}

        {/* Resolution Criteria */}
        {ca.resolutionCriteria && (
          <div className="bg-blue-900/10 border border-blue-500/15 rounded-md p-2 mt-2">
            <div className="text-[9px] text-blue-400/60 uppercase font-bold mb-1">{t("orders.resolutionCriteria")}</div>
            <div className="text-[11px] text-bot-muted/70 leading-relaxed">{ca.resolutionCriteria}</div>
          </div>
        )}

        {/* SCALP Execution Details */}
        {(ca.evNet !== undefined || ca.maxEntryPrice !== undefined || ca.sizeUsd !== undefined) && (
          <div className="grid grid-cols-4 gap-2 mt-2">
            {ca.evNet !== undefined && (
              <div className="bg-bot-surface/30 rounded-md p-2 text-center">
                <div className="text-[9px] text-bot-muted/50 uppercase">{t("orders.evNet")}</div>
                <div className={`text-sm font-bold ${ca.evNet >= 0 ? "text-green-400" : "text-red-400"}`}>
                  {(ca.evNet * 100).toFixed(1)}%
                </div>
              </div>
            )}
            {ca.maxEntryPrice !== undefined && (
              <div className="bg-bot-surface/30 rounded-md p-2 text-center">
                <div className="text-[9px] text-bot-muted/50 uppercase">{t("orders.maxEntry")}</div>
                <div className="text-sm font-bold text-amber-400">{(ca.maxEntryPrice * 100).toFixed(0)}¢</div>
              </div>
            )}
            {ca.sizeUsd !== undefined && (
              <div className="bg-bot-surface/30 rounded-md p-2 text-center">
                <div className="text-[9px] text-bot-muted/50 uppercase">{t("orders.sizeAI")}</div>
                <div className="text-sm font-bold text-purple-400">${ca.sizeUsd.toFixed(2)}</div>
              </div>
            )}
            {ca.orderType && (
              <div className="bg-bot-surface/30 rounded-md p-2 text-center">
                <div className="text-[9px] text-bot-muted/50 uppercase">{t("orders.orderType")}</div>
                <div className="text-sm font-bold text-blue-400">{ca.orderType}</div>
              </div>
            )}
          </div>
        )}

        {ca.sources.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {ca.sources.map((s, i) => (
              <span key={i} className="text-[9px] px-1.5 py-0.5 bg-purple-500/10 text-purple-400/60 rounded">
                {s}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Full Prompt & Response Expandables */}
      <ExpandableRawSection title={t("orders.promptSent")} content={ai.fullPrompt} color="amber" />
      <ExpandableRawSection title={t("orders.fullResponse")} content={ai.fullResponse} color="teal" />

      {/* Kelly Calculation */}
      <div className="bg-blue-900/20 border border-blue-500/20 rounded-lg p-3">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-sm">📐</span>
          <span className="text-[11px] font-bold text-blue-300 uppercase tracking-wider">{t("orders.kellyCalc")}</span>
        </div>

        <div className="grid grid-cols-5 gap-2">
          <div className="bg-bot-surface/30 rounded-md p-2 text-center">
            <div className="text-[9px] text-bot-muted/50 uppercase">{t("orders.rawKelly")}</div>
            <div className="text-sm font-bold text-blue-400">{(k.rawKelly * 100).toFixed(1)}%</div>
          </div>
          <div className="bg-bot-surface/30 rounded-md p-2 text-center">
            <div className="text-[9px] text-bot-muted/50 uppercase">{t("orders.quarterKelly")}</div>
            <div className="text-sm font-bold text-purple-400">{(k.fractionalKelly * 100).toFixed(1)}%</div>
          </div>
          <div className="bg-bot-surface/30 rounded-md p-2 text-center">
            <div className="text-[9px] text-bot-muted/50 uppercase">{t("orders.betLabel")}</div>
            <div className="text-sm font-bold text-green-400">${k.betAmount.toFixed(2)}</div>
          </div>
          <div className="bg-bot-surface/30 rounded-md p-2 text-center">
            <div className="text-[9px] text-bot-muted/50 uppercase">{t("orders.evLabel")}</div>
            <div className={`text-sm font-bold ${k.expectedValue >= 0 ? "text-green-400" : "text-red-400"}`}>
              ${k.expectedValue.toFixed(3)}
            </div>
          </div>
          <div className="bg-bot-surface/30 rounded-md p-2 text-center">
            <div className="text-[9px] text-bot-muted/50 uppercase">{t("orders.aiCostLabel")}</div>
            <div className="text-sm font-bold text-yellow-400">${k.aiCostPerBet.toFixed(4)}</div>
          </div>
        </div>

        <div className="text-[10px] text-bot-muted/50 mt-2">
          {t("orders.cycleCost", ai.costUsd.toFixed(4))} | {ai.timestamp}
        </div>
      </div>
    </div>
  );
}

// ─── Active Order Card ───────────────────────────────────

function ActiveOrderCard({ order, onCancel, paperPrices }: { order: PaperOrder; onCancel: (o: PaperOrder) => void; paperPrices: PaperPriceMap }) {
  const [expanded, setExpanded] = useState(false);
  const { t, locale } = useTranslation();
  const isYes = order.outcome.toLowerCase() === "yes" || order.outcome.toLowerCase() === "sí";
  const probPct = order.price < 0.01 ? (order.price * 100).toFixed(1) : (order.price * 100).toFixed(0);
  const returnPct = ((order.potentialPayout / order.totalCost - 1) * 100).toFixed(0);
  const timeInfo = formatTimeRemaining(order.endDate, t);
  const resolutionInfo = formatResolutionEstimate(order.endDate, t);
  const progress = getTimeProgress(order.createdAt, order.endDate);
  const hasAI = !!order.aiReasoning;

  // Live price from Gamma API
  const priceData = paperPrices[order.conditionId];
  const currentPrice = priceData?.outcomePrices?.[order.outcomeIndex] ?? null;
  const currentValue = currentPrice != null ? currentPrice * order.quantity : null;
  const unrealizedPnl = currentValue != null ? currentValue - order.totalCost : null;
  const pnlPct = unrealizedPnl != null && order.totalCost > 0 ? (unrealizedPnl / order.totalCost) * 100 : null;

  return (
    <div 
      className={`glass-card border rounded-2xl overflow-hidden transition-all group cursor-pointer
        ${expanded ? "border-purple-500/40 shadow-lg shadow-purple-500/5" : "border-bot-border/30 hover:border-blue-500/40"}`}
      onClick={() => setExpanded(!expanded)}
    >
      {/* Color accent + progress */}
      <div className="relative h-1.5 bg-bot-surface/60">
        <div className={`absolute inset-y-0 left-0 transition-all duration-1000 ${isYes ? "bg-green-500" : "bg-red-500"}`}
             style={{ width: `${progress}%` }} />
      </div>

      <div className="p-4 space-y-3">
        {/* Row 1: Question + AI badge + time ago */}
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <h3 className="text-[13px] font-semibold text-white leading-tight line-clamp-2">
              {translateMarketQuestion(order.marketQuestion)}
            </h3>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {hasAI && (
              <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${
                expanded ? "bg-purple-500/20 text-purple-300 border-purple-500/40" : "bg-purple-500/10 text-purple-400/60 border-purple-500/20"
              }`}>
                🧠 {expanded ? t("orders.closeAI") : t("orders.seeAI")}
              </span>
            )}
            <span className="text-[10px] text-bot-muted/50 whitespace-nowrap mt-0.5">
              {formatTimeAgo(order.createdAt, t)}
            </span>
          </div>
        </div>

        {/* Row 2: Position + Price + Shares + Live Price */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-black uppercase tracking-wide
            ${isYes
              ? "bg-green-500/15 text-green-400 border border-green-500/25"
              : "bg-red-500/15 text-red-400 border border-red-500/25"
            }`}>
            <span className={`w-2 h-2 rounded-full ${isYes ? "bg-green-400" : "bg-red-400"}`} />
            {translateOutcome(order.outcome)}
          </span>
          <div className="flex items-center gap-1 text-xs text-bot-muted/60">
            <span className="font-mono font-bold text-white">{probPct}¢</span>
            {currentPrice != null && (
              <>
                <span>→</span>
                <span className={`font-mono font-bold ${currentPrice > order.price ? "text-green-400" : currentPrice < order.price ? "text-red-400" : "text-white"}`}>
                  {(currentPrice * 100).toFixed(0)}¢
                </span>
              </>
            )}
            <span>×</span>
            <span className="font-mono font-bold text-white">{order.quantity.toFixed(1)}</span>
            <span>{t("orders.shares")}</span>
          </div>
          {/* Live P&L badge */}
          {unrealizedPnl != null && (
            <span className={`ml-1 inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[11px] font-black
              ${unrealizedPnl >= 0
                ? "bg-green-500/15 text-green-400 border border-green-500/25"
                : "bg-red-500/15 text-red-400 border border-red-500/25"
              }`}>
              {unrealizedPnl >= 0 ? "+" : ""}{unrealizedPnl.toFixed(2)}
              <span className="text-[9px] opacity-70">({pnlPct != null ? (pnlPct >= 0 ? "+" : "") + pnlPct.toFixed(0) + "%" : ""})</span>
            </span>
          )}
          {hasAI && (
            <span className={`ml-auto text-[9px] px-1.5 py-0.5 rounded font-bold ${
              order.aiReasoning!.claudeAnalysis.confidence >= 70 ? "bg-green-500/15 text-green-400" :
              order.aiReasoning!.claudeAnalysis.confidence >= 50 ? "bg-yellow-500/15 text-yellow-400" :
              "bg-red-500/15 text-red-400"
            }`}>
              {t("orders.conf")} {order.aiReasoning!.claudeAnalysis.confidence}
            </span>
          )}
        </div>

        {/* Row 3: Stats bar */}
        <div className={`grid ${currentValue != null ? "grid-cols-4" : "grid-cols-3"} gap-2`}>
          <div className="bg-gradient-to-br from-yellow-500/10 to-yellow-600/5 border border-yellow-500/15 rounded-xl px-3 py-2.5">
            <div className="text-[9px] text-yellow-500/70 uppercase font-bold tracking-wider">{t("orders.invested")}</div>
            <div className="text-base font-black text-yellow-400 mt-0.5">${order.totalCost.toFixed(2)}</div>
          </div>
          {currentValue != null && (
            <div className={`bg-gradient-to-br ${unrealizedPnl! >= 0 ? "from-green-500/10 to-green-600/5 border-green-500/15" : "from-red-500/10 to-red-600/5 border-red-500/15"} border rounded-xl px-3 py-2.5`}>
              <div className={`text-[9px] uppercase font-bold tracking-wider ${unrealizedPnl! >= 0 ? "text-green-500/70" : "text-red-500/70"}`}>VALOR ACTUAL</div>
              <div className={`text-base font-black mt-0.5 ${unrealizedPnl! >= 0 ? "text-green-400" : "text-red-400"}`}>
                ${currentValue.toFixed(2)}
              </div>
            </div>
          )}
          <div className="bg-gradient-to-br from-cyan-500/10 to-cyan-600/5 border border-cyan-500/15 rounded-xl px-3 py-2.5">
            <div className="text-[9px] text-cyan-500/70 uppercase font-bold tracking-wider">{t("orders.ifWin")}</div>
            <div className="text-base font-black text-cyan-400 mt-0.5">${order.potentialPayout.toFixed(2)}</div>
          </div>
          <div className="bg-gradient-to-br from-emerald-500/10 to-emerald-600/5 border border-emerald-500/15 rounded-xl px-3 py-2.5">
            <div className="text-[9px] text-emerald-500/70 uppercase font-bold tracking-wider">{t("orders.returnLabel")}</div>
            <div className="text-base font-black text-emerald-400 mt-0.5">+{returnPct}%</div>
          </div>
        </div>

        {/* Row 4: Time remaining + Cancel */}
        <div className="flex items-center justify-between pt-1 border-t border-white/5">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-3">
              <span className="text-[10px] text-bot-muted/40">
                {formatDate(order.createdAt, locale)}
              </span>
              {timeInfo && (
                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-semibold
                  ${timeInfo.expired
                    ? "bg-amber-500/15 text-amber-400 border border-amber-500/20"
                    : "bg-blue-500/10 text-blue-400 border border-blue-500/15"
                  }`}>
                  {timeInfo.expired ? "⏳" : "⏰"} {timeInfo.text}
                </span>
              )}
            </div>
            {timeInfo?.expired && timeInfo.detail && (
              <span className="text-[9px] text-bot-muted/50 ml-0.5">
                {timeInfo.detail}
              </span>
            )}
            {!timeInfo?.expired && resolutionInfo && (
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/15">
                  {t("orders.estimatedResolution", resolutionInfo.label)}
                </span>
                <span className="text-[9px] text-bot-muted/50">
                  ({resolutionInfo.dateStr})
                </span>
              </div>
            )}
          </div>
          <button
            onClick={(e) => { e.stopPropagation(); onCancel(order); }}
            className="flex items-center gap-1 px-3 py-1.5 text-[11px] font-semibold 
                     bg-red-500/8 text-red-400/80 rounded-lg border border-red-500/15
                     hover:bg-red-500/20 hover:text-red-300 hover:border-red-500/40 
                     transition-all opacity-0 group-hover:opacity-100"
          >
            {t("orders.cancel")}
          </button>
        </div>

        {/* Expandable AI Reasoning */}
        {expanded && <AIReasoningPanel order={order} />}
      </div>
    </div>
  );
}

// ─── Won Summary Bar ─────────────────────────────────────

function WonSummaryBar({ orders, avgReturn }: { orders: PaperOrder[]; avgReturn: number }) {
  const totalProfit = orders.reduce((s, o) => s + (o.pnl || 0), 0);
  const bestTrade = orders.reduce((best, o) => (o.pnl || 0) > (best.pnl || 0) ? o : best, orders[0]);
  const { t } = useTranslation();
  return (
    <div className="bg-gradient-to-r from-green-500/10 to-emerald-500/5 border border-green-500/20 rounded-xl px-5 py-3 flex items-center gap-6">
      <div>
        <div className="text-[10px] text-green-400/60 uppercase font-bold">{t("orders.totalWinnings")}</div>
        <div className="text-xl font-black text-green-400">+${totalProfit.toFixed(2)}</div>
      </div>
      <div className="w-px h-8 bg-green-500/20" />
      <div>
        <div className="text-[10px] text-green-400/60 uppercase font-bold">{t("orders.avgReturn")}</div>
        <div className="text-xl font-black text-green-400">+{avgReturn.toFixed(0)}%</div>
      </div>
      <div className="w-px h-8 bg-green-500/20" />
      <div className="flex-1 min-w-0">
        <div className="text-[10px] text-green-400/60 uppercase font-bold">{t("orders.bestTrade")}</div>
        <div className="text-sm font-semibold text-white truncate">
          {translateMarketQuestion(bestTrade?.marketQuestion || "").slice(0, 50)}...
          <span className="text-green-400 ml-1">+${(bestTrade?.pnl || 0).toFixed(2)}</span>
        </div>
      </div>
    </div>
  );
}

// ─── Won Order Card ──────────────────────────────────────

function WonOrderCard({ order }: { order: PaperOrder }) {
  const [expanded, setExpanded] = useState(false);
  const { t, locale } = useTranslation();
  const isYes = order.outcome.toLowerCase() === "yes" || order.outcome.toLowerCase() === "sí";
  const pnl = order.pnl || 0;
  const returnPct = ((pnl / order.totalCost) * 100).toFixed(0);
  const holdTime = order.resolvedAt ? formatDuration(order.createdAt, order.resolvedAt) : "—";
  const hasAI = !!order.aiReasoning;

  return (
    <div 
      className={`glass-card border rounded-2xl overflow-hidden transition-all cursor-pointer
        ${expanded ? "border-green-500/40 shadow-lg shadow-green-500/5" : "border-green-500/20 hover:border-green-500/40"}`}
      onClick={() => setExpanded(!expanded)}
    >
      <div className="h-1 bg-gradient-to-r from-green-500 to-emerald-400" />
      <div className="p-4 space-y-3">
        {/* Question + Badge */}
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <h3 className="text-[13px] font-semibold text-white leading-tight line-clamp-2">
              {translateMarketQuestion(order.marketQuestion)}
            </h3>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {hasAI && (
              <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${
                expanded ? "bg-purple-500/20 text-purple-300 border-purple-500/40" : "bg-purple-500/10 text-purple-400/60 border-purple-500/20"
              }`}>
                🧠 {expanded ? t("orders.closeAI") : t("orders.seeAI")}
              </span>
            )}
            <div className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-green-500/15 border border-green-500/25">
              <span className="text-[10px] font-black text-green-400 uppercase tracking-wide">{t("orders.wonLabel")}</span>
            </div>
          </div>
        </div>

        {/* Position + P&L */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md text-[11px] font-bold
              ${isYes ? "bg-green-500/15 text-green-400" : "bg-red-500/15 text-red-400"}`}>
              {order.outcome} @ {(order.price * 100).toFixed(0)}¢
            </span>
            <span className="text-xs text-bot-muted/50">× {order.quantity.toFixed(1)}</span>
          </div>
          <div className="text-right">
            <div className="text-lg font-black text-green-400">+${pnl.toFixed(2)}</div>
            <div className="text-[10px] text-green-400/60 font-semibold">{t("orders.returnPct", returnPct)}</div>
          </div>
        </div>

        {/* Details row */}
        <div className="flex items-center justify-between pt-2 border-t border-white/5 text-[11px]">
          <div className="flex items-center gap-3 text-bot-muted/50">
            <span>{t("orders.cost")} <span className="text-bot-muted/70 font-medium">${order.totalCost.toFixed(2)}</span></span>
            <span>→</span>
            <span>{t("orders.payout")} <span className="text-green-400 font-medium">${order.potentialPayout.toFixed(2)}</span></span>
          </div>
          <div className="flex items-center gap-3 text-bot-muted/50">
            <span>⏱ {holdTime}</span>
            <span>{formatDateShort(order.resolvedAt || order.createdAt, locale)}</span>
          </div>
        </div>

        {/* Expandable AI Reasoning */}
        {expanded && <AIReasoningPanel order={order} />}
      </div>
    </div>
  );
}

// ─── Lost Summary Bar ────────────────────────────────────

function LostSummaryBar({ orders }: { orders: PaperOrder[] }) {
  const totalLoss = orders.reduce((s, o) => s + (o.pnl || 0), 0);
  const avgLoss = orders.length > 0 ? totalLoss / orders.length : 0;
  const worstTrade = orders.reduce((worst, o) => (o.pnl || 0) < (worst.pnl || 0) ? o : worst, orders[0]);
  const { t } = useTranslation();
  return (
    <div className="bg-gradient-to-r from-red-500/10 to-orange-500/5 border border-red-500/20 rounded-xl px-5 py-3 flex items-center gap-6">
      <div>
        <div className="text-[10px] text-red-400/60 uppercase font-bold">{t("orders.totalLosses")}</div>
        <div className="text-xl font-black text-red-400">${totalLoss.toFixed(2)}</div>
      </div>
      <div className="w-px h-8 bg-red-500/20" />
      <div>
        <div className="text-[10px] text-red-400/60 uppercase font-bold">{t("orders.avgLoss")}</div>
        <div className="text-xl font-black text-red-400">${avgLoss.toFixed(2)}</div>
      </div>
      <div className="w-px h-8 bg-red-500/20" />
      <div className="flex-1 min-w-0">
        <div className="text-[10px] text-red-400/60 uppercase font-bold">{t("orders.worstTrade")}</div>
        <div className="text-sm font-semibold text-white truncate">
          {translateMarketQuestion(worstTrade?.marketQuestion || "").slice(0, 50)}...
          <span className="text-red-400 ml-1">${(worstTrade?.pnl || 0).toFixed(2)}</span>
        </div>
      </div>
    </div>
  );
}

// ─── Lost Order Card ─────────────────────────────────────

function LostOrderCard({ order }: { order: PaperOrder }) {
  const [expanded, setExpanded] = useState(false);
  const { t, locale } = useTranslation();
  const isYes = order.outcome.toLowerCase() === "yes" || order.outcome.toLowerCase() === "sí";
  const pnl = order.pnl || 0;
  const holdTime = order.resolvedAt ? formatDuration(order.createdAt, order.resolvedAt) : "—";
  const hasAI = !!order.aiReasoning;

  return (
    <div 
      className={`glass-card border rounded-2xl overflow-hidden transition-all cursor-pointer
        ${expanded ? "border-red-500/40 shadow-lg shadow-red-500/5 opacity-100" : "border-red-500/15 hover:border-red-500/30 opacity-90 hover:opacity-100"}`}
      onClick={() => setExpanded(!expanded)}
    >
      <div className="h-1 bg-gradient-to-r from-red-500 to-orange-500" />
      <div className="p-4 space-y-3">
        {/* Question + Badge */}
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <h3 className="text-[13px] font-semibold text-bot-muted/70 leading-tight line-clamp-2">
              {translateMarketQuestion(order.marketQuestion)}
            </h3>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {hasAI && (
              <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${
                expanded ? "bg-purple-500/20 text-purple-300 border-purple-500/40" : "bg-purple-500/10 text-purple-400/60 border-purple-500/20"
              }`}>
                🧠 {expanded ? t("orders.closeAI") : t("orders.seeAI")}
              </span>
            )}
            <div className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-red-500/15 border border-red-500/25">
              <span className="text-sm">💀</span>
              <span className="text-[10px] font-black text-red-400 uppercase tracking-wide">{t("orders.lostLabel")}</span>
            </div>
          </div>
        </div>

        {/* Position + Loss */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md text-[11px] font-bold
              ${isYes ? "bg-green-500/10 text-green-400/70" : "bg-red-500/10 text-red-400/70"}`}>
              {order.outcome} @ {(order.price * 100).toFixed(0)}¢
            </span>
            <span className="text-xs text-bot-muted/50">× {order.quantity.toFixed(1)}</span>
          </div>
          <div className="text-right">
            <div className="text-lg font-black text-red-400">${pnl.toFixed(2)}</div>
            <div className="text-[10px] text-red-400/60 font-semibold">{t("orders.lostPct")}</div>
          </div>
        </div>

        {/* Details row */}
        <div className="flex items-center justify-between pt-2 border-t border-white/5 text-[11px]">
          <div className="flex items-center gap-3 text-bot-muted/50">
            <span>{t("orders.investedLabel")} <span className="text-bot-muted/70 font-medium">${order.totalCost.toFixed(2)}</span></span>
            <span>→</span>
            <span>{t("orders.recovered")} <span className="text-red-400/80 font-medium">$0.00</span></span>
          </div>
          <div className="flex items-center gap-3 text-bot-muted/50">
            <span>⏱ {holdTime}</span>
            <span>{formatDateShort(order.resolvedAt || order.createdAt, locale)}</span>
          </div>
        </div>

        {/* Expandable AI Reasoning */}
        {expanded && <AIReasoningPanel order={order} />}
      </div>
    </div>
  );
}

// ─── Cancelled Order Card ────────────────────────────────

function CancelledOrderCard({ order }: { order: PaperOrder }) {
  const [expanded, setExpanded] = useState(false);
  const { t, locale } = useTranslation();
  const isYes = order.outcome.toLowerCase() === "yes" || order.outcome.toLowerCase() === "sí";
  const hasAI = !!order.aiReasoning;

  return (
    <div 
      className={`glass-card border rounded-2xl overflow-hidden transition-all cursor-pointer
        ${expanded ? "border-gray-600/60 opacity-80" : "border-gray-700/50 opacity-60 hover:opacity-80"}`}
      onClick={() => setExpanded(!expanded)}
    >
      <div className="h-1 bg-gray-600" />
      <div className="p-4 space-y-2">
        <div className="flex items-start gap-3">
          <h3 className="text-[13px] font-medium text-bot-muted/60 leading-tight line-clamp-2 flex-1">
            {translateMarketQuestion(order.marketQuestion)}
          </h3>
          <div className="flex items-center gap-2 flex-shrink-0">
            {hasAI && (
              <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${
                expanded ? "bg-purple-500/20 text-purple-300 border-purple-500/40" : "bg-purple-500/10 text-purple-400/60 border-purple-500/20"
              }`}>
                🧠 {expanded ? t("orders.closeAI") : t("orders.seeAI")}
              </span>
            )}
            <span className="text-[10px] font-bold text-bot-muted/50 bg-gray-500/10 px-2 py-0.5 rounded border border-gray-500/20">
              {t("orders.cancelledLabel")}
            </span>
          </div>
        </div>
        <div className="flex items-center justify-between text-[11px] text-bot-muted/50">
          <div className="flex items-center gap-2">
            <span className={`px-2 py-0.5 rounded text-[10px] font-bold
              ${isYes ? "bg-green-500/10 text-green-500/50" : "bg-red-500/10 text-red-500/50"}`}>
              {order.outcome} @ {(order.price * 100).toFixed(0)}¢
            </span>
            <span>{t("orders.refunded", order.totalCost.toFixed(2))}</span>
          </div>
          <span>{formatDate(order.resolvedAt || order.createdAt, locale)}</span>
        </div>

        {/* Expandable AI Reasoning */}
        {expanded && <AIReasoningPanel order={order} />}
      </div>
    </div>
  );
}
