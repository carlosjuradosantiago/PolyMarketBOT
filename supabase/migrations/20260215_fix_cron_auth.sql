-- Fix: Add Authorization header to pg_cron job
-- The original job was missing the auth header, causing 401 on every call

-- Remove the broken job
SELECT cron.unschedule('resolve-paper-orders');

-- Reschedule with proper Authorization header
SELECT cron.schedule(
  'resolve-paper-orders',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://iqsaxeeeqwswssewpkxj.supabase.co/functions/v1/resolve-orders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer sb_publishable_FOGtMrVR0meYouO4w0Pt3w_yTdOojWl'
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $$
);
