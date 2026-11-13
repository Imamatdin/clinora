import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { makePool, migrate, MigrationError, scramVerifier } from '../../src/server/database.js';
import { databaseFixture } from './fixture.js';
import { once } from 'node:events';
import { createApp } from '../../src/server/app.js';

/* Task 024: migrations are safe on a live database, and the application role cannot change the schema. */
const url = () => { const u = process.env.TEST_DATABASE_URL; if (!u) throw new Error('TEST_DATABASE_URL required'); return u; };
async function scratch() {
  const schema = 'clinora_test_' + randomUUID().replaceAll('-', '');
  const admin = makePool(url()); await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = makePool(url(), schema), dir = await mkdtemp(join(tmpdir(), 'clinora-migrations-'));
  return { schema, pool, admin, dir, async close() { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); } };
}

test('each migration file commits alone; a failing file leaves earlier files applied and is retried next run', async () => {
  const s = await scratch();
  try {
    await writeFile(join(s.dir, '001_a.sql'), 'CREATE TABLE a (id int);');
    await writeFile(join(s.dir, '002_b.sql'), 'CREATE TABLE b (id int); SELECT 1/0;');
    await assert.rejects(migrate(s.pool, { dir: s.dir }), (e: unknown) => e instanceof MigrationError && e.file === '002_b.sql' && e.code === '22012');
    assert.deepEqual((await s.pool.query('SELECT name FROM schema_migrations')).rows.map(r => r.name), ['001_a.sql']);
    assert.equal((await s.pool.query("SELECT to_regclass('b') t")).rows[0].t, null, 'the failed file rolled back completely');
    await writeFile(join(s.dir, '002_b.sql'), 'CREATE TABLE b (id int);');
    await migrate(s.pool, { dir: s.dir });
    assert.equal((await s.pool.query('SELECT count(*)::int n FROM schema_migrations')).rows[0].n, 2);
    await writeFile(join(s.dir, '001_a.sql'), 'CREATE TABLE a (id bigint);');
    await assert.rejects(migrate(s.pool, { dir: s.dir }), (e: unknown) => e instanceof MigrationError && e.code === 'applied_migration_changed');
  } finally { await s.close(); }
});

test('a migration waits at most lock_timeout for a busy table, retries, and succeeds once the lock is released', async () => {
  const s = await scratch();
  try {
    await writeFile(join(s.dir, '001_t.sql'), 'CREATE TABLE t (id int);');
    await migrate(s.pool, { dir: s.dir });
    await writeFile(join(s.dir, '002_alter.sql'), 'ALTER TABLE t ADD COLUMN note text;');
    const holder = await s.pool.connect();
    await holder.query('BEGIN'); await holder.query('LOCK TABLE t IN ACCESS SHARE MODE'); // A long read by the live app.
    // Give up quickly while blocked; never queue traffic behind the ALTER for longer than lock_timeout.
    const blocked = Date.now();
    await assert.rejects(migrate(s.pool, { dir: s.dir, lockTimeout: '200ms', attempts: 2, retryDelayMs: 50 }),
      (e: unknown) => e instanceof MigrationError && e.code === 'lock_timeout' && e.file === '002_alter.sql');
    assert.ok(Date.now() - blocked < 3000);
    // While retrying, the reader finishes: the next attempt goes through.
    setTimeout(() => { void holder.query('COMMIT').then(() => holder.release()); }, 300);
    await migrate(s.pool, { dir: s.dir, lockTimeout: '200ms', attempts: 6, retryDelayMs: 100 });
    assert.equal((await s.pool.query("SELECT count(*)::int n FROM information_schema.columns WHERE table_schema=$1 AND table_name='t' AND column_name='note'", [s.schema])).rows[0].n, 1);
  } finally { await s.close(); }
});

test("a migration's own statement timeout replaces the app's 10 s cap, and pool connections get the cap back", async () => {
  const s = await scratch();
  try {
    await writeFile(join(s.dir, '001_slow.sql'), '-- clinora:statement_timeout=100ms\nSELECT pg_sleep(0.5);');
    await assert.rejects(migrate(s.pool, { dir: s.dir }), (e: unknown) => e instanceof MigrationError && e.code === '57014');
    await writeFile(join(s.dir, '001_slow.sql'), '-- clinora:statement_timeout=20s\nSELECT pg_sleep(0.2);');
    await migrate(s.pool, { dir: s.dir, statementTimeout: '50ms' });
    for (let i = 0; i < 8; i++) assert.equal((await s.pool.query('SHOW statement_timeout')).rows[0].statement_timeout, '10s');
  } finally { await s.close(); }
});

test('application role: rows yes, schema no (cannot drop or disable an append-only trigger, truncate, or alter)', async () => {
  const db = await databaseFixture();
  const role = 'clinora_app_test_' + randomUUID().replaceAll('-', '').slice(0, 12), password = 'Synthetic-' + randomUUID();
  const admin = makePool(url());
  try {
    await migrate(db.pool, { appRole: { name: role, password } });
    await migrate(db.pool, { appRole: { name: role, password } }); // Idempotent re-grant.
    const attrs = (await admin.query('SELECT rolsuper,rolcreaterole,rolcreatedb,rolcanlogin FROM pg_roles WHERE rolname=$1', [role])).rows[0];
    assert.deepEqual(attrs, { rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolcanlogin: true });
    // Sign in as the app role with the password (SCRAM verifier stored, never the plain text).
    const u = new URL(url()); u.username = role; u.password = password;
    const app = new pg.Client({ connectionString: u.toString(), options: `-c search_path=${db.schema}` });
    await app.connect();
    try {
      assert.ok((await app.query('SELECT count(*) FROM clinics')).rows[0]);
      await app.query('UPDATE clinics SET name=name WHERE id=$1', [db.owner.clinicId]);
      const denied = async (sql: string) => assert.rejects(app.query(sql), (e: { code?: string }) => e.code === '42501', sql);
      await denied('DROP TRIGGER payments_append_only ON payments');
      await denied('ALTER TABLE payments DISABLE TRIGGER payments_append_only');
      await denied('TRUNCATE payments');
      await denied('ALTER TABLE payments ADD COLUMN x int');
      await denied('DROP TABLE payment_allocations');
      await denied('CREATE TABLE sneaky (id int)');
      await denied("INSERT INTO schema_migrations(name,checksum) VALUES('999_x.sql','x')");
      await denied('SET session_replication_role = replica');
      assert.ok((await app.query('SELECT count(*) FROM schema_migrations')).rows[0], 'readiness can still read the migration list');
      assert.ok((await app.query('SELECT 1 FROM pg_trigger WHERE tgname=$1', ['payments_append_only'])).rowCount);
    } finally { await app.end(); }
    // The running app needs nothing beyond that: sign in, open a day (triggers write report tables), read the dashboard.
    const appPool = makePool(u.toString(), db.schema);
    const config = { pool: appPool, origin: 'http://127.0.0.1:0', secureCookies: false }, server = await createApp(undefined, config);
    try {
      server.listen(0, '127.0.0.1'); await once(server, 'listening');
      const address = server.address(); assert.ok(address && typeof address === 'object');
      const origin = config.origin = `http://127.0.0.1:${address.port}`;
      const login = await fetch(origin + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ email: 'owner@example.test', password: db.password }) });
      assert.equal(login.status, 200);
      const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
      const csrf = (await (await fetch(origin + '/api/auth/me', { headers: { Cookie: cookie } })).json()).csrf;
      const post = (path: string, body: unknown) => fetch(origin + `/api/clinics/${db.owner.clinicId}` + path, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: origin, 'X-CSRF-Token': csrf }, body: JSON.stringify(body) });
      assert.equal((await post('/business-days/open', {})).status, 201);
      const today = (await appPool.query('SELECT business_date FROM business_days WHERE clinic_id=$1', [db.owner.clinicId])).rows[0].business_date;
      assert.equal((await post('/reports/dashboard', { from: today, to: today })).status, 200);
      assert.equal((await fetch(origin + '/readyz')).status, 200);
    } finally { await new Promise<void>(r => server.close(() => r())); await appPool.end(); }
    assert.match(scramVerifier('x'), /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
  } finally {
    await db.close();
    await admin.query(`DROP OWNED BY "${role}"`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => {});
    await admin.end();
  }
});
