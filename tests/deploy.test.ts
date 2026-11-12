import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { IncomingMessage } from 'node:http';
import { createApp, routeShape, type AccessLog } from '../src/server/app.js';
import { clientIp, parseTrustedHops } from '../src/server/client-ip.js';
import { demoGuard } from '../src/server/demo-guard.js';
import { makePool } from '../src/server/database.js';

const req = (xff: string | undefined, peer = '10.0.0.9') =>
  ({ headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress: peer } }) as unknown as IncomingMessage;

test('client IP: header ignored unless proxy hops are trusted; forged left entries never read', () => {
  assert.equal(clientIp(req('203.0.113.7'), 0), '10.0.0.9');
  assert.equal(clientIp(req('203.0.113.7'), 1), '203.0.113.7');
  // Caller forges a leading entry; Cloud Run appends the real one at the end.
  assert.equal(clientIp(req('198.51.100.1, 203.0.113.7'), 1), '203.0.113.7');
  assert.equal(clientIp(req('1.1.1.1,2.2.2.2,  203.0.113.7 '), 1), '203.0.113.7');
  assert.equal(clientIp(req('2001:db8::1'), 1), '2001:db8::1');
  // Garbage or missing header falls back to the TCP peer rather than a caller-chosen key.
  assert.equal(clientIp(req('not-an-ip'), 1), '10.0.0.9');
  assert.equal(clientIp(req(undefined), 1), '10.0.0.9');
  assert.equal(clientIp(req('203.0.113.7'), 2), '10.0.0.9');
  assert.equal(parseTrustedHops(undefined), 0);
  assert.equal(parseTrustedHops('1'), 1);
  for (const bad of ['-1', '1.5', 'yes', '9']) assert.throws(() => parseTrustedHops(bad));
});

test('demo seeding refuses production and non-staging remote databases', () => {
  const base = { ALLOW_SYNTHETIC_DEMO: 'true', DEMO_PASSWORD: 'Synthetic-Password-1' };
  assert.throws(() => demoGuard({ ...base, APP_ENV: 'production', DATABASE_URL: 'postgresql://u:p@127.0.0.1/clinora_local' }), /forbidden when APP_ENV=production/);
  assert.throws(() => demoGuard({ ...base, NODE_ENV: 'production', DATABASE_URL: 'postgresql://u:p@127.0.0.1/clinora_local' }), /requires APP_ENV=staging/);
  assert.throws(() => demoGuard({ ...base, APP_ENV: 'production', NODE_ENV: 'production', DATABASE_URL: 'postgresql://u:p@/clinora_staging?host=/cloudsql/p:r:i' }));
  assert.throws(() => demoGuard({ DEMO_PASSWORD: 'x', DATABASE_URL: 'postgresql://u:p@127.0.0.1/clinora_local' }), /ALLOW_SYNTHETIC_DEMO/);
  assert.throws(() => demoGuard({ ...base, DATABASE_URL: 'postgresql://u:p@db.example.com/clinora_local' }), /Demo requires/);
  assert.throws(() => demoGuard({ ...base, DATABASE_URL: 'postgresql://u:p@/clinora_staging?host=/cloudsql/p:r:i' }), /Demo requires/);
  assert.throws(() => demoGuard({ ...base, APP_ENV: 'staging', DATABASE_URL: 'postgresql://u:p@/clinora_prod?host=/cloudsql/p:r:i' }), /Demo requires/);
  assert.deepEqual(demoGuard({ ...base, DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/clinora_local' }), { host: '127.0.0.1', database: 'clinora_local' });
  assert.deepEqual(demoGuard({ ...base, APP_ENV: 'staging', NODE_ENV: 'production', DATABASE_URL: 'postgresql://u:p@/clinora_staging?host=/cloudsql/p:r:i' }),
    { host: '/cloudsql/p:r:i', database: 'clinora_staging' });
});

test('demo seed script exits before touching any database when APP_ENV=production', async () => {
  const run = promisify(execFile);
  await assert.rejects(run(process.execPath, ['--import', 'tsx', 'scripts/demo.mjs'], {
    env: { ...process.env, APP_ENV: 'production', ALLOW_SYNTHETIC_DEMO: 'true', DEMO_PASSWORD: 'Synthetic-Password-1',
      DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/clinora_local' } }), (error: Error & { stderr?: string }) => {
    assert.match(error.stderr ?? '', /forbidden when APP_ENV=production/);
    assert.doesNotMatch(error.stderr ?? '', /ECONNREFUSED/);
    return true;
  });
});

test('access log route shape drops identifiers and query data', () => {
  assert.equal(routeShape('/api/clinics/0b6c5c2e-8f1a-4c39-9d3e-2a7b1c0d9e8f/patients/123'), '/api/clinics/:id/patients/:n');
  assert.equal(routeShape('/api/x/<script>'), '/api/x/?script?');
  assert.ok(routeShape('/' + 'a'.repeat(1000)).length <= 200);
});

async function serve(app: Awaited<ReturnType<typeof createApp>>) {
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  const address = app.address(); assert.ok(address && typeof address === 'object');
  return { base: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>(r => app.close(() => r())) };
}

test('/healthz needs no database; /readyz fails without one or when it is unreachable', async t => {
  const logs: AccessLog[] = [];
  const bare = await serve(await createApp(undefined, undefined, { log: e => logs.push(e) }));
  t.after(bare.close);
  assert.equal((await fetch(bare.base + '/healthz')).status, 200);
  const notReady = await fetch(bare.base + '/readyz?patient=SYN-1');
  assert.equal(notReady.status, 503);
  assert.equal((await notReady.json()).reason, 'no_database');
  assert.equal(notReady.headers.get('strict-transport-security'), null, 'no HSTS on plain-HTTP development');
  assert.ok(logs.length >= 2 && logs.every(e => !JSON.stringify(e).includes('SYN-1')), 'query strings never logged');

  const pool = makePool('postgresql://nobody:nothing@127.0.0.1:1/clinora_test');
  const down = await serve(await createApp(undefined, { pool, origin: 'https://next.clinoraa.uz', secureCookies: true }));
  t.after(async () => { await down.close(); await pool.end(); });
  const r = await fetch(down.base + '/readyz');
  assert.equal(r.status, 503);
  assert.equal((await r.json()).reason, 'database_unreachable');
  assert.equal((await fetch(down.base + '/healthz')).status, 200, 'liveness stays up so the platform does not restart-loop');
  assert.equal(r.headers.get('strict-transport-security'), 'max-age=31536000');
});
