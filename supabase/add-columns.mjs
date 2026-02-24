import pg from 'pg';

const client = new pg.Client({
  host: 'db.iqsaxeeeqwswssewpkxj.supabase.co',
  port: 5432,
  database: 'postgres',
  user: 'postgres',
  password: '***REDACTED***',
  ssl: { rejectUnauthorized: false }
});

try {
  await client.connect();
  console.log('Connected to Supabase PostgreSQL');

  // ── bot_state: agregar columnas nuevas ──
  const botStateAlters = [
    `DO $$BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='bot_state' AND column_name='analyzing') THEN ALTER TABLE bot_state ADD COLUMN analyzing BOOLEAN NOT NULL DEFAULT false; END IF; END$$;`,
    `DO $$BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='bot_state' AND column_name='last_error') THEN ALTER TABLE bot_state ADD COLUMN last_error TEXT; END IF; END$$;`,
    `DO $$BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='bot_state' AND column_name='last_cycle_at') THEN ALTER TABLE bot_state ADD COLUMN last_cycle_at TIMESTAMPTZ; END IF; END$$;`,
  ];

  for (const q of botStateAlters) {
    await client.query(q);
    console.log('✅ bot_state ALTER OK');
  }

  // ── portfolio: agregar columnas para reset-bot ──
  const portfolioAlters = [
    `DO $$BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='portfolio' AND column_name='total_invested') THEN ALTER TABLE portfolio ADD COLUMN total_invested DOUBLE PRECISION NOT NULL DEFAULT 0; END IF; END$$;`,
    `DO $$BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='portfolio' AND column_name='total_won') THEN ALTER TABLE portfolio ADD COLUMN total_won DOUBLE PRECISION NOT NULL DEFAULT 0; END IF; END$$;`,
    `DO $$BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='portfolio' AND column_name='total_lost') THEN ALTER TABLE portfolio ADD COLUMN total_lost DOUBLE PRECISION NOT NULL DEFAULT 0; END IF; END$$;`,
    `DO $$BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='portfolio' AND column_name='active_positions') THEN ALTER TABLE portfolio ADD COLUMN active_positions INT NOT NULL DEFAULT 0; END IF; END$$;`,
    `DO $$BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='portfolio' AND column_name='balance_history') THEN ALTER TABLE portfolio ADD COLUMN balance_history TEXT DEFAULT '[]'; END IF; END$$;`,
  ];

  for (const q of portfolioAlters) {
    await client.query(q);
    console.log('✅ portfolio ALTER OK');
  }

  // ── Verificar ──
  const res = await client.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name='bot_state' ORDER BY ordinal_position`);
  console.log('\nbot_state columns:');
  res.rows.forEach(r => console.log(`  ${r.column_name}: ${r.data_type}`));

  const res2 = await client.query(`SELECT * FROM bot_state WHERE id=1`);
  console.log('\nbot_state row:', JSON.stringify(res2.rows[0], null, 2));

  const res3 = await client.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name='portfolio' ORDER BY ordinal_position`);
  console.log('\nportfolio columns:');
  res3.rows.forEach(r => console.log(`  ${r.column_name}: ${r.data_type}`));

  console.log('\n✅ Migración completada exitosamente');
} catch (err) {
  console.error('❌ Error en migración:', err.message);
  process.exit(1);
} finally {
  await client.end();
}
