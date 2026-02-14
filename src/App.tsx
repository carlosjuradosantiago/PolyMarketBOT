import { useState, useEffect, useCallback, useRef } from "react";
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
  PolymarketMarket,
  AICostTracker,
  KellyResult,
  defaultStats,
  defaultConfig,
  defaultPortfolio,
  defaultAICostTracker,
} from "./types";
import {
  loadPortfolio,
  savePortfolio,
  resetPortfolio,
  calculateStats,
  getBalanceHistory,
} from "./services/paperTrading";
import { fetchAllMarkets } from "./services/polymarket";
import { getWalletInfo, WalletInfo } from "./services/wallet";
import { clearCachedCreds } from "./services/clobAuth";
import { runSmartCycle, setMaxExpiry, clearAnalyzedCache } from "./services/smartTrader";
import { loadCostTracker, resetCostTracker } from "./services/claudeAI";
import { getBankrollStatus, canTrade } from "./services/kellyStrategy";
import { dbGetBotState, dbSetBotState, dbAddActivity, dbGetActivities, dbAddActivitiesBatch, dbTriggerResolve, dbLoadPortfolio, dbSetInitialBalance } from "./services/db";
import { loadPortfolioFromDB } from "./services/paperTrading";

// One-time: clear stale CLOB credentials so fresh derive runs
const CREDS_VERSION = "v2";
if (localStorage.getItem("clob_creds_version") !== CREDS_VERSION) {
  clearCachedCreds();
  localStorage.setItem("clob_creds_version", CREDS_VERSION);
  console.log("[App] Cleared stale CLOB credentials for re-derive");
}

type ViewMode = "dashboard" | "markets" | "orders" | "ai" | "console";

function App() {
  // Core state
  const [portfolio, setPortfolio] = useState<Portfolio>(defaultPortfolio);
  const [stats, setStats] = useState<BotStats>(defaultStats);
  const [activities, setActivities] = useState<ActivityEntry[]>([]);
  const [balanceHistory, setBalanceHistory] = prepareBalanceHistory();
  const [config, setConfig] = useState<BotConfig>(defaultConfig);
  const [walletInfo, setWalletInfo] = useState<WalletInfo | null>(null);
  
  // UI state  — persist isRunning so bot survives page reloads
  const [isRunning, setIsRunning] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("dashboard");
  const [markets, setMarkets] = useState<PolymarketMarket[]>([]);
  const [startTime, setStartTime] = useState<Date | null>(null);

  // Smart AI Trading state
  const [aiCostTracker, setAiCostTracker] = useState<AICostTracker>({ ...defaultAICostTracker });
  const [lastKellyResults, setLastKellyResults] = useState<KellyResult[]>([]);
  const [dynamicInterval, setDynamicInterval] = useState(600); // seconds
  const [bankrollStatus, setBankrollStatus] = useState("");
  const [marketsEligible, setMarketsEligible] = useState(0);
  const [marketsAnalyzed, setMarketsAnalyzed] = useState(0);
  
  // Console/AI state
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [lastCycleCost, setLastCycleCost] = useState(0);
  const countdownRef = useRef<number | null>(null);
  
  // Refs
  const intervalRef = useRef<number | null>(null);
  const cycleRef = useRef<number>(0);
  const tradingCycleRef = useRef<() => Promise<void>>();
  const dynamicIntervalRef = useRef(600);

  // Initialize portfolio, wallet, and bot state from DB on mount
  useEffect(() => {
    // Sync load from localStorage as fast fallback
    const loaded = loadPortfolio();
    setPortfolio(loaded);
    updateStatsFromPortfolio(loaded);
    
    // Async load from DB (overrides localStorage data)
    (async () => {
      try {
        // Step 1: Load portfolio from DB first to check if it was reset
        // (skip localStorage sync — DB is source of truth after reset)
        const dbPortfolio = await loadPortfolioFromDB();
        setPortfolio(dbPortfolio);
        updateStatsFromPortfolio(dbPortfolio);

        // Step 3: Load AI cost tracker from DB (full history with prompt/response)
        const fullTracker = await loadCostTracker();
        setAiCostTracker(fullTracker);

        // Step 4: Load bot state from DB
        const botState = await dbGetBotState();
        if (botState.isRunning) {
          setIsRunning(true);
          setStartTime(botState.startTime ? new Date(botState.startTime) : new Date());
        }

        // Step 5: Load recent activities from DB
        const dbActivities = await dbGetActivities(200);
        if (dbActivities.length > 0) {
          setActivities(dbActivities);
        }

        // Step 6: Trigger immediate resolution check
        await dbTriggerResolve().catch(() => {});

        console.log("[App] DB state loaded successfully");
        // Apply config to smartTrader (use default 24 if field missing from saved config)
        setMaxExpiry(config.max_expiry_hours || 24);

        // Clear stale localStorage portfolio to prevent re-sync of old orders
        localStorage.removeItem('polymarket_paper_portfolio');
      } catch (e) {
        console.warn("[App] DB load failed, using localStorage fallback:", e);
      }
    })();

    // Load wallet info
    loadWalletInfo();
  }, []);
  
  // Load real wallet balance
  const loadWalletInfo = async () => {
    const privateKey = import.meta.env.VITE_PRIVATE_KEY;
    if (privateKey) {
      try {
        const info = await getWalletInfo(privateKey);
        setWalletInfo(info);
        if (info.isValid && info.balance) {
          console.log(`[Wallet] Connected: ${info.address}`);
          console.log(`[Wallet] USDC: $${info.balance.usdc.toFixed(2)}, MATIC: ${info.balance.matic.toFixed(4)}`);
        }
      } catch (e) {
        console.error("Error loading wallet:", e);
      }
    }
  };

  // Prepare balance history state
  function prepareBalanceHistory(): [BalancePoint[], React.Dispatch<React.SetStateAction<BalancePoint[]>>] {
    return useState<BalancePoint[]>([
      { timestamp: "Start", balance: 100, label: "Start" },
    ]);
  }

  // Update stats from portfolio
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
    
    // Update balance history
    const history = getBalanceHistory(p);
    setBalanceHistory(history);
  }, []);

  // Add activity
  const addActivity = useCallback((message: string, type: string) => {
    const ts = new Date();
    const timestamp = `[${String(ts.getHours()).padStart(2, "0")}:${String(ts.getMinutes()).padStart(2, "0")}:${String(ts.getSeconds()).padStart(2, "0")}]`;
    
    setActivities(prev => {
      const entry: ActivityEntry = {
        timestamp,
        message,
        entry_type: type as any,
      };
      return [...prev, entry].slice(-200);
    });
  }, []);

  // Main trading cycle
  const runTradingCycle = useCallback(async () => {
    cycleRef.current += 1;
    const cycle = cycleRef.current;
    
    // Update uptime
    if (startTime) {
      const elapsed = new Date().getTime() - startTime.getTime();
      const hours = Math.floor(elapsed / 3600000);
      const minutes = Math.floor((elapsed % 3600000) / 60000);
      const seconds = Math.floor((elapsed % 60000) / 1000);
      setStats(prev => ({
        ...prev,
        uptime: `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`,
        cycle,
      }));
    }
    
    try {
      // Check for resolved orders via Supabase (single resolver — no duplicate)
      const resolveResult = await dbTriggerResolve();
      if (resolveResult.justResolved && resolveResult.justResolved.length > 0) {
        resolveResult.justResolved.forEach((o: any) => {
          const pnlStr = o.pnl >= 0 ? `+$${o.pnl.toFixed(2)}` : `-$${Math.abs(o.pnl).toFixed(2)}`;
          addActivity(
            `🔔 RESOLVED "${o.marketQuestion?.slice(0, 40)}..." → ${o.status?.toUpperCase()} ${pnlStr}`,
            o.status === "won" ? "Resolved" : "Warning"
          );
        });
      }
      
      // Reload portfolio from DB (always fresh after resolution)
      const currentPortfolio = await loadPortfolioFromDB();
      setPortfolio(currentPortfolio);
      updateStatsFromPortfolio(currentPortfolio);
      setBankrollStatus(getBankrollStatus(currentPortfolio.balance));

      // If balance too low to trade, skip market scanning and AI entirely
      if (!canTrade(currentPortfolio.balance)) {
        const status = getBankrollStatus(currentPortfolio.balance);
        const hasOpen = currentPortfolio.openOrders.length;
        addActivity(
          hasOpen > 0
            ? `💤 ${status} — Solo resolviendo ${hasOpen} apuesta(s) pendiente(s). Sin escaneo de mercados ni IA.`
            : `💤 ${status} — Sin apuestas pendientes ni saldo para operar.`,
          "Warning"
        );
        setIsAnalyzing(false);
        const waitSecs = hasOpen > 0 ? 120 : 300;
        dynamicIntervalRef.current = waitSecs; // Update ref DIRECTLY (sync)
        setCountdown(waitSecs);
        setDynamicInterval(waitSecs);
        return;
      }

      // Fetch fresh market data (only if we have balance to trade)
      addActivity(`Escaneando mercados de Polymarket...`, "Info");
      const freshMarkets = await fetchAllMarkets(true, 12000, (loaded: number) => {
        // Update UI as pages load
        setMarkets(prev => prev.length < loaded ? Array(loaded).fill(null) as any : prev);
      });
      setMarkets(freshMarkets);
      setStats(prev => ({ ...prev, markets_scanned: prev.markets_scanned + freshMarkets.length }));
      addActivity(`${freshMarkets.length} mercados activos encontrados`, "Info");

      // ── OSINT Research + Kelly Trading ──
      addActivity("🔬 Iniciando Deep Research OSINT...", "Inference");
      setIsAnalyzing(true);

      const smartResult = await runSmartCycle(currentPortfolio, freshMarkets);

      // Update portfolio if bets were placed
      if (smartResult.betsPlaced.length > 0) {
        setPortfolio(smartResult.portfolio);
        updateStatsFromPortfolio(smartResult.portfolio);
      }

      // Push all activities from the cycle
      smartResult.activities.forEach(a => {
        setActivities(prev => [...prev, a].slice(-200));
      });

      // Persist cycle activities to DB
      if (smartResult.activities.length > 0) {
        dbAddActivitiesBatch(smartResult.activities)
          .catch(e => console.error("[App] DB activities batch save failed:", e));
      }

      // Update AI tracking state
      setIsAnalyzing(false);
      setLastKellyResults(smartResult.betsPlaced);
      setMarketsEligible(smartResult.marketsEligible);
      setMarketsAnalyzed(smartResult.marketsAnalyzed);
      // Load full tracker from DB (includes prompt/rawResponse for history)
      loadCostTracker().then(t => setAiCostTracker(t)).catch(e => console.warn('[App] AI tracker reload failed:', e));
      // Update ref DIRECTLY first (synchronous), then state (async render)
      dynamicIntervalRef.current = smartResult.nextScanSeconds;
      setDynamicInterval(smartResult.nextScanSeconds);
      setBankrollStatus(getBankrollStatus(smartResult.portfolio.balance));
      setLastCycleCost(smartResult.aiUsage?.costUsd || 0);
      setCountdown(smartResult.nextScanSeconds);
      setStats(prev => ({ ...prev, signals_generated: prev.signals_generated + smartResult.marketsAnalyzed }));
      
    } catch (e) {
      console.error("Trading cycle error:", e);
      addActivity(`Error en ciclo: ${e}`, "Error");
      setIsAnalyzing(false);
    }
  }, [portfolio, startTime, addActivity, updateStatsFromPortfolio]);

  // Handle portfolio updates from child components
  const handlePortfolioUpdate = useCallback((newPortfolio: Portfolio) => {
    setPortfolio(newPortfolio);
    savePortfolio(newPortfolio);
    updateStatsFromPortfolio(newPortfolio);
  }, [updateStatsFromPortfolio]);

  // Start bot
  const handleStart = useCallback(() => {
    setIsRunning(true);
    const now = new Date();
    setStartTime(now);
    // Persist to DB
    dbSetBotState({ isRunning: true, startTime: now.toISOString() })
      .catch(e => console.error("[App] DB bot state save failed:", e));
    addActivity("🚀 Bot iniciado — Kelly Criterion + Claude AI", "Info");
    dbAddActivity({ timestamp: new Date().toISOString(), message: "🚀 Bot iniciado — Kelly Criterion + Claude AI", entry_type: "Info" })
      .catch(e => console.error("[App] DB activity save failed:", e));
  }, [addActivity]);

  // Stop bot
  const handleStop = useCallback(() => {
    setIsRunning(false);
    // Persist to DB
    dbSetBotState({ isRunning: false, startTime: null })
      .catch(e => console.error("[App] DB bot state save failed:", e));
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    addActivity("⏹️ Bot detenido", "Warning");
    dbAddActivity({ timestamp: new Date().toISOString(), message: "⏹️ Bot detenido", entry_type: "Warning" })
      .catch(e => console.error("[App] DB activity save failed:", e));
  }, [addActivity]);

  // Reset portfolio
  const handleReset = useCallback(() => {
    const bal = config.initial_balance || 100;
    const newPortfolio = resetPortfolio(bal);
    setPortfolio(newPortfolio);
    updateStatsFromPortfolio(newPortfolio);
    setActivities([]);
    cycleRef.current = 0;
    resetCostTracker();
    clearAnalyzedCache(); // Clear throttle + analyzed IDs for fresh start
    setAiCostTracker({ ...defaultAICostTracker });
    setLastKellyResults([]);
    setBankrollStatus("");
    setMarketsEligible(0);
    setMarketsAnalyzed(0);
    addActivity(`🔄 Portfolio reseteado - $${bal.toFixed(2)} | IA costos limpiados`, "Info");
  }, [addActivity, updateStatsFromPortfolio, config.initial_balance]);

  // Keep refs always pointing to latest values
  useEffect(() => { tradingCycleRef.current = runTradingCycle; }, [runTradingCycle]);
  // dynamicIntervalRef is now updated DIRECTLY (synchronously) in tradingCycle — no useEffect needed

  // Auto-resolution poller: every 60s, check server for newly resolved orders
  useEffect(() => {
    const pollResolve = async () => {
      try {
        const result = await dbTriggerResolve();
        if (result.justResolved && result.justResolved.length > 0) {
          console.log(`[AutoResolver] ${result.justResolved.length} orders resolved`);
          // Refresh portfolio from DB
          const freshPortfolio = await loadPortfolioFromDB();
          setPortfolio(freshPortfolio);
          updateStatsFromPortfolio(freshPortfolio);
          // Add resolution activities
          result.justResolved.forEach((o: any) => {
            const pnlStr = o.pnl >= 0 ? `+$${o.pnl.toFixed(2)}` : `-$${Math.abs(o.pnl).toFixed(2)}`;
            addActivity(
              `🔔 AUTO-RESOLVED "${o.marketQuestion?.slice(0, 40)}..." → ${o.status?.toUpperCase()} ${pnlStr}`,
              o.status === "won" ? "Resolved" : "Warning"
            );
          });
        }
      } catch (e) {
        // Silently ignore — server might not be running
      }
    };
    const id = window.setInterval(pollResolve, 300_000); // 5 min (matches per-order cooldown)
    return () => clearInterval(id);
  }, [addActivity, updateStatsFromPortfolio]);

  // Run trading cycle effect — only depends on isRunning
  useEffect(() => {
    if (!isRunning) {
      if (intervalRef.current) { clearTimeout(intervalRef.current); intervalRef.current = null; }
      return;
    }

    let cancelled = false;

    // Self-scheduling: run cycle, then wait dynamicInterval, then repeat
    const scheduleNext = (delaySecs: number) => {
      if (cancelled) return;
      setCountdown(delaySecs);
      console.log(`[Cycle] Next cycle in ${delaySecs}s`);
      intervalRef.current = window.setTimeout(() => {
        if (cancelled) return;
        setCountdown(0); // Clear countdown while cycle runs
        tradingCycleRef.current?.().then(() => {
          const next = dynamicIntervalRef.current;
          if (!cancelled) scheduleNext(next);
        }).catch(() => {
          if (!cancelled) scheduleNext(600); // Retry in 10 min on error
        });
      }, delaySecs * 1000);
    };

    // Run first cycle immediately, then schedule next
    tradingCycleRef.current?.().then(() => {
      const next = dynamicIntervalRef.current;
      if (!cancelled) scheduleNext(next);
    }).catch(() => {
      if (!cancelled) scheduleNext(600);
    });

    return () => {
      cancelled = true;
      if (intervalRef.current) { clearTimeout(intervalRef.current); intervalRef.current = null; }
    };
  }, [isRunning]); // eslint-disable-line react-hooks/exhaustive-deps

  // Countdown timer
  useEffect(() => {
    if (isRunning && countdown > 0) {
      countdownRef.current = window.setInterval(() => {
        setCountdown(prev => Math.max(0, prev - 1));
      }, 1000);
    }
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, [isRunning, countdown > 0]);

  // Live uptime ticker — updates every second while running
  useEffect(() => {
    if (!isRunning || !startTime) return;
    const id = window.setInterval(() => {
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

  // Config save handler
  const handleSaveConfig = useCallback(async (newConfig: BotConfig) => {
    const oldConfig = config;
    setConfig(newConfig);
    setShowSettings(false);
    setMaxExpiry(newConfig.max_expiry_hours);

    // If initial_balance changed, apply to DB + reset portfolio with new bankroll
    if (newConfig.initial_balance !== oldConfig.initial_balance) {
      const newBal = newConfig.initial_balance;
      try {
        await dbSetInitialBalance(newBal);
        const freshPortfolio = await loadPortfolioFromDB();
        setPortfolio(freshPortfolio);
        updateStatsFromPortfolio(freshPortfolio);
        addActivity(`💰 Banca inicial actualizada: $${newBal.toFixed(2)} (reset completo)`, "Info");
      } catch (e) {
        console.error("[App] Failed to update initial balance:", e);
      }
    }

    addActivity(`⚙️ Configuración actualizada (expiry: ${newConfig.max_expiry_hours}h)`, "Info");
  }, [config, addActivity, updateStatsFromPortfolio]);

  return (
    <div className="w-full h-full bg-bot-bg flex flex-col overflow-hidden">
      {/* Header */}
      <Header
        stats={stats}
        isRunning={isRunning}
        isDemoMode={true}
        countdown={countdown}
        onStart={handleStart}
        onStop={handleStop}
        onSettings={() => setShowSettings(true)}
      />

      {/* Navigation Tabs */}
      <div className="px-4 pt-2">
        <div className="flex gap-2 bg-bot-card rounded-lg p-1 border border-bot-border w-fit">
          {[
            { id: "dashboard", label: "📊 Dashboard", icon: "" },
            { id: "markets", label: "🏪 Mercados", icon: "" },
            { id: "orders", label: "📋 Órdenes", icon: "" },
            { id: "ai", label: "🤖 AI Kelly", icon: "" },
            { id: "console", label: isAnalyzing ? "🔬 Analizando..." : `🖥️ Consola ${countdown > 0 ? `(${Math.floor(countdown/60)}:${String(countdown%60).padStart(2,'0')})` : ""}`, icon: "" },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setViewMode(tab.id as ViewMode)}
              className={`px-4 py-2 rounded-md text-sm font-medium transition-all
                ${viewMode === tab.id
                  ? "bg-bot-green text-black"
                  : "text-gray-400 hover:text-white hover:bg-white/5"
                }`}
            >
              {tab.label}
            </button>
          ))}
          
          {/* Reset Button */}
          <button
            onClick={handleReset}
            className="px-4 py-2 rounded-md text-sm font-medium text-red-400 
                     hover:text-red-300 hover:bg-red-500/10 transition-all ml-2"
          >
            🔄 Reset
          </button>
        </div>
      </div>

      {/* Top Cards */}
      <TopCards stats={stats} walletInfo={walletInfo} />

      {/* Main Content */}
      <div className="flex-1 flex gap-3 px-4 pb-3 min-h-0 overflow-hidden">
        {viewMode === "dashboard" && (
          <>
            {/* Chart */}
            <div className="flex-1 min-w-0">
              <BalanceChart history={balanceHistory} />
            </div>
            {/* Activity Log */}
            <div className="w-[420px] flex-shrink-0">
              <ActivityLog activities={activities} />
            </div>
          </>
        )}

        {viewMode === "markets" && (
          <div className="flex-1 min-w-0 overflow-auto">
            <MarketsPanel
              portfolio={portfolio}
              onPortfolioUpdate={handlePortfolioUpdate}
              onActivity={addActivity}
            />
          </div>
        )}

        {viewMode === "orders" && (
          <div className="flex-1 min-w-0 overflow-auto">
            <OrdersPanel
              portfolio={portfolio}
              onPortfolioUpdate={handlePortfolioUpdate}
              onActivity={addActivity}
            />
          </div>
        )}

        {viewMode === "ai" && (
          <div className="flex-1 min-w-0 overflow-auto">
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
          <div className="flex-1 min-w-0 overflow-auto">
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
