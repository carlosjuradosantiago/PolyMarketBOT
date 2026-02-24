import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "./i18n";
import Header from "./components/Header";
import TopCards from "./components/TopCards";
import BalanceChart from "./components/BalanceChart";
import ActivityLog from "./components/ActivityLog";
import StatsPanel from "./components/StatsPanel";
import SettingsPanel from "./components/SettingsPanel";
import MarketsPanel from "./components/MarketsPanel";
import OrdersPanel from "./components/OrdersPanel";
import AIPanel from "./components/AIPanel";
import ConsolePanel from "./components/ConsolePanel";
import {
  BotStats,
  ActivityEntry,
  BalancePoint,
  BotConfig,
  Portfolio,
  AICostTracker,
  KellyResult,
  WalletInfo,
  defaultStats,
  defaultConfig,
  defaultPortfolio,
  defaultAICostTracker,
  migrateBotConfig,
} from "./types";
// ── Servicios de LECTURA desde DB ──
import {
  supabase,
  dbLoadPortfolio,
  dbGetBotState,
  dbSetBotState,
  dbGetActivities,
  dbLoadCostTracker,
  dbGetCycleLogs,
  dbLoadBotConfig,
  dbSaveBotConfig,
  dbSetInitialBalance,
} from "./services/db";
// ── Edge Functions para MUTACIONES ──
import {
  callRunCycle,
  callRunCycleChain,
  callStopBot,
  callResetBot,
} from "./services/edgeFunctions";
// ── Funciones puras de cálculo (sin side-effects) ──
import { calculateStats, getBalanceHistory } from "./services/paperTrading";
import { fetchPaperOrderPrices, PaperPriceMap, PaperOrderRef } from "./services/polymarket";

type ViewMode = "dashboard" | "markets" | "orders" | "ai" | "console";

function App() {
  const { t, locale } = useTranslation();

  // ── Estado desde DB (se refresca con polling cada 5s) ──
  const [portfolio, setPortfolio] = useState<Portfolio>(defaultPortfolio);
  const [stats, setStats] = useState<BotStats>(defaultStats);
  const [activities, setActivities] = useState<ActivityEntry[]>([]);
  const [balanceHistory, setBalanceHistory] = useState<BalancePoint[]>([
    { timestamp: "Start", balance: 100, label: "Start" },
  ]);
  const [config, setConfig] = useState<BotConfig>(defaultConfig);
  const [aiCostTracker, setAiCostTracker] = useState<AICostTracker>({ ...defaultAICostTracker });
  const [walletInfo, setWalletInfo] = useState<WalletInfo | null>(null);
  const [paperPrices, setPaperPrices] = useState<PaperPriceMap>({});

  // ── Estado del bot desde bot_state ──
  const [isRunning, setIsRunning] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [startTime, setStartTime] = useState<Date | null>(null);
  const [, setLastError] = useState<string | null>(null);
  const [, setLastCycleAt] = useState<string | null>(null);

  // ── Estado UI (solo local) ──
  const [viewMode, setViewMode] = useState<ViewMode>("dashboard");
  const [showSettings, setShowSettings] = useState(false);
  const [isManualRunning, setIsManualRunning] = useState(false);
  const [countdown, setCountdown] = useState(0);

  // ── AI Panel data (del ultimo cycle_log) ──
  const [lastKellyResults] = useState<KellyResult[]>([]);
  const [bankrollStatus, setBankrollStatus] = useState("");
  const [marketsEligible, setMarketsEligible] = useState(0);
  const [marketsAnalyzed, setMarketsAnalyzed] = useState(0);
  const [dynamicInterval, setDynamicInterval] = useState(600);
  const [lastCycleCost, setLastCycleCost] = useState(0);

  // ── Refs ──
  const portfolioRef = useRef(portfolio);
  portfolioRef.current = portfolio;

  // ═══════════════════════════════════════════════════
  // FUNCIONES DE CÁLCULO (puras, sin side-effects)
  // ═══════════════════════════════════════════════════

  const updateStatsFromPortfolio = useCallback((p: Portfolio) => {
    const calcStats = calculateStats(p);
    setStats(prev => ({
      ...prev,
      current_balance: p.balance,
      initial_balance: p.initialBalance,
      total_pnl: calcStats.totalPnl,
      total_pnl_pct: `${calcStats.totalPnl >= 0 ? "+" : ""}$${calcStats.totalPnl.toFixed(2)}`,
      win_rate: calcStats.winRate,
      wins: calcStats.wins,
      losses: calcStats.losses,
      total_trades: calcStats.wins + calcStats.losses,
      avg_bet: calcStats.avgBet,
      best_trade: calcStats.bestTrade,
      worst_trade: calcStats.worstTrade,
      open_orders: p.openOrders.length,
      pending_value: p.openOrders.reduce((sum, o) => sum + o.potentialPayout, 0),
      invested_in_orders: p.openOrders.reduce((sum, o) => sum + o.totalCost, 0),
    }));

    const history = getBalanceHistory(p);
    setBalanceHistory(history);
  }, []);

  // ═══════════════════════════════════════════════════
  // CARGA DE DATOS (solo lecturas de DB)
  // ═══════════════════════════════════════════════════

  /** Refresca todos los datos del dashboard desde la DB */
  const refreshData = useCallback(async () => {
    try {
      // Cargar portfolio + órdenes desde DB
      const p = await dbLoadPortfolio();
      setPortfolio(p);
      updateStatsFromPortfolio(p);

      // Cargar estado del bot
      const botState = await dbGetBotState();
      setIsRunning(botState.isRunning);
      setIsAnalyzing(botState.analyzing);
      setLastError(botState.lastError);
      setLastCycleAt(botState.lastCycleAt);
      setDynamicInterval(botState.dynamicInterval);
      if (botState.startTime) setStartTime(new Date(botState.startTime));
      setStats(prev => ({ ...prev, cycle: botState.cycleCount }));

      // Bankroll status
      const bal = p.balance;
      if (bal < 1) setBankrollStatus("💀 Sin fondos");
      else if (bal < 10) setBankrollStatus("⚠️ Bankroll crítico");
      else if (bal < 50) setBankrollStatus("🔸 Bankroll bajo");
      else setBankrollStatus("✅ Bankroll saludable");

      // Cargar actividades
      const acts = await dbGetActivities(200);
      setActivities(acts);

      // Cargar costos IA
      const costs = await dbLoadCostTracker();
      setAiCostTracker(costs);

      // Cargar último cycle_log para el panel AI
      const cycleLogs = await dbGetCycleLogs(1);
      if (cycleLogs.length > 0) {
        const last = cycleLogs[0];
        setMarketsAnalyzed(last.recommendations || 0);
        setMarketsEligible(last.totalMarkets || 0);
        setLastCycleCost(last.costUsd || 0);
        setStats(prev => ({
          ...prev,
          markets_scanned: last.totalMarkets || prev.markets_scanned,
          signals_generated: last.recommendations || prev.signals_generated,
        }));
      }
    } catch (e) {
      console.error("[App] Error refrescando datos:", e);
    }
  }, [updateStatsFromPortfolio]);

  /** Carga configuración del bot desde bot_kv */
  const loadConfig = useCallback(async () => {
    try {
      const savedConfig = await dbLoadBotConfig();
      if (savedConfig) {
        const merged = migrateBotConfig(savedConfig);
        setConfig(merged);
        console.log("[App] ✅ Config cargada:", merged.ai_provider, merged.ai_model);
      }
    } catch (e) {
      console.error("[App] Error cargando config:", e);
    }
  }, []);

  /** Carga wallet info desde el proxy server */
  const walletLoadCount = useRef(0);
  const loadWalletInfo = useCallback(async () => {
    try {
      const resp = await fetch("/api/wallet");
      if (!resp.ok) return;
      const info = await resp.json();
      setWalletInfo(info);
      if (walletLoadCount.current === 0 && info.isValid && info.balance) {
        console.log(`[Wallet] Conectada: ${info.address}`);
        console.log(`[Wallet] USDC: $${info.balance.usdc.toFixed(2)}, MATIC: ${info.balance.matic.toFixed(4)}`);
      }
      walletLoadCount.current++;
    } catch {
      // Silencioso — reintenta en el próximo intervalo
    }
  }, []);

  /** Carga precios actuales para órdenes paper (Gamma API, solo lectura) */
  const loadPaperPrices = useCallback(async () => {
    const orders = portfolioRef.current.openOrders;
    if (orders.length === 0) return;
    const refs: PaperOrderRef[] = orders
      .filter(o => o.marketId)
      .map(o => ({ conditionId: o.conditionId, marketId: o.marketId }));
    if (refs.length === 0) return;
    try {
      const prices = await fetchPaperOrderPrices(refs);
      setPaperPrices(prices);
    } catch {
      // Silencioso
    }
  }, []);

  // ═══════════════════════════════════════════════════
  // EFFECTS — Inicialización + Polling
  // ═══════════════════════════════════════════════════

  // Carga inicial + polling cada 5s
  useEffect(() => {
    refreshData();
    loadConfig();
    loadWalletInfo();

    // Polling: refrescar datos cada 5 segundos
    const dataInterval = setInterval(refreshData, 5000);
    // Wallet info cada 10s
    const walletInterval = setInterval(loadWalletInfo, 10_000);
    // Paper prices cada 10s
    const paperInterval = setInterval(loadPaperPrices, 10_000);

    return () => {
      clearInterval(dataInterval);
      clearInterval(walletInterval);
      clearInterval(paperInterval);
    };
  }, [refreshData, loadConfig, loadWalletInfo, loadPaperPrices]);

  // Cargar paper prices cuando hay órdenes abiertas
  useEffect(() => {
    if (portfolio.openOrders.length > 0) loadPaperPrices();
  }, [portfolio.openOrders.length, loadPaperPrices]);

  // Countdown hasta próximo ciclo (cron 9:00 AM Colombia = 14:00 UTC)
  useEffect(() => {
    if (!isRunning) {
      setCountdown(0);
      return;
    }
    const updateCountdown = () => {
      const now = new Date();
      const utcMs = now.getTime() + now.getTimezoneOffset() * 60_000;
      const col = new Date(utcMs - 5 * 3600_000);
      const target = new Date(col);
      target.setHours(9, 0, 0, 0);
      if (col.getHours() >= 9) target.setDate(target.getDate() + 1);
      const diffMs = target.getTime() - col.getTime();
      setCountdown(Math.max(0, Math.ceil(diffMs / 1000)));
    };
    updateCountdown();
    const id = setInterval(updateCountdown, 1000);
    return () => clearInterval(id);
  }, [isRunning]);

  // Uptime ticker
  useEffect(() => {
    if (!isRunning || !startTime) return;
    const id = setInterval(() => {
      const elapsed = Date.now() - startTime.getTime();
      const hours = Math.floor(elapsed / 3600000);
      const minutes = Math.floor((elapsed % 3600000) / 60000);
      const seconds = Math.floor((elapsed % 60000) / 1000);
      setStats(prev => ({
        ...prev,
        uptime: `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`,
      }));
    }, 1000);
    return () => clearInterval(id);
  }, [isRunning, startTime]);

  // Suscripción Realtime para bot_state (actualizaciones instantáneas de analyzing)
  useEffect(() => {
    const channel = supabase
      .channel("bot_state_changes")
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "bot_state", filter: "id=eq.1" },
        (payload) => {
          const d = payload.new as any;
          setIsRunning(!!d.is_running);
          setIsAnalyzing(!!d.analyzing);
          setLastError(d.last_error || null);
          setLastCycleAt(d.last_cycle_at || null);
          if (d.start_time) setStartTime(new Date(d.start_time));
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  // ═══════════════════════════════════════════════════
  // HANDLERS — Delegados a Edge Functions
  // ═══════════════════════════════════════════════════

  /** Iniciar bot (solo marca is_running=true en DB — cron se encarga del resto) */
  const handleStart = useCallback(async () => {
    const now = new Date();
    await dbSetBotState({ isRunning: true, startTime: now.toISOString() });
    setIsRunning(true);
    setStartTime(now);
  }, []);

  /** Detener bot via Edge Function */
  const handleStop = useCallback(async () => {
    const result = await callStopBot();
    if (result.ok) {
      setIsRunning(false);
      setIsAnalyzing(false);
    }
    await refreshData();
  }, [refreshData]);

  /** Forzar ciclo manual via Edge Function — encadena hasta 5 batches independientes */
  const handleForceRun = useCallback(async () => {
    if (isManualRunning || isAnalyzing) return;
    setIsManualRunning(true);
    setIsAnalyzing(true);

    const MAX_CHAIN_BATCHES = 5;
    const PER_CALL_TIMEOUT_MS = 155_000; // 155s safety — Edge Function muere a 150s
    let totalBets = 0;
    let totalRecs = 0;
    let totalCost = 0;
    let batchesDone = 0;

    try {
      for (let i = 0; i < MAX_CHAIN_BATCHES; i++) {
        const isLastBatch = i === MAX_CHAIN_BATCHES - 1;
        const callFn = isLastBatch ? callRunCycle : callRunCycleChain;

        console.log(`[App] Batch ${i + 1}/${MAX_CHAIN_BATCHES} — ${isLastBatch ? 'FINAL' : 'chain'}...`);

        // Llamada con timeout de seguridad
        const result = await Promise.race([
          callFn(),
          new Promise<{ ok: false; error: string; timedOut: true }>((resolve) =>
            setTimeout(() => resolve({ ok: false, error: "Timeout: la función no respondió en 155s", timedOut: true }), PER_CALL_TIMEOUT_MS)
          ),
        ]);

        batchesDone++;

        if (!result.ok) {
          console.error(`[App] Batch ${i + 1} error:`, result.error);
          break;
        }

        totalBets += result.betsPlaced || 0;
        totalRecs += result.recommendations || 0;
        totalCost += result.costUsd || 0;
        console.log(`[App] Batch ${i + 1} OK: ${result.betsPlaced} bets, ${result.recommendations} recs, $${(result.costUsd || 0).toFixed(4)}`);

        // Si no hay más mercados frescos, parar
        if (!(result as any).hasMoreMarkets) {
          console.log(`[App] No more fresh markets — stopping chain after ${batchesDone} batches`);
          break;
        }

        // Pequeña pausa entre batches para no saturar
        if (!isLastBatch) {
          await new Promise(r => setTimeout(r, 2000));
        }
      }

      console.log(`[App] Cadena completa: ${batchesDone} batches, ${totalBets} bets, ${totalRecs} recs, $${totalCost.toFixed(4)}`);
    } catch (e) {
      console.error("[App] Error en cadena de batches:", e);
    } finally {
      setIsManualRunning(false);
      // Asegurar que analyzing=false en DB (safety net por si la última llamada murió)
      try {
        await supabase.from("bot_state").update({ analyzing: false }).eq("id", 1);
      } catch { /* ignore */ }
      await refreshData();
    }
  }, [isManualRunning, isAnalyzing, refreshData]);

  /** Reset total via Edge Function */
  const handleReset = useCallback(async () => {
    const confirmMsg = locale === "es"
      ? "⚠️ ATENCIÓN: Esto borrará TODAS las órdenes, actividades, logs de ciclos y costos IA.\n\nEsta acción es IRREVERSIBLE.\n\n¿Estás seguro?"
      : "⚠️ WARNING: This will DELETE ALL orders, activities, cycle logs, and AI costs.\n\nThis action is IRREVERSIBLE.\n\nAre you sure?";
    if (!window.confirm(confirmMsg)) return;

    const bal = config.initial_balance || 1500;
    const result = await callResetBot(bal);
    if (result.ok) {
      setActivities([]);
      setAiCostTracker({ ...defaultAICostTracker });
      setBankrollStatus("");
      setMarketsEligible(0);
      setMarketsAnalyzed(0);
      setLastCycleCost(0);
      await refreshData();
    }
  }, [config.initial_balance, locale, refreshData]);

  /** Actualización de portfolio desde componentes hijo (MarketsPanel, OrdersPanel) */
  const handlePortfolioUpdate = useCallback((newPortfolio: Portfolio) => {
    setPortfolio(newPortfolio);
    updateStatsFromPortfolio(newPortfolio);
    // El componente ya escribió a DB — solo actualizamos el estado local
  }, [updateStatsFromPortfolio]);

  /** Agregar actividad local (para callbacks de componentes hijo) */
  const addActivity = useCallback((message: string, type: string) => {
    const ts = new Date();
    const timestamp = `[${String(ts.getHours()).padStart(2, "0")}:${String(ts.getMinutes()).padStart(2, "0")}:${String(ts.getSeconds()).padStart(2, "0")}]`;
    setActivities(prev => {
      const entry: ActivityEntry = { timestamp, message, entry_type: type as any };
      return [...prev, entry].slice(-200);
    });
  }, []);

  /** Guardar configuración */
  const handleSaveConfig = useCallback(async (newConfig: BotConfig) => {
    const oldConfig = config;
    setConfig(newConfig);

    const result = await dbSaveBotConfig(newConfig);
    if (result.ok) {
      addActivity(`✅ Config guardada: ${newConfig.ai_provider}/${newConfig.ai_model}`, "Info");
      setShowSettings(false);
    } else {
      addActivity(`❌ Error guardando config: ${result.error}`, "Error");
      console.error("[App] Config save failed:", result.error);
    }

    // Si cambió el balance inicial, actualizar en DB
    if (newConfig.initial_balance !== oldConfig.initial_balance) {
      try {
        await dbSetInitialBalance(newConfig.initial_balance);
        await refreshData();
        addActivity(t("app.balanceUpdated", newConfig.initial_balance.toFixed(2)), "Info");
      } catch (e) {
        console.error("[App] Error actualizando balance inicial:", e);
      }
    }
  }, [config, addActivity, refreshData, t]);

  // ═══════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════

  return (
    <div className="w-full h-full bg-bot-bg flex flex-col overflow-hidden relative z-10">
      {/* Header */}
      <Header
        stats={stats}
        isRunning={isRunning}
        isDemoMode={true}
        countdown={countdown}
        onStart={handleStart}
        onStop={handleStop}
        onForceRun={handleForceRun}
        isManualRunning={isManualRunning}
        isAnalyzing={isAnalyzing}
        onSettings={() => setShowSettings(true)}
      />

      {/* Navigation Tabs */}
      <div className="px-5 pt-3">
        <div className="flex items-center gap-1 bg-bot-surface/50 backdrop-blur-sm rounded-xl p-1 border border-bot-border/40 w-fit">
          {[
            { id: "dashboard", label: t("tab.dashboard"), icon: "◈" },
            { id: "markets", label: t("tab.markets"), icon: "◉" },
            { id: "orders", label: t("tab.orders"), icon: "◎" },
            { id: "ai", label: t("tab.ai"), icon: "◆" },
            { id: "console", label: isAnalyzing ? t("tab.analyzing") : `${t("tab.console")} ${countdown > 0 ? `(${countdown >= 3600 ? `${Math.floor(countdown/3600)}h${String(Math.floor((countdown%3600)/60)).padStart(2,'0')}m` : `${Math.floor(countdown/60)}:${String(countdown%60).padStart(2,'0')}`})` : ""}`, icon: "▣" },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setViewMode(tab.id as ViewMode)}
              className={`px-4 py-1.5 rounded-lg text-xs font-display font-semibold transition-all flex items-center gap-1.5
                ${viewMode === tab.id
                  ? "tab-active"
                  : "text-bot-muted hover:text-white hover:bg-white/[0.03]"
                }`}
            >
              <span className="text-[10px] opacity-60">{tab.icon}</span>
              {tab.label}
            </button>
          ))}

          {/* Reset Button */}
          <div className="w-px h-5 bg-bot-border/30 mx-1" />
          <button
            onClick={handleReset}
            className="px-3 py-1.5 rounded-lg text-xs font-display font-medium text-bot-red/60 
                     hover:text-bot-red hover:bg-bot-red/5 border border-transparent hover:border-bot-red/15 transition-all"
          >
            {t("tab.reset")}
          </button>
        </div>
      </div>

      {/* Top Cards */}
      <TopCards stats={stats} walletInfo={walletInfo} />

      {/* Main Content */}
      <div className="flex-1 flex gap-2.5 px-5 pb-3 min-h-0 overflow-hidden">
        {viewMode === "dashboard" && (
          <>
            <div className="flex-1 min-w-0 animate-fade-in">
              <BalanceChart history={balanceHistory} />
            </div>
            <div className="w-[420px] flex-shrink-0 animate-slide-in-right">
              <ActivityLog activities={activities} />
            </div>
          </>
        )}

        {viewMode === "markets" && (
          <div className="flex-1 min-w-0 overflow-auto animate-fade-in">
            <MarketsPanel
              portfolio={portfolio}
              onPortfolioUpdate={handlePortfolioUpdate}
              onActivity={addActivity}
            />
          </div>
        )}

        {viewMode === "orders" && (
          <div className="flex-1 min-w-0 overflow-auto animate-fade-in">
            <OrdersPanel
              portfolio={portfolio}
              onPortfolioUpdate={handlePortfolioUpdate}
              onActivity={addActivity}
              paperPrices={paperPrices}
            />
          </div>
        )}

        {viewMode === "ai" && (
          <div className="flex-1 min-w-0 overflow-auto animate-fade-in">
            <AIPanel
              aiCostTracker={aiCostTracker}
              lastKellyResults={lastKellyResults}
              bankrollStatus={bankrollStatus}
              smartMode={true}
              marketsEligible={marketsEligible}
              marketsAnalyzed={marketsAnalyzed}
              dynamicInterval={dynamicInterval}
              portfolio={portfolio}
              maxExpiryHours={config.max_expiry_hours}
            />
          </div>
        )}

        {viewMode === "console" && (
          <div className="flex-1 min-w-0 overflow-auto animate-fade-in">
            <ConsolePanel
              isAnalyzing={isAnalyzing}
              countdown={countdown}
              lastCycleCost={lastCycleCost}
              aiCostTracker={aiCostTracker}
            />
          </div>
        )}
      </div>

      {/* Bottom Stats */}
      <StatsPanel stats={stats} />

      {/* Settings Modal */}
      {showSettings && (
        <SettingsPanel
          config={config}
          onSave={handleSaveConfig}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}

export default App;
