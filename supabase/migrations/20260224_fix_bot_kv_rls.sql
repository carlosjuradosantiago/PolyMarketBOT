-- ═══════════════════════════════════════════════════════════════════
-- Migration: Fix bot_kv RLS policies
-- Problem: bot_kv has RLS enabled but NO policies for anon key.
--          Frontend (using anon key) cannot read/write config.
--          This causes the bot to ALWAYS fall back to Claude/Anthropic
--          even when user selects a different AI provider.
-- Solution: Add anon RLS policies for SELECT, INSERT, UPDATE, DELETE.
-- ═══════════════════════════════════════════════════════════════════

-- Add RLS policies for anon key (frontend uses anon key)
DO $$ BEGIN
  -- Drop existing policies if they exist (idempotent)
  DROP POLICY IF EXISTS "Allow anon select" ON bot_kv;
  DROP POLICY IF EXISTS "Allow anon insert" ON bot_kv;
  DROP POLICY IF EXISTS "Allow anon update" ON bot_kv;
  DROP POLICY IF EXISTS "Allow anon delete" ON bot_kv;
  DROP POLICY IF EXISTS "Allow anon all" ON bot_kv;
END $$;

-- Allow anon key full access to bot_kv (single-user bot, no auth needed)
CREATE POLICY "Allow anon select" ON bot_kv FOR SELECT TO anon USING (true);
CREATE POLICY "Allow anon insert" ON bot_kv FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Allow anon update" ON bot_kv FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Allow anon delete" ON bot_kv FOR DELETE TO anon USING (true);

-- Also seed the default AI config (Google Gemini since Anthropic credits depleted)
INSERT INTO bot_kv (key, value) VALUES
  ('ai_provider', 'google'),
  ('ai_model', 'gemini-2.5-flash')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
