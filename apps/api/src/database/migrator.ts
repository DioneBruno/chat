import { Logger } from '@nestjs/common';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';

/** Chave arbitrária do advisory lock: serializa migrations entre réplicas. */
const MIGRATION_LOCK = 4_040_404;

/** Aplica `migrations/*.sql` pendentes, em ordem, cada uma em sua transação. */
export async function runMigrations(
  pool: Pool,
  dir = join(__dirname, 'migrations'),
) {
  const logger = new Logger('Migrator');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const applied = new Set(
      (
        await client.query<{ name: string }>(
          'SELECT name FROM schema_migrations',
        )
      ).rows.map((r) => r.name),
    );
    for (const file of files) {
      if (applied.has(file)) continue;
      try {
        await client.query('BEGIN');
        await client.query(readFileSync(join(dir, file), 'utf8'));
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [
          file,
        ]);
        await client.query('COMMIT');
        logger.log(`migration aplicada: ${file}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client
      .query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK])
      .catch(() => undefined);
    client.release();
  }
}
