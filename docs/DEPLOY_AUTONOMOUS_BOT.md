# 🤖 Bot Autónomo — Despliegue y Operación

## Resumen

El bot ahora corre **100% server-side** sin depender de ningún navegador:

| Componente | Ubicación | Frecuencia |
|---|---|---|
| `smart-trader-cycle` | Supabase Edge Function | Diario 14:00 UTC (9am COL) |
| `resolve-orders` | Supabase Edge Function | Cada 5 minutos |
| `bot_kv` | Tabla PostgreSQL | Estado persistente |
| `pg_cron` | PostgreSQL scheduler | Dispara ambas funciones |

---

## Paso 1: Crear tabla `bot_kv`

Ejecutar en Supabase SQL Editor (`https://supabase.com/dashboard` → tu proyecto → SQL Editor):

```sql
-- Copiar y pegar el contenido de:
-- supabase/migrations/20260216_smart_trader_cron.sql
```

Esto crea:
- Tabla `bot_kv` (reemplaza localStorage del navegador)
- Job `smart-trader-daily` en pg_cron (11:00 UTC cada día)

---

## Paso 2: Configurar Secrets del Edge Function

En Supabase Dashboard → Edge Functions → Secrets, agregar:

| Secret | Valor |
|---|---|
| `CLAUDE_API_KEY` | `sk-ant-api03-JnKTn...` (tu API key de Anthropic) |
| `SUPABASE_URL` | Ya existe automáticamente |
| `SUPABASE_SERVICE_ROLE_KEY` | Ya existe automáticamente |

> **⚠️ IMPORTANTE**: Tu API key de Claude está actualmente SIN CRÉDITOS.
> Debes recargar en https://console.anthropic.com antes de que el bot pueda operar.

---

## Paso 3: Desplegar Edge Function

### Opción A: Supabase CLI (recomendado)

```bash
# Instalar CLI si no la tienes
npm install -g supabase

# Login
supabase login

# Vincular proyecto
supabase link --project-ref <TU_PROJECT_REF>

# Desplegar
supabase functions deploy smart-trader-cycle --no-verify-jwt
```

### Opción B: Dashboard

1. Ir a Supabase Dashboard → Edge Functions
2. Crear nueva función: `smart-trader-cycle`
3. Copiar el contenido de `supabase/functions/smart-trader-cycle/index.ts`
4. Deploy

---

## Paso 4: Verificar

### Test manual:
```bash
curl -X POST https://<TU_PROJECT_REF>.supabase.co/functions/v1/smart-trader-cycle \
  -H "Authorization: Bearer <TU_ANON_KEY>" \
  -H "Content-Type: application/json"
```

### Verificar pg_cron:
```sql
SELECT * FROM cron.job WHERE jobname = 'smart-trader-daily';
SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 5;
```

### Ver logs:
```sql
SELECT timestamp, summary, bets_placed, cost_usd, error 
FROM cycle_logs 
ORDER BY timestamp DESC 
LIMIT 10;
```

---

## Arquitectura

```
pg_cron (14:00 UTC diario)
    │
    ▼
smart-trader-cycle (Edge Function)
    ├── 1. Verificar throttle (20h mínimo entre ciclos)
    ├── 2. Cargar portfolio desde DB
    ├── 3. Fetch mercados de Gamma API (directo, sin proxy)
    ├── 4. Construir pool (filtros: junk, deportes, liquidez, spread)
    ├── 5. Deduplicar clusters
    ├── 6. Diversificar (round-robin por categoría)
    ├── 7. Enviar 2 batches × 4 mercados a Claude (API directa)
    ├── 8. Aplicar Kelly Criterion + todos los guards
    ├── 9. Crear paper orders en DB
    └── 10. Guardar cycle_log + actualizar throttle
```

### Cambios vs. versión navegador:

| Aspecto | Navegador (App.tsx) | Servidor (Edge Function) |
|---|---|---|
| Trigger | `setInterval` en React | pg_cron |
| Estado de throttle | `localStorage` | tabla `bot_kv` |
| API de mercados | `/api/gamma` (Vite proxy) | `gamma-api.polymarket.com` (directo) |
| Claude API | via `claude-proxy` Edge Function | Directo a `api.anthropic.com` |
| Max batches | 5 | 2 (límite timeout 150s) |
| Cycle lock | `localStorage` con TTL 3min | `bot_kv` con TTL 5min |

---

## Monitoreo

### Ver actividad reciente:
```sql
SELECT timestamp, message, entry_type 
FROM activities 
WHERE entry_type IN ('Order', 'Inference', 'Error')
ORDER BY timestamp DESC 
LIMIT 20;
```

### Ver costos de IA:
```sql
SELECT * FROM ai_cost_tracker WHERE id = 1;
```

### Ver estado del bot:
```sql
SELECT * FROM bot_kv;
```

---

## ⚠️ Bloqueadores Actuales

1. **Claude API sin créditos** — Recargar en https://console.anthropic.com
2. **Edge Function debe ser desplegada** — Seguir Paso 3 arriba

Una vez resueltos estos dos puntos, el bot correrá solo cada día a las 9am hora Colombia (14:00 UTC), sin necesidad de abrir ningún navegador.
