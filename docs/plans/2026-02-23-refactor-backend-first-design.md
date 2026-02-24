# Refactor Backend-First — Dashboard Puro

## Objetivo
Migrar toda la lógica de negocio, ciclo de trading, análisis IA, y estado del bot al backend (Supabase Edge Functions + DB). El frontend será un dashboard puro, solo visualización y control, sin lógica de negocio ni localStorage.

## Arquitectura

- **Frontend (React):**
  - Solo muestra datos de Supabase (Realtime y REST)
  - Botón Run/Stop invocan Edge Functions
  - Sin lógica de negocio, sin localStorage
- **Backend (Supabase):**
  - Edge Functions nuevas: run-cycle, stop-bot, get-status, cancel-order, reset-bot
  - Edge Functions existentes: smart-trader-cycle (cron), resolve-orders, proxies IA
  - Toda la lógica de trading, análisis, Kelly, simulación, logs, etc. vive aquí
  - DB: tablas bot_state, cycle_logs, orders, activities, portfolio, ai_cost_tracker, ai_usage_history, bot_kv

## Fases

### Fase 1 — Backend
- Ampliar tabla `bot_state` (agregar: analyzing, last_error, last_cycle_at)
- Crear Edge Functions:
  - run-cycle: ejecuta ciclo de trading, actualiza estado, logs, etc.
  - stop-bot: detiene el bot
  - get-status: retorna estado actual
  - cancel-order: cancela orden
  - reset-bot: resetea todo
- El ciclo manual (botón Run) solo invoca run-cycle

### Fase 2 — Frontend
- Eliminar toda lógica de negocio del frontend
- Eliminar todo uso de localStorage
- Reescribir App.tsx como dashboard puro
- Suscripción Realtime a tablas clave

### Fase 3 — Limpieza
- Borrar archivos muertos del frontend
- Verificar despliegue completo
- Tests

## Decisiones clave
- El frontend nunca ejecuta lógica de trading ni IA
- El estado "analizando" y errores viven en la DB
- El ciclo manual y automático usan el mismo backend
- Todo el historial y logs quedan persistentes

---

Aprobado por el usuario el 2026-02-23.
