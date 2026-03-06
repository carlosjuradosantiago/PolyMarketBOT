-- ═══════════════════════════════════════════════════════════
-- Migración: cancel_reason + cron retry horario
-- Fecha: 2026-03-06
-- ═══════════════════════════════════════════════════════════

-- 1) Añadir columna cancel_reason a orders (resolve-orders la necesita)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancel_reason TEXT;

-- 2) Cron retry horario para fallos de Gemini 503
-- Si la ventana principal (14:00-14:10 UTC) falla por errores de IA,
-- reintentar cada hora de 15:00 a 20:00 UTC.
-- El código del ciclo cuenta solo ciclos EXITOSOS (error IS NULL)
-- contra MAX_AUTO_CYCLES_PER_DAY, así que si los 3 de la ventana
-- principal fueron exitosos, los retries se saltan automáticamente.
SELECT cron.schedule(
  'smart-trader-retry',
  '0 15-20 * * *',
  $$
  SELECT net.http_post(
    url := 'https://iqsaxeeeqwswssewpkxj.supabase.co/functions/v1/smart-trader-cycle',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlxc2F4ZWVlcXdzd3NzZXdwa3hqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA5OTI0NjEsImV4cCI6MjA4NjU2ODQ2MX0.3RnensxwsnazWq8VpSwJcfyEyjARcc4r1VkgxnAZF-k'
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $$
);
