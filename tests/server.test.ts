import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/server/app.js';
import { ApiError } from '../src/contracts/index.js';

test('real HTTP health works; claimed roles and bearer tokens cannot open clinical endpoints', async t => {
  const server = await createApp();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const health = await fetch(base + '/api/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).clinicalStorage, 'not_implemented');
  for (const path of ['/api/patients', '/api/patients/other-clinic', '/api/documents/export', '/api/events', '/api/auth/telegram']) {
    const response = await fetch(base + path, { headers: { Authorization: 'Bearer synthetic-token', 'X-Role': 'doctor', Cookie: 'role=doctor' } });
    assert.equal(response.status, 401, path);
    assert.equal(ApiError.parse(await response.json()).error.code, 'UNAUTHENTICATED');
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal((await fetch(base + '/api/patients', { method: 'POST', body: JSON.stringify({ role: 'doctor' }) })).status, 401);
  for (const path of ['/.env', '/work/crm-install.log', '/src/server/main.ts', '/assets/../../package.json']) {
    assert.equal((await fetch(base + path)).status, 404);
  }
  const head = await fetch(base + '/api/health', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});
