import pg from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
pg.types.setTypeParser(1082, value => value); // Calendar dates must not become midnight instants.
export type Tx = pg.PoolClient;
export const makePool = (url: string, schema?: string) => {
  if (schema && !/^clinora_test_[a-f0-9]+$/.test(schema)) throw new Error('Invalid test schema');
  const pool = new pg.Pool({ connectionString: url, max: 8, connectionTimeoutMillis: 4000,
    statement_timeout: 10000, idle_in_transaction_session_timeout: 15000,
    ...(schema ? { options: `-c search_path=${schema}` } : {}) });
  pool.on('error', () => { /* Never print SQL, connection URLs or provider errors. */ });
  return pool;
};
export async function transaction<T>(pool: pg.Pool, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await pool.connect();
  try { await tx.query('BEGIN'); const result = await fn(tx); await tx.query('COMMIT'); return result; }
  catch (error) { await tx.query('ROLLBACK').catch(() => {}); throw error; }
  finally { tx.release(); }
}
export async function migrate(pool: pg.Pool) {
  await transaction(pool, async tx => {
    await tx.query("SELECT pg_advisory_xact_lock(18732002)");
    await tx.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const name of (await readdir('db/migrations')).filter(n => /^\d+.*\.sql$/.test(n)).sort()) {
      const sql = await readFile('db/migrations/' + name, 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const old = (await tx.query('SELECT checksum FROM schema_migrations WHERE name=$1', [name])).rows[0];
      if (old) { if (old.checksum !== checksum) throw new Error('Applied migration changed'); continue; }
      await tx.query(sql);
      await tx.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)', [name, checksum]);
    }
  });
}
