// Run: node supabase/_run_migration.cjs "postgresql://postgres:PASSWORD@db.REF.supabase.co:5432/postgres"
const { Client } = require("pg");
const fs = require("fs");

async function main() {
  const connStr = process.argv[2];
  if (!connStr) {
    console.error("Usage: node _run_migration.cjs <connection_string>");
    process.exit(1);
  }

  const client = new Client({ connectionString: connStr, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log("✅ Connected to database");

  const sqls = [
    // 1) Add cancel_reason column
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancel_reason TEXT;`,
    // 2) Add hourly retry cron (15:00-20:00 UTC)
    `SELECT cron.schedule(
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
    );`,
  ];

  for (const sql of sqls) {
    try {
      const res = await client.query(sql);
      console.log("✅", sql.slice(0, 60).replace(/\n/g, " ") + "...", res.rowCount ?? "OK");
    } catch (e) {
      console.error("❌", sql.slice(0, 60).replace(/\n/g, " "), e.message);
    }
  }

  // Verify
  const { rows } = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name='orders' AND column_name='cancel_reason'`);
  console.log("\n📋 cancel_reason column exists:", rows.length > 0);

  const { rows: crons } = await client.query(`SELECT jobname, schedule FROM cron.job WHERE jobname LIKE 'smart-trader%'`);
  console.log("📋 Cron jobs:");
  for (const c of crons) console.log(`  - ${c.jobname}: ${c.schedule}`);

  await client.end();
  console.log("\n✅ Migration complete!");
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
