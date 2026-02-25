-- Cron diario: smart-trader-cycle - 5 invocaciones cada 5 min (14:00-14:20 UTC = 9:00-9:20 AM Colombia)
-- Cada invocación analiza 5 mercados. Total: ~25 mercados/día
-- El analyzed_map evita re-analizar los mismos mercados entre invocaciones

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
