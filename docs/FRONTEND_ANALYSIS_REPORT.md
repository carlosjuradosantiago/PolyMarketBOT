# 🔍 ANÁLISIS COMPLETO DEL FRONTEND — Refactoring Report

> **Generado**: Junio 2025
> **Propósito**: Inventario exhaustivo de cada archivo y función del frontend para el proyecto de refactoring masivo.
> **Alcance**: 15 archivos en `src/` — 7,936 líneas totales

---

## 📊 Resumen Ejecutivo

| Métrica | Valor |
|---------|-------|
| Archivos analizados | 15 |
| Líneas totales | ~7,936 |
| Funciones catalogadas | ~120+ |
| Lógica backend en frontend | **~70%** del código |
| Usos de localStorage | **6 keys** (3 en smartTrader, 1 en aiService, 2 en clobAuth) |
| Llamadas API directas al browser | **~15 endpoints** |
| Archivo más grande | smartTrader.ts (1,145 líneas) |
| Archivo que debería ser 100% backend | smartTrader.ts, claudeAI.ts, paperTrading.ts |

---

## 📁 ARCHIVO 1: `src/App.tsx` (738 líneas)

### Propósito
Componente React principal. Orquesta toda la UI y el ciclo de trading completo.

### Funciones

| # | Función | Líneas | Clasificación | Descripción |
|---|---------|--------|---------------|-------------|
| 1 | `App()` | ~700 | **Compartido** | Componente principal — mezcla UI con lógica de negocio |
| 2 | `loadWalletInfo()` | ~15 | Frontend | Fetch `/api/wallet` y actualiza estado |
| 3 | `loadPaperPrices()` | ~20 | **Backend** | Recorre órdenes abiertas y llama a Gamma API por precios |
| 4 | `updateStatsFromPortfolio()` | ~30 | **Backend** | Calcula estadísticas (winRate, avgBet, bestTrade, etc.) desde portfolio |
| 5 | `addActivity()` | ~5 | **Compartido** | Agrega entrada al log y persiste en DB |
| 6 | `runTradingCycle()` | ~80 | **100% Backend** | Orquesta: loadPortfolio → fetchAllMarkets → runSmartCycle → dbSaveCycleLog |
| 7 | `handlePortfolioUpdate()` | ~15 | **Backend** | Recarga portfolio de DB y actualiza stats |
| 8 | `handleStart()` | ~30 | **Compartido** | Inicia bot: persiste estado en DB + activa timer |
| 9 | `handleStop()` | ~10 | **Compartido** | Detiene bot: persiste estado en DB + limpia timer |
| 10 | `handleForceRun()` | ~5 | Frontend | Dispara ciclo manual |
| 11 | `handleReset()` | ~15 | **Backend** | Reset completo: dbResetPortfolio + limpiar estados |
| 12 | `handleSaveConfig()` | ~30 | **Compartido** | Guarda config en DB, aplica en memoria |
| 13 | `secondsUntilNext6am()` | ~15 | **100% Backend** | Calcula segundos hasta las 6am UTC-5 (scheduling) |
| 14 | *useEffect: bot scheduler* | ~40 | **100% Backend** | setInterval con countdowns, uptime, scheduling diario a las 6am |
| 15 | *useEffect: auto-resolver* | ~20 | **100% Backend** | setInterval cada 5min para resolver órdenes expiradas |
| 16 | *useEffect: DB boot* | ~30 | **Compartido** | Carga portfolio, config, estado del bot al montar |

### localStorage
- `clob_creds_version` → Limpieza one-time de credenciales obsoletas

### Llamadas API Directas
- `/api/wallet` (wallet info)
- Indirectas via `fetchAllMarkets()`, `loadPortfolioFromDB()`, `runSmartCycle()`

### Estado que Pertenece al Backend
- Timer de scheduling (6am UTC-5 diario)
- Countdown/uptime
- Ciclo de trading completo (`runTradingCycle`)
- Auto-resolución de órdenes cada 5min
- Cálculo de estadísticas

---

## 📁 ARCHIVO 2: `src/services/smartTrader.ts` (1,145 líneas)

### Propósito
Motor de trading central. Filtra mercados, orquesta análisis IA, coloca apuestas.

### Funciones

| # | Función | Líneas | Clasificación | Descripción |
|---|---------|--------|---------------|-------------|
| 1 | `setMaxExpiry()` | ~3 | Config | Setter para maxExpiry configurable |
| 2 | `clearAnalyzedCache()` | ~3 | **Backend** | Limpia cache de mercados ya analizados |
| 3 | `runSmartCycle()` | ~50 | **100% Backend** | Entry point: concurrency lock, throttle check, delega a inner |
| 4 | `_runSmartCycleInner()` | ~350 | **100% Backend** | Core loop: buildPool → batches → AI analysis → Kelly → createOrder |
| 5 | `buildShortTermPool()` | ~250 | **100% Backend** | Filtrado progresivo de mercados (liquidity, volume, junk, dedup, diversify) |
| 6 | `deduplicateCorrelatedMarkets()` | ~60 | **100% Backend** | Cluster dedup: agrupa mercados similares, mantiene el de mayor volumen |
| 7 | `diversifyPool()` | ~40 | **100% Backend** | Round-robin por categoría para diversificar el pool |
| 8 | `classifyMarketCategory()` | ~30 | **Backend** | Clasifica mercado por categoría usando keywords |
| 9 | `hydrateCycleLogs()` | ~5 | **Backend** | Carga cycle logs desde DB |
| 10 | `getCycleLogs()` | ~3 | Frontend | Getter para logs del ciclo actual |
| 11 | `clearCycleLogs()` | ~3 | Frontend | Limpia logs del ciclo |
| 12 | `_loadAnalyzedMap()` | ~10 | **Backend** | Carga mapa de mercados analizados desde localStorage |
| 13 | `_saveAnalyzedMap()` | ~5 | **Backend** | Persiste mapa de mercados analizados en localStorage |
| 14 | `_loadThrottleTimestamp()` | ~5 | **Backend** | Carga timestamp de última llamada a Claude desde localStorage |
| 15 | `_saveThrottleTimestamp()` | ~5 | **Backend** | Persiste throttle timestamp |
| 16 | `_acquireCycleLock()` | ~10 | **Backend** | Lock de concurrencia con TTL de 3min en localStorage |
| 17 | `_releaseCycleLock()` | ~3 | **Backend** | Libera lock de concurrencia |

### localStorage (¡CRÍTICO!)
- `_smartTrader_lastClaudeCall` → Timestamp de throttle anti-spam (20h min entre llamadas)
- `_smartTrader_analyzedMap` → JSON map de mercados analizados recientemente (TTL per-market)
- `_smartTrader_cycleLock` → Lock de concurrencia con expiración 3min

### Llamadas API
- Indirectas via `analyzeMarketsWithAI()` (→ proxy Edge Functions)
- Indirectas via `createPaperOrder()` (→ Supabase DB)

### Estado que Pertenece al Backend
- **TODO** este archivo es lógica de backend pura:
  - Filtrado de pool de mercados
  - Throttle y rate limiting
  - Lock de concurrencia
  - Batch management
  - Orquestación de análisis IA
  - Colocación de apuestas via Kelly

### Constantes Importantes
```
SCAN_INTERVAL_SECS = 86400 (24h)
MIN_CLAUDE_INTERVAL_MS = 20 horas
MAX_ANALYZED_PER_CYCLE = 20
MAX_BATCHES_PER_CYCLE = 5
BATCH_SIZE = 4
MIN_POOL_TARGET = 15
```

---

## 📁 ARCHIVO 3: `src/services/paperTrading.ts` (556 líneas)

### Propósito
Gestión de órdenes paper: creación, cancelación, resolución, estadísticas.

### Funciones

| # | Función | Líneas | Clasificación | Descripción |
|---|---------|--------|---------------|-------------|
| 1 | `loadPortfolioFromDB()` | ~10 | **Backend** | Wrapper sobre `dbLoadPortfolio()` |
| 2 | `loadPortfolio()` | ~20 | Deprecated | Legacy: carga de localStorage (ya no se usa) |
| 3 | `savePortfolio()` | ~5 | Deprecated | Legacy: guarda en localStorage |
| 4 | `resetPortfolio()` | ~10 | **Backend** | Delega a `dbResetPortfolio()` |
| 5 | `generateOrderId()` | ~3 | **Backend** | Genera ID `paper_${timestamp}_${random}` |
| 6 | `createPaperOrder()` | ~80 | **100% Backend** | Crea orden: valida balance, construye PaperOrder, llama a dbCreateOrder |
| 7 | `cancelPaperOrder()` | ~20 | **100% Backend** | Cancela orden y reembolsa via `dbCancelOrder` |
| 8 | `checkAndResolveOrders()` | ~100 | **100% Backend** | Smart resolution: cooldown 5min, fetch market, determinar ganador, P&L |
| 9 | `findEdge()` | ~40 | Deprecated | Legacy random strategy (no se usa) |
| 10 | `autoPlaceOrders()` | ~60 | Deprecated | Legacy auto-trading (no se usa) |
| 11 | `calculateStats()` | ~40 | **Backend** | Computa stats desde portfolio (totalPnl, winRate, avgBet, etc.) |
| 12 | `getOrderHistory()` | ~10 | Frontend | Devuelve historial + órdenes abiertas combinados |
| 13 | `getBalanceHistory()` | ~30 | **Backend** | Reconstruye historial de balance desde órdenes |

### localStorage
- Ninguno (migrado a DB)

### Llamadas API
- `fetchMarketById()` via polymarket.ts (para resolución)

### Estado que Pertenece al Backend
- Creación y resolución de órdenes
- Cálculo de P&L
- Gestión de balance
- Estadísticas del portfolio

---

## 📁 ARCHIVO 4: `src/services/polymarket.ts` (867 líneas)

### Propósito
Integración con Polymarket API: fetch, parsing, filtrado de mercados.

### Funciones

| # | Función | Líneas | Clasificación | Descripción |
|---|---------|--------|---------------|-------------|
| 1 | `categorizeMarket()` | ~60 | **Backend** | Categoriza mercado desde metadata API + keyword fallback |
| 2 | `parseMarket()` | ~30 | **Backend** | Transforma raw API response → PolymarketMarket tipo |
| 3 | `fetchEvents()` | ~20 | **Backend** | GET `/api/gamma/events` con params |
| 4 | `fetchMarkets()` | ~20 | **Backend** | GET `/api/gamma/markets` con params |
| 5 | `fetchAllMarkets()` | ~80 | **100% Backend** | Paginación completa con cache 4min, retry, timeout 12s |
| 6 | `fetchMarketById()` | ~20 | **Backend** | GET `/api/gamma/markets/{id}` |
| 7 | `fetchMarketPrice()` | ~15 | **Backend** | GET `/api/clob/price` |
| 8 | `fetchOrderbook()` | ~15 | Shared | GET `/api/clob/book` (se puede usar en UI) |
| 9 | `fetchWalletBalance()` | ~40 | **⚠️ Backend** | Llama DIRECTAMENTE a Polygon RPC desde el browser |
| 10 | `filterMarketsByTimeframe()` | ~30 | **Backend** | Filtra por ventana temporal |
| 11 | `filterMarketsByCategory()` | ~10 | **Backend** | Filtra por categoría |
| 12 | `filterMarkets()` | ~100 | **Compartido** | Filtro combinado complejo (usado por UI y bot) |
| 13 | `isMarketResolved()` | ~20 | **Backend** | Verifica si mercado está resuelto (closed, prices ≥ 0.95) |
| 14 | `getWinningOutcome()` | ~20 | **Backend** | Determina outcome ganador |
| 15 | `formatPrice()` | ~5 | Frontend | Formatea precio como porcentaje |
| 16 | `formatVolume()` | ~5 | Frontend | Formatea volumen (K, M) |
| 17 | `formatTimeRemaining()` | ~20 | Frontend | Formatea tiempo restante |
| 18 | `fetchPaperOrderPrices()` | ~30 | **Backend** | Fetch precios actuales para órdenes paper |

### localStorage
- Ninguno

### Llamadas API Directas
- `/api/gamma/markets` (paginado)
- `/api/gamma/events`
- `/api/gamma/markets/{id}`
- `/api/clob/price`
- `/api/clob/book`
- **`https://polygon-rpc.com` ← DIRECTA desde browser** (en fetchWalletBalance)

### Cache en Memoria
- `_cachedMarkets` con TTL de 4 minutos

---

## 📁 ARCHIVO 5: `src/services/claudeAI.ts` (729 líneas)

### Propósito
Integración con Claude AI: prompt OSINT, llamada API, parsing, tracking de costos.

### Funciones

| # | Función | Líneas | Clasificación | Descripción |
|---|---------|--------|---------------|-------------|
| 1 | `loadCostTracker()` | ~5 | **Backend** | Delega a `dbLoadCostTracker()` |
| 2 | `resetCostTracker()` | ~5 | **Backend** | Delega a `dbResetAICosts()` |
| 3 | `calculateTokenCost()` | ~10 | **Backend** | Cálculo de costo basado en modelo y tokens |
| 4 | `buildOSINTPrompt()` | ~400 | **100% Backend** | Prompt masivo de ~400 líneas con instrucciones OSINT |
| 5 | `extractJSON()` | ~80 | **Backend** | Parser robusto de JSON con 4 estrategias de extracción |
| 6 | `analyzeMarketsWithClaude()` | ~150 | **100% Backend** | Llamada API a proxy Claude, retry, pReal auto-fix, side-consistency |
| 7 | `estimateAnalysisCost()` | ~10 | **Backend** | Estima costo antes de llamar a la API |
| 8 | `formatCost()` | ~5 | Frontend | Formatea costo como string |

### localStorage
- Ninguno (migrado a DB; constante `COST_TRACKER_KEY` es legacy)

### Llamadas API
- `${SUPABASE_URL}/functions/v1/claude-proxy` → Proxy que reenvía a Anthropic API

### Estado que Pertenece al Backend
- **TODO** — completo prompt engineering, response parsing, auto-corrección, tracking de costos

### Constantes
```
MODEL_PRICING: 6 modelos Claude con precios input/output
CLAUDE_MODELS: lista de modelos para selector UI
```

---

## 📁 ARCHIVO 6: `src/services/aiService.ts` (561 líneas)

### Propósito
Servicio IA unificado. Routea peticiones al proveedor correcto, maneja parsing multi-formato.

### Funciones

| # | Función | Líneas | Clasificación | Descripción |
|---|---------|--------|---------------|-------------|
| 1 | `analyzeMarketsWithAI()` | ~20 | **100% Backend** | Entry point: rate limit → dispatch por proveedor |
| 2 | `analyzeWithProvider()` | ~80 | **100% Backend** | Adapter genérico: buildPrompt → fetch proxy → parse |
| 3 | `enforceRateLimit()` | ~20 | **100% Backend** | Rate limiter con min interval (Gemini 250k TPM) |
| 4 | `buildRequestBody()` | ~15 | **Backend** | Switch por proveedor |
| 5 | `buildGeminiRequest()` | ~15 | **Backend** | Body específico para Gemini API |
| 6 | `buildOpenAIRequest()` | ~15 | **Backend** | Body específico para OpenAI API |
| 7 | `buildXAIRequest()` | ~10 | **Backend** | Body específico para xAI/Grok API |
| 8 | `buildDeepSeekRequest()` | ~10 | **Backend** | Body específico para DeepSeek API |
| 9 | `parseProviderResponse()` | ~10 | **Backend** | Switch por proveedor para parsing |
| 10 | `parseGeminiResponse()` | ~15 | **Backend** | Parsea respuesta Gemini (candidates, grounding) |
| 11 | `parseOpenAIResponse()` | ~10 | **Backend** | Parsea respuesta OpenAI/xAI/DeepSeek |
| 12 | `parseRecommendation()` | ~50 | **Backend** | Parsea recomendación individual con auto-fix pReal/side |
| 13 | `testApiKey()` | ~80 | **Compartido** | Test mínimo de API key (petición "hi" via proxy) |
| 14 | `_loadProviderCallTimes()` | ~5 | **Backend** | Carga timestamps de rate limit desde localStorage |
| 15 | `_persistProviderCallTime()` | ~5 | **Backend** | Persiste timestamps de rate limit |

### localStorage
- `_aiService_providerCallTimes` → Timestamps de última llamada por proveedor (rate limiting)

### Llamadas API
- `${SUPABASE_URL}/functions/v1/claude-proxy`
- `${SUPABASE_URL}/functions/v1/gemini-proxy`
- `${SUPABASE_URL}/functions/v1/openai-proxy`
- `${SUPABASE_URL}/functions/v1/xai-proxy`
- `${SUPABASE_URL}/functions/v1/deepseek-proxy`

---

## 📁 ARCHIVO 7: `src/services/aiProviders.ts` (~210 líneas)

### Propósito
Registro central de proveedores IA. **Fuente única de verdad** para modelos, precios, free tiers, URLs.

### Funciones

| # | Función | Líneas | Clasificación | Descripción |
|---|---------|--------|---------------|-------------|
| 1 | `getProvider()` | ~3 | Compartido | Obtiene definición de proveedor por ID |
| 2 | `getModel()` | ~3 | Compartido | Obtiene definición de modelo por proveedor + ID |
| 3 | `getAllModels()` | ~3 | Frontend | Retorna todos los modelos (para selectores UI) |
| 4 | `calculateModelCost()` | ~5 | **Backend** | Calcula costo de tokens para un modelo |
| 5 | `estimateCycleCost()` | ~5 | Compartido | Estima costo por ciclo (basado en promedios reales) |
| 6 | `estimateMonthlyCost()` | ~3 | Frontend | Estima costo mensual (cycleCost × 30) |
| 7 | `hasFreeTier()` | ~3 | Frontend | Verifica si modelo tiene free tier |
| 8 | `getProxyUrl()` | ~10 | **Backend** | Construye URL del proxy por proveedor |
| 9 | `getDirectApiUrl()` | ~10 | **Backend** | URL directa de la API (para Edge Functions) |
| 10 | `getApiHeaders()` | ~15 | **Backend** | Headers de autenticación por proveedor |

### localStorage
- Ninguno

### Datos Estáticos
- `AI_PROVIDERS[]` — 5 proveedores, 19 modelos totales, con pricing y free tier info
- `AVG_INPUT_TOKENS_PER_CYCLE = 1,074,344`
- `AVG_OUTPUT_TOKENS_PER_CYCLE = 6,342`

---

## 📁 ARCHIVO 8: `src/services/kellyStrategy.ts` (~290 líneas)

### Propósito
Kelly Criterion: cálculo de tamaño óptimo de apuesta con factoring de costos AI.

### Funciones

| # | Función | Líneas | Clasificación | Descripción |
|---|---------|--------|---------------|-------------|
| 1 | `rawKellyFraction()` | ~10 | **100% Backend** | Kelly puro: f* = (pReal - pMarket) / (1 - pMarket) |
| 2 | `calculateKellyBet()` | ~120 | **100% Backend** | Kelly completo: lottery zone, narrow bin, cost factoring, caps |
| 3 | `canTrade()` | ~3 | **Backend** | ¿Bankroll ≥ $1 (mínimo Polymarket)? |
| 4 | `getBankrollStatus()` | ~10 | Frontend | String de estado del bankroll para UI |
| 5 | `calculateScanInterval()` | ~20 | **Backend** | Intervalo dinámico basado en bankroll y actividad |
| 6 | `shouldAnalyze()` | ~10 | **Backend** | ¿Vale la pena gastar en IA dado el bankroll? |

### localStorage
- Ninguno

### Constantes Exportadas
```
KELLY_FRACTION = 0.50 (Half-Kelly)
MAX_BET_FRACTION = 0.10 (nunca > 10% bankroll)
MIN_BET_USD = 1.00 (mínimo Polymarket)
MIN_EDGE_AFTER_COSTS = 0.06 (6% edge mínimo neto)
MIN_CONFIDENCE = 60
MIN_MARKET_PRICE = 0.02 / MAX_MARKET_PRICE = 0.98
LOTTERY_PRICE_THRESHOLD = 0.20
LOTTERY_MIN_CONFIDENCE = 70
```

---

## 📁 ARCHIVO 9: `src/services/database.ts` (~340 líneas) ⚠️ LEGACY

### Propósito
Base de datos **IndexedDB** local. **LEGACY** — reemplazado por `db.ts` (Supabase directo).

### Funciones

| # | Función | Líneas | Clasificación | Descripción |
|---|---------|--------|---------------|-------------|
| 1 | `initDatabase()` | ~40 | Deprecated | Crea schema IndexedDB |
| 2 | `saveOrder()` | ~10 | Deprecated | CRUD: guardar orden |
| 3 | `getOrder()` | ~10 | Deprecated | CRUD: obtener orden por ID |
| 4 | `getAllOrders()` | ~10 | Deprecated | CRUD: obtener todas |
| 5 | `getOrdersByStatus()` | ~10 | Deprecated | CRUD: filtrar por status |
| 6 | `deleteOrder()` | ~10 | Deprecated | CRUD: eliminar |
| 7 | `clearAllOrders()` | ~10 | Deprecated | Limpiar store |
| 8 | `saveBalanceSnapshot()` | ~10 | Deprecated | Balance snapshots |
| 9 | `getBalanceSnapshots()` | ~10 | Deprecated | |
| 10 | `clearBalanceSnapshots()` | ~10 | Deprecated | |
| 11 | `saveConfig()` | ~10 | Deprecated | Config key-value |
| 12 | `getConfig()` | ~10 | Deprecated | |
| 13 | `saveActivity()` | ~10 | Deprecated | Activity log |
| 14 | `getActivityLog()` | ~10 | Deprecated | |
| 15 | `clearActivityLog()` | ~10 | Deprecated | |
| 16 | `saveTradeSummary()` | ~20 | Deprecated | Resúmenes diarios |
| 17 | `getTradeSummaries()` | ~10 | Deprecated | |
| 18 | `resetAllData()` | ~5 | Deprecated | Limpia todo |
| 19 | `exportAllData()` | ~15 | Deprecated | Export para debugging |

### ⚠️ Recomendación
**ELIMINAR ESTE ARCHIVO.** Ya no se usa — toda la persistencia real está en `db.ts` (Supabase).

---

## 📁 ARCHIVO 10: `src/services/db.ts` (920 líneas)

### Propósito
**Cliente principal de base de datos** — Supabase directo (PostgreSQL). Reemplaza database.ts.

### Funciones

| # | Función | Líneas | Clasificación | Descripción |
|---|---------|--------|---------------|-------------|
| 1 | `dbLoadPortfolio()` | ~60 | **Backend** | Carga portfolio + órdenes + auto-healing de balance |
| 2 | `dbSavePortfolio()` | ~10 | **Backend** | Guarda balance y total_pnl |
| 3 | `dbResetPortfolio()` | ~20 | **Backend** | Reset completo: portfolio + orders + activities + cycle_logs |
| 4 | `dbSetInitialBalance()` | ~10 | **Backend** | Setter de balance inicial |
| 5 | `dbSaveBotConfig()` | ~40 | **Backend** | Upsert config en bot_kv con verify + REST fallback |
| 6 | `_dbSaveConfigREST()` | ~20 | **Backend** | Fallback REST directo para config |
| 7 | `dbLoadBotConfig()` | ~30 | **Backend** | Carga config con supabase-js + REST fallback |
| 8 | `dbCreateOrder()` | ~25 | **Backend** | Insert orden + atomic `deduct_balance` RPC |
| 9 | `dbUpdateOrder()` | ~15 | **Backend** | Update parcial de orden |
| 10 | `dbCancelOrder()` | ~10 | **Backend** | Cancela + atomic `add_balance` refund |
| 11 | `dbAddBalance()` | ~5 | **Backend** | RPC atomic para sumar balance |
| 12 | `dbGetActivities()` | ~10 | **Backend** | Lee activities (reverse) |
| 13 | `dbAddActivity()` | ~10 | **Backend** | Inserta + cleanup automático |
| 14 | `dbAddActivitiesBatch()` | ~10 | **Backend** | Batch insert de activities |
| 15 | `dbLoadCostTracker()` | ~30 | **Backend** | Carga tracker + historial (sin prompt/rawResponse) |
| 16 | `dbAddAICost()` | ~25 | **Backend** | Update aggregate + insert history row |
| 17 | `dbResetAICosts()` | ~5 | **Backend** | Reset tracker + limpiar historial |
| 18 | `dbGetAICostDetail()` | ~30 | **Backend** | Fetch prompt + rawResponse on-demand |
| 19 | `dbGetLastCycleTimestamp()` | ~10 | **Backend** | Timestamp del último ciclo con cost > 0 |
| 20 | `dbGetCycleLogs()` | ~15 | **Backend** | Carga cycle debug logs |
| 21 | `dbSaveCycleLog()` | ~20 | **Backend** | Guarda log + cleanup |
| 22 | `dbGetBotState()` | ~15 | **Backend** | Lee estado del bot (isRunning, cycleCount, etc.) |
| 23 | `dbSetBotState()` | ~10 | **Backend** | Actualiza estado del bot |
| 24 | `dbGetStats()` | ~30 | **Backend** | Estadísticas computadas desde DB |
| 25 | `dbSyncOrders()` | ~20 | **Backend** | Bulk import/upsert de órdenes |
| 26 | `dbTriggerResolve()` | ~80 | **100% Backend** | Auto-resolver: fetch markets → determine winner → update balance |
| 27 | `deserializeOrder()` | ~25 | Helper | DB row → PaperOrder |
| 28 | `deserializeCycleLog()` | ~25 | Helper | DB row → CycleDebugLog |
| 29 | `fetchMarketForResolution()` | ~10 | **Backend** | Fetch market desde Gamma para resolución |
| 30 | `isMarketOfficiallyResolved()` | ~15 | **Backend** | ¿Market cerrado con precio ≥ 0.95? |
| 31 | `getWinningOutcomeIndex()` | ~15 | **Backend** | Determina outcome ganador del market |

### localStorage
- Ninguno

### Llamadas API
- Supabase REST (via `@supabase/supabase-js`)
- `/api/gamma/markets/{id}` (para resolución)

### Nota Importante
Este archivo habla directamente con Supabase usando la **public key** (`VITE_SUPABASE_KEY`). Esto significa que **toda la seguridad depende de las Row Level Security (RLS) policies** de Supabase. Las RPC functions (`deduct_balance`, `add_balance`) usan `SECURITY DEFINER` para operaciones atómicas.

---

## 📁 ARCHIVO 11: `src/services/wallet.ts` (~165 líneas)

### Propósito
Servicio de wallet: derivación de dirección, fetch de balances on-chain.

### Funciones

| # | Función | Líneas | Clasificación | Descripción |
|---|---------|--------|---------------|-------------|
| 1 | `deriveAddress()` | ~5 | **Backend** | Private key → Ethereum address (ethers.js) |
| 2 | `getProvider()` | ~5 | **Backend** | Crea JsonRpcProvider para Polygon |
| 3 | `fetchBalance()` | ~30 | **⚠️ Backend** | Llama directamente a Polygon RPCs desde browser |
| 4 | `getWalletInfo()` | ~20 | **Backend** | Compone info completa: address + balance + Polymarket balance |
| 5 | `fetchPolymarketBalanceSafe()` | ~15 | **Backend** | Wrapper safe para fetch Polymarket CLOB balance |
| 6 | `formatAddress()` | ~3 | Frontend | Formatea `0x1234...abcd` |

### localStorage
- Ninguno (pero usa `clobAuth.ts` que sí tiene)

### Llamadas API Directas ⚠️
- **`https://polygon-bor-rpc.publicnode.com`** — MATIC balance
- **`https://polygon-pokt.nodies.app`** — Fallback RPC
- **`https://1rpc.io/matic`** — Fallback RPC
- CLOB proxy via `clobAuth.ts`

### Problema de Seguridad
`deriveAddress()` recibe **private key en el browser**. Toda la lógica de wallet debería estar en el backend.

---

## 📁 ARCHIVO 12: `src/services/clobAuth.ts` (357 líneas)

### Propósito
Autenticación con Polymarket CLOB API. L1 (EIP-712) para derivar API keys, L2 (HMAC-SHA256) para trading.

### Funciones

| # | Función | Líneas | Clasificación | Descripción |
|---|---------|--------|---------------|-------------|
| 1 | `createL1Headers()` | ~20 | **⚠️ Backend** | Firma EIP-712 con private key en browser |
| 2 | `createL2Headers()` | ~25 | **⚠️ Backend** | HMAC-SHA256 con secret en browser |
| 3 | `b64Decode()` | ~5 | Helper | Base64 → bytes |
| 4 | `b64Encode()` | ~5 | Helper | Bytes → base64 URL-safe |
| 5 | `loadCachedCreds()` | ~10 | **Backend** | Lee credenciales cacheadas de localStorage |
| 6 | `cacheCreds()` | ~3 | **Backend** | Guarda credenciales en localStorage |
| 7 | `clearCachedCreds()` | ~3 | **Backend** | Limpia credenciales |
| 8 | `getOrDeriveApiCredentials()` | ~50 | **⚠️ Backend** | Flujo: cache → derive → create new API key |
| 9 | `extractCreds()` | ~10 | Helper | Parse de respuesta de API |
| 10 | `fetchPolymarketBalance()` | ~30 | **⚠️ Backend** | Fetch balance con sig_type 0, 1, 2 |
| 11 | `tryFetchBalance()` | ~20 | **Backend** | Intento individual de fetch balance |
| 12 | `parseBalanceResponse()` | ~10 | Helper | Parse de USDC balance |

### localStorage ⚠️ SEGURIDAD
- `polymarket_api_creds` → **API key, secret, passphrase** almacenados en localStorage del browser

### Llamadas API
- `/api/clob/auth/derive-api-key` (L1 auth)
- `/api/clob/auth/api-key` (L1 auth, create)
- `/api/clob/balance-allowance` (L2 auth)

### ⚠️ Problema Crítico de Seguridad
Private keys y API secrets se manejan directamente en el browser. Toda la autenticación CLOB debería ser server-side.

---

## 📁 ARCHIVO 13: `src/services/marketConstants.ts` (~160 líneas)

### Propósito
Constantes compartidas de filtrado de mercados. **Fuente única de verdad** para junk patterns, thresholds.

### Funciones

| # | Función | Líneas | Clasificación | Descripción |
|---|---------|--------|---------------|-------------|
| 1 | `computeMinLiquidity()` | ~5 | **Backend** | Liquidez mínima dinámica basada en bankroll |
| 2 | `estimateSpread()` | ~10 | **Backend** | Estimación de spread desde liquidez |
| 3 | `computeClusterKey()` | ~10 | **Backend** | Cluster key para dedup (remueve números) |
| 4 | `computeBroadClusterKey()` | ~15 | **Backend** | Cluster broad key (remueve todo excepto tema) |
| 5 | `countUniqueClusters()` | ~10 | Compartido | Cuenta clusters únicos (usado por UI para mostrar N real) |

### Datos Exportados
- `JUNK_PATTERNS[]` — 30+ string patterns para filtrar ruido
- `JUNK_REGEXES[]` — Regex patterns complejos
- `WEATHER_RE` — Regex para detección de mercados clima
- Thresholds de liquidez, volumen, spread, precio

---

## 📁 ARCHIVO 14: `src/types/index.ts` (414 líneas)

### Propósito
Definiciones TypeScript centrales. Tipos, interfaces, defaults.

### Tipos Exportados

| # | Tipo | Clasificación | Descripción |
|---|------|---------------|-------------|
| 1 | `BotStats` | Compartido | Estadísticas del bot (30+ campos) |
| 2 | `ActivityEntry` | Compartido | Entrada de log de actividad |
| 3 | `ActivityType` | Compartido | Union type: Info, Edge, Order, etc. |
| 4 | `BalancePoint` | Frontend | Punto para gráfico de balance |
| 5 | `PolymarketEvent` | Compartido | Evento con sub-markets |
| 6 | `PolymarketMarket` | Compartido | Market individual |
| 7 | `TimeframeFilter` | Frontend | 1h, 4h, 8h, 1d, etc. |
| 8 | `CategoryFilter` | Compartido | all, politics, sports, etc. |
| 9 | `MarketFilters` | Compartido | 15+ filtros combinables |
| 10 | `PaperOrder` | Compartido | Orden paper completa con aiReasoning |
| 11 | `Portfolio` | Compartido | Balance + órdenes abiertas/cerradas |
| 12 | `BotConfig` | Compartido | Configuración completa (AI, trading, keys) |
| 13 | `MarketAnalysis` | Compartido | Resultado de análisis IA por market |
| 14 | `AIUsage` | Compartido | Uso de tokens y costo por llamada |
| 15 | `AICostTracker` | Compartido | Acumulador de costos IA |
| 16 | `KellyResult` | Compartido | Resultado de Kelly con bet sizing |
| 17 | `SmartCycleResult` | Compartido | Resultado completo de un ciclo |

### Funciones

| # | Función | Clasificación | Descripción |
|---|---------|---------------|-------------|
| 1 | `migrateBotConfig()` | **Backend** | Migra config vieja (claude-only) a multi-provider |

### Defaults Exportados
- `defaultPortfolio`, `defaultConfig`, `defaultStats`, `defaultFilters`, `defaultAICostTracker`

---

## 📁 ARCHIVO 15: `src/utils/format.ts` (~55 líneas)

### Propósito
Utilidades de formato para UI.

### Funciones

| # | Función | Clasificación | Descripción |
|---|---------|---------------|-------------|
| 1 | `formatCurrency()` | Frontend | `$1.23K` o `$1.23` |
| 2 | `formatPnl()` | Frontend | `+$12.34` o `-$5.67` |
| 3 | `formatPercent()` | Frontend | `45.5%` |
| 4 | `formatNumber()` | Frontend | `1.2M` o `3.5K` |
| 5 | `getActivityColor()` | Frontend | Tailwind color class por tipo de actividad |

### localStorage
- Ninguno

### Clasificación: **100% Frontend** ✅

---

## 🔴 HALLAZGOS CRÍTICOS

### 1. Lógica de Backend Ejecutándose en el Browser

| Archivo | Líneas | % Backend | Gravedad |
|---------|--------|-----------|----------|
| smartTrader.ts | 1,145 | **~95%** | 🔴 Crítico |
| claudeAI.ts | 729 | **~90%** | 🔴 Crítico |
| paperTrading.ts | 556 | **~80%** | 🔴 Crítico |
| polymarket.ts | 867 | **~70%** | 🟡 Alto |
| db.ts | 920 | **~100%** | 🟡 Alto (pero es el bridge a Supabase) |
| aiService.ts | 561 | **~90%** | 🔴 Crítico |
| kellyStrategy.ts | 290 | **~85%** | 🔴 Crítico |
| clobAuth.ts | 357 | **~95%** | 🔴 **SEGURIDAD** |
| wallet.ts | 165 | **~80%** | 🔴 **SEGURIDAD** |

### 2. Uso de localStorage (Debería Estar en DB)

| Key | Archivo | Uso | Riesgo |
|-----|---------|-----|--------|
| `_smartTrader_lastClaudeCall` | smartTrader.ts | Throttle 20h entre llamadas IA | Se pierde al limpiar browser |
| `_smartTrader_analyzedMap` | smartTrader.ts | Cache de mercados ya analizados | Datos obsoletos |
| `_smartTrader_cycleLock` | smartTrader.ts | Lock de concurrencia 3min | Race conditions si >1 tab |
| `_aiService_providerCallTimes` | aiService.ts | Rate limiter por proveedor | Se pierde al limpiar browser |
| `polymarket_api_creds` | clobAuth.ts | **API key + secret + passphrase** | 🔴 SEGURIDAD |
| `clob_creds_version` | App.tsx | One-time migration flag | Menor |

### 3. Llamadas API Directas desde Browser

| Endpoint | Archivo | Problema |
|----------|---------|----------|
| `https://polygon-bor-rpc.publicnode.com` | wallet.ts | Balance on-chain directo |
| `https://polygon-pokt.nodies.app` | wallet.ts | RPC fallback |
| `https://1rpc.io/matic` | wallet.ts | RPC fallback |
| `https://polygon-rpc.com` | polymarket.ts | `fetchWalletBalance()` legacy |
| Supabase REST (vía anon key) | db.ts | Toda la DB expuesta a RLS |
| 5 proxies IA (claude/gemini/openai/xai/deepseek) | aiService.ts | API keys pasadas en body |

### 4. Archivo que Debe Eliminarse

- **`database.ts`** — IndexedDB legacy, ya no se usa. 340 líneas muertas.

---

## 🏗️ PLAN DE REFACTORING RECOMENDADO

### Fase 1: Eliminar Código Muerto
- [ ] Eliminar `database.ts` (IndexedDB legacy)
- [ ] Eliminar `findEdge()` y `autoPlaceOrders()` de `paperTrading.ts` (legacy)
- [ ] Eliminar `loadPortfolio()` y `savePortfolio()` deprecated de `paperTrading.ts`

### Fase 2: Mover Lógica de Trading a Edge Function
- [ ] `smartTrader.ts` → **nueva Edge Function `smart-trader-cycle/`** (ya existe esqueleto)
- [ ] `kellyStrategy.ts` → mover dentro de la Edge Function
- [ ] `claudeAI.ts` (prompt + parsing) → mover dentro de la Edge Function
- [ ] `aiService.ts` (routing multi-provider) → mover dentro de la Edge Function

### Fase 3: Seguridad
- [ ] `clobAuth.ts` → TODO server-side (Edge Function o API route)
- [ ] `wallet.ts` → `deriveAddress()` y `fetchBalance()` → server-side
- [ ] Eliminar `polymarket_api_creds` de localStorage → guardar encriptado en DB
- [ ] Eliminar private keys del frontend

### Fase 4: Frontend Puro
- [ ] `App.tsx` → solo render + dispatch events, sin lógica de ciclo
- [ ] `polymarket.ts` → solo funciones de display (formatPrice, formatVolume, formatTimeRemaining)
- [ ] Crear `src/hooks/` para React hooks que lean estado de DB
- [ ] `paperTrading.ts` → solo `getOrderHistory()`, rest al backend

### Fase 5: Migrar localStorage → Supabase `bot_kv`
- [ ] `_smartTrader_lastClaudeCall` → `bot_kv` key `last_ai_call`
- [ ] `_smartTrader_analyzedMap` → `bot_kv` key `analyzed_cache`
- [ ] `_smartTrader_cycleLock` → PostgreSQL advisory lock
- [ ] `_aiService_providerCallTimes` → `bot_kv` key `rate_limits`

---

## 📈 Meta Final

**Frontend tras refactoring:**
- Solo muestra datos (React hooks + Supabase realtime)
- Zero lógica de trading
- Zero manejo de private keys
- Zero localStorage para estado de negocio
- Componentes: Header, TopCards, MarketsPanel, OrdersPanel, StatsPanel, AIPanel, SettingsPanel, ConsolePanel, BalanceChart, ActivityLog

**Backend (Edge Functions):**
- `smart-trader-cycle/` — ciclo completo autónomo (ya invocado por pg_cron)
- `resolve-orders/` — resolución automática
- Toda la lógica de IA, Kelly, filtrado, y orden placement
- Manejo seguro de private keys y API keys

---

*Análisis completado. 15 archivos, ~120 funciones catalogadas, todas clasificadas.*
