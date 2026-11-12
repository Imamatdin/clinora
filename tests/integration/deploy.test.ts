import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../../src/server/security.js';
import { once } from 'node:events';
import { createApp } from '../../src/server/app.js';
import { databaseFixture } from './fixture.js';

test('deployed settings: readiness tracks migrations, cookies are host-only and Secure, rate limit keys on the proxy-appended IP', async t => {
  const db = await databaseFixture();
  const config = { pool: db.pool, origin: 'http://127.0.0.1:0', secureCookies: true, trustProxyHops: 1 };
  const server = await createApp(undefined, config);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  config.origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await new Promise<void>(r => server.close(() => r())); await db.close(); });

  assert.equal((await fetch(config.origin + '/readyz')).status, 200);
  // Simulate a new build whose migration has not run yet: the revision must not become ready.
  const [{ name, checksum }] = (await db.pool.query('SELECT name,checksum FROM schema_migrations ORDER BY name DESC LIMIT 1')).rows;
  await db.pool.query('DELETE FROM schema_migrations WHERE name=$1', [name]);
  const pending = await fetch(config.origin + '/readyz');
  assert.equal(pending.status, 503);
  assert.equal((await pending.json()).reason, 'migrations_pending');
  // A changed migration file (checksum mismatch) is not ready either.
  await db.pool.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)', [name, 'not-the-shipped-file']);
  assert.equal((await fetch(config.origin + '/readyz')).status, 503);
  // An extra applied migration this build does not ship (a newer deploy migrated first) stays ready,
  // so the previous revision keeps serving during the expand phase.
  await db.pool.query('UPDATE schema_migrations SET checksum=$2 WHERE name=$1', [name, checksum]);
  await db.pool.query("INSERT INTO schema_migrations(name,checksum) VALUES('999_future.sql','x')");
  assert.equal((await fetch(config.origin + '/readyz')).status, 200);
  // Fresh database with no migration table at all: pending, not "unreachable".
  await db.pool.query('ALTER TABLE schema_migrations RENAME TO schema_migrations_hidden');
  assert.equal((await (await fetch(config.origin + '/readyz')).json()).reason, 'migrations_pending');
  await db.pool.query('ALTER TABLE schema_migrations_hidden RENAME TO schema_migrations');

  const post = (body: unknown, xff: string) => fetch(config.origin + '/api/auth/login', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: config.origin, 'X-Forwarded-For': xff }, body: JSON.stringify(body) });
  const login = await post({ email: 'owner@example.test', password: db.password }, '203.0.113.50');
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie') ?? '';
  for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(cookie.includes(attribute), attribute);
  assert.doesNotMatch(cookie, /domain=/i, 'host-only cookie: never shared with other clinoraa.uz hosts');
  assert.equal(login.headers.get('strict-transport-security'), 'max-age=31536000');

  // 300 failures per IP per 15 minutes. Seed the first 299 to keep this proxy test fast.
  await db.pool.query("INSERT INTO login_limits(key,attempts,reset_at) VALUES($1,299,now()+interval '15 minutes')", [digest('password-ip:203.0.113.9')]);
  // Rotating a forged left-hand entry must not reset the real client's counter.
  let limited = 0;
  for (let i = 0; i < 2; i++) {
    const r = await post({ email: `nobody${i}@example.test`, password: 'Wrong-password-1' }, `198.51.100.${i}, 203.0.113.9`);
    if (r.status === 429) limited++;
  }
  assert.equal(limited, 1, 'the 301st failed attempt from the same real client is limited despite forged prefixes');
  const other = await post({ email: 'nobody-else@example.test', password: 'Wrong-password-1' }, '203.0.113.10');
  assert.equal(other.status, 401, 'a different real client is unaffected');
});
