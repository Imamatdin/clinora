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
async function migrationFiles(): Promise<{ name: string; sql: string; checksum: string }[]> {
  const files = [];
  for (const name of (await readdir('db/migrations')).filter(n => /^\d+.*\.sql$/.test(n)).sort()) {
    const sql = await readFile('db/migrations/' + name, 'utf8');
    files.push({ name, sql, checksum: createHash('sha256').update(sql).digest('hex') });
  }
  return files;
}
// Ready means every migration shipped in this build is applied with the same checksum.
// Extra applied migrations are allowed: the previous revision keeps serving while a newer
// (backward-compatible) migration has already run ahead of the traffic shift.
export async function migrationsCurrent(pool: pg.Pool): Promise<boolean> {
  let rows: pg.QueryResultRow[];
  try { rows = (await pool.query('SELECT name,checksum FROM schema_migrations')).rows; }
  catch (error) { if ((error as { code?: string }).code === '42P01') return false; throw error; } // Fresh database: nothing applied.
  const applied = new Map(rows.map(r => [r.name as string, r.checksum as string]));
  return (await migrationFiles()).every(f => applied.get(f.name) === f.checksum);
}
export async function migrate(pool: pg.Pool) {
  const files = await migrationFiles();
  await transaction(pool, async tx => {
    await tx.query("SELECT pg_advisory_xact_lock(18732002)");
    await tx.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const { name, sql, checksum } of files) {
      const old = (await tx.query('SELECT checksum FROM schema_migrations WHERE name=$1', [name])).rows[0];
      if (old) { if (old.checksum !== checksum) throw new Error('Applied migration changed'); continue; }
      await tx.query(sql);
      await tx.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)', [name, checksum]);
    }
  });
}

/**
 * Task 022: a database rule rejected the write (closed business day, discharged stay, append-only or immutable row,
 * status transition, CHECK constraint). That is a conflict with the record's state, not an outage: 409, plain message.
 * restrict_violation and check_violation. Any other failure (including a plain RAISE) stays 503.
 */
export const RULE_VIOLATION_MESSAGE = 'This record is closed or can no longer be changed this way (closed business day, discharged stay or append-only record).';
export function isRuleViolation(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && ['23001', '23514'].includes(String((error as { code: unknown }).code));
}
