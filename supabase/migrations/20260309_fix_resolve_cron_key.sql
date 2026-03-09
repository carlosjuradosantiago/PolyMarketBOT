-- ═══════════════════════════════════════════════════════════
-- Migración: Arreglar clave JWT del cron resolve-paper-orders
-- Fecha: 2026-03-09
-- Problema: El cron usaba sb_publishable_... que retorna 401.
--           Debe usar la anon JWT key igual que smart-trader-daily.
-- ═══════════════════════════════════════════════════════════

-- Eliminar el cron roto
SELECT cron.unschedule('resolve-paper-orders');

-- Re-crear con la anon JWT key correcta (cada 5 minutos)
SELECT cron.schedule(
  'resolve-paper-orders',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://iqsaxeeeqwswssewpkxj.supabase.co/functions/v1/resolve-orders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlxc2F4ZWVlcXdzd3NzZXdwa3hqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA5OTI0NjEsImV4cCI6MjA4NjU2ODQ2MX0.3RnensxwsnazWq8VpSwJcfyEyjARcc4r1VkgxnAZF-k'
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $$
);
