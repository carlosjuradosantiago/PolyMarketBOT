import pg from 'pg';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, 'migration.sql'), 'utf8');

const client = new pg.Client({
  connectionString: 'postgresql://postgres:Ae.GkdrV7$4xx9U@db.iqsaxeeeqwswssewpkxj.supabase.co:5432/postgres',
  ssl: { rejectUnauthorized: false }
});

try {
  await client.connect();
  console.log('Connected to Supabase PostgreSQL');
  await client.query(sql);
  console.log('Migration executed successfully!');
  
  // Verify tables
  const res = await client.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY table_name;
  `);
  console.log('Tables created:', res.rows.map(r => r.table_name));
} catch (err) {
  console.error('Migration failed:', err.message);
  process.exit(1);
} finally {
  await client.end();
}
