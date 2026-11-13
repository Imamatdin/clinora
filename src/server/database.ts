import pg from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { join } from 'node:path';
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
async function migrationFiles(dir = 'db/migrations'): Promise<{ name: string; sql: string; checksum: string }[]> {
  const files = [];
  for (const name of (await readdir(dir)).filter(n => /^\d+.*\.sql$/.test(n)).sort()) {
    const sql = await readFile(join(dir, name), 'utf8');
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

export type MigrateOptions = {
  dir?: string;
  /** Longest wait for a table lock. A blocked ALTER gives up (and retries) instead of queueing live traffic behind it. */
  lockTimeout?: string;
  /** Attempts per file after a lock timeout (55P03), with doubling back-off starting at retryDelayMs. */
  attempts?: number; retryDelayMs?: number;
  /** Statement timeout for a migration file, overridable per file with a comment in its first five
   * lines: `-- clinora:statement_timeout=30min`. Never the app's 10 s cap. */
  statementTimeout?: string;
  /** Application login role: created or updated with DML-only privileges (see grantApplication). */
  appRole?: { name: string; password?: string };
};
export class MigrationError extends Error { constructor(public readonly code: string, public readonly file?: string) { super(code); } }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const ident = (name: string) => { if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new MigrationError('invalid_identifier'); return `"${name}"`; };
const DURATION = /^[0-9]+(ms|s|min|h)$/;

/** PostgreSQL SCRAM-SHA-256 verifier, so the plain password never appears in SQL text or server logs. */
export function scramVerifier(password: string, salt = randomBytes(16), iterations = 4096): string {
  const salted = pbkdf2Sync(password.normalize('NFKC'), salt, iterations, 32, 'sha256');
  const hmac = (key: Buffer, text: string) => createHmac('sha256', key).update(text).digest();
  const stored = createHash('sha256').update(hmac(salted, 'Client Key')).digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${stored.toString('base64')}:${hmac(salted, 'Server Key').toString('base64')}`;
}

/**
 * Applies pending migrations to a live database (task 024):
 * - a session advisory lock, so two migrate jobs never interleave;
 * - each file in its own transaction with lock_timeout (5 s) and its own statement timeout, so a
 *   long backfill is not cut at 10 s and a blocked ALTER cannot stall traffic for long;
 * - a lock timeout rolls that file back and retries it with back-off; any other failure stops the run;
 *   files committed before it stay applied (each is recorded inside its own transaction).
 * Run as the schema owner. With `appRole`, the application role is left with DML only.
 */
export async function migrate(pool: pg.Pool, options: MigrateOptions = {}) {
  const { dir = 'db/migrations', lockTimeout = '5s', attempts = 6, retryDelayMs = 1000, statementTimeout = '15min' } = options;
  if (!DURATION.test(lockTimeout) || !DURATION.test(statementTimeout)) throw new MigrationError('invalid_timeout');
  const files = await migrationFiles(dir);
  const client = await pool.connect();
  try {
    await client.query('SET statement_timeout = 0'); // Waiting for another migrate job's lock is fine.
    await client.query('SELECT pg_advisory_lock(18732002)');
    try {
      if (!(await client.query("SELECT to_regclass('schema_migrations') IS NOT NULL ok")).rows[0].ok)
        await client.query('CREATE TABLE schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
      const applied = new Map((await client.query('SELECT name,checksum FROM schema_migrations')).rows.map(r => [r.name as string, r.checksum as string]));
      for (const { name, sql, checksum } of files) {
        const old = applied.get(name);
        if (old !== undefined) { if (old !== checksum) throw new MigrationError('applied_migration_changed', name); continue; }
        const own = /^--\s*clinora:statement_timeout=(\S+)\s*$/m.exec(sql.split('\n').slice(0, 5).join('\n'))?.[1];
        if (own !== undefined && !DURATION.test(own)) throw new MigrationError('invalid_timeout', name);
        for (let attempt = 1; ; attempt++) {
          try {
            await client.query('BEGIN');
            await client.query(`SET LOCAL lock_timeout = '${lockTimeout}'`);
            await client.query(`SET LOCAL statement_timeout = '${own ?? statementTimeout}'`);
            await client.query(sql);
            await client.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)', [name, checksum]);
            await client.query('COMMIT');
            break;
          } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            const code = (error as { code?: string }).code;
            if (code === '55P03' && attempt < attempts) { await sleep(retryDelayMs * 2 ** (attempt - 1)); continue; }
            throw new MigrationError(code === '55P03' ? 'lock_timeout' : code ?? 'unknown', name);
          }
        }
      }
      if (options.appRole) await grantApplication(client, options.appRole);
    } finally {
      await client.query('SELECT pg_advisory_unlock(18732002)').catch(() => {});
      await client.query('RESET statement_timeout').catch(() => {}); // Back to the pool's 10 s default.
    }
  } finally { client.release(); }
}

/**
 * The application role reads and writes rows but cannot change the schema: it owns nothing, has no
 * CREATE on the schema, no TRUNCATE (which skips row triggers) and no TRIGGER privilege, so it cannot
 * drop or disable the append-only and closed-day triggers. schema_migrations is read-only to it.
 * It is created here, in SQL, by the owner: `gcloud sql users create` would make it a member of
 * cloudsqlsuperuser (CREATEROLE, CREATEDB), and any such membership is revoked.
 */
async function grantApplication(client: pg.PoolClient, role: { name: string; password?: string }) {
  const r = ident(role.name);
  await client.query('BEGIN');
  try {
    const exists = (await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role.name])).rowCount;
    const login = role.password ? `LOGIN PASSWORD '${scramVerifier(role.password)}'` : '';
    await client.query(`${exists ? 'ALTER' : 'CREATE'} ROLE ${r} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS ${login}`);
    const memberships = (await client.query(`SELECT g.rolname FROM pg_auth_members m JOIN pg_roles u ON u.oid=m.member JOIN pg_roles g ON g.oid=m.roleid WHERE u.rolname=$1`, [role.name])).rows;
    for (const { rolname } of memberships) await client.query(`REVOKE ${ident(rolname)} FROM ${r}`);
    const schema = ident((await client.query('SELECT current_schema() s')).rows[0].s);
    await client.query(`REVOKE CREATE ON SCHEMA ${schema} FROM PUBLIC, ${r}`);
    await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${r}`);
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM ${r}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${r}`);
    await client.query(`REVOKE INSERT, UPDATE, DELETE ON schema_migrations FROM ${r}`);
    await client.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${schema} TO ${r}`);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
}
