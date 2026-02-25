-- Actualizar cron de smart-trader: 5 invocaciones cada 5 min (14:00-14:20 UTC)
-- Cada invocación analiza 5 mercados nuevos (el analyzed_map evita repetir)
-- Total: ~25 mercados/día en vez de solo 5

-- Usar cron.schedule con el mismo nombre para actualizar la programación existente
SELECT cron.schedule(
  'smart-trader-daily',
  '0,5,10,15,20 14 * * *',
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
