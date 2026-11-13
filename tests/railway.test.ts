import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPredeployEnv, checkStartEnv, maintenanceUrl, parseDemoAction, tashkentDate, STRIP_BEFORE_START } from '../src/server/railway.js';

const owner = 'postgresql://postgres:owner-secret@postgres.railway.internal:5432/clinora_staging';
const appUrl = 'postgresql://clinora_app:app-secret@postgres.railway.internal:5432/clinora_staging';
const start = { NODE_ENV: 'production', APP_ENV: 'staging', APP_ORIGIN: 'https://clinora-demo.up.railway.app', COOKIE_SECURE: 'true',
  TRUST_PROXY_HOPS: '1', ASSISTANT_SIMULATION: 'true', DATABASE_URL: owner, APP_DATABASE_URL: appUrl };

test('railway start: a complete demo environment passes', () => {
  assert.deepEqual(checkStartEnv(start), []);
});

test('railway start: names every missing or unsafe variable and never echoes a password', () => {
  const problems = checkStartEnv({ DATABASE_URL: owner });
  for (const name of ['NODE_ENV', 'APP_ENV', 'APP_ORIGIN', 'COOKIE_SECURE', 'TRUST_PROXY_HOPS', 'ASSISTANT_SIMULATION', 'APP_DATABASE_URL'])
    assert.ok(problems.some(p => p.includes(name)), name);
  assert.ok(!problems.join(' ').includes('secret'));
  assert.ok(checkStartEnv({ ...start, APP_ENV: 'production' }).some(p => p.includes('APP_ENV')));
  assert.ok(checkStartEnv({ ...start, APP_ORIGIN: 'http://x.up.railway.app' }).some(p => p.includes('APP_ORIGIN')));
  assert.ok(checkStartEnv({ ...start, APP_ORIGIN: 'https://x.up.railway.app/' }).some(p => p.includes('APP_ORIGIN')));
  assert.ok(checkStartEnv({ ...start, TRUST_PROXY_HOPS: '7' }).some(p => p.includes('TRUST_PROXY_HOPS')));
  assert.ok(checkStartEnv({ ...start, TELEGRAM_BOT_TOKEN: 'x' }).some(p => p.includes('TELEGRAM_BOT_TOKEN')));
  assert.ok(checkStartEnv({ ...start, VERTEX_API_KEY: 'x' }).some(p => p.includes('VERTEX_API_KEY')));
});

test('railway: role split is enforced, the database must be clinora_staging', () => {
  assert.ok(checkPredeployEnv({ APP_ENV: 'staging', DATABASE_URL: owner, APP_DATABASE_URL: owner }).some(p => p.includes('own login')));
  assert.ok(checkPredeployEnv({ APP_ENV: 'staging', DATABASE_URL: owner.replace('clinora_staging', 'railway'), APP_DATABASE_URL: appUrl }).some(p => p.includes('clinora_staging')));
  assert.ok(checkPredeployEnv({ APP_ENV: 'staging', DATABASE_URL: owner, APP_DATABASE_URL: appUrl.replace('postgres.railway.internal', 'evil.example') }).some(p => p.includes('same server')));
  assert.ok(checkPredeployEnv({ APP_ENV: 'production', DATABASE_URL: owner, APP_DATABASE_URL: appUrl }).some(p => p.includes('APP_ENV')));
  assert.ok(checkPredeployEnv({ APP_ENV: 'staging', DATABASE_URL: 'not a url', APP_DATABASE_URL: appUrl }).some(p => p.includes('not a valid URL')));
  assert.deepEqual(checkPredeployEnv({ APP_ENV: 'staging', DATABASE_URL: owner, APP_DATABASE_URL: appUrl }), []);
  assert.equal(new URL(maintenanceUrl(owner)).pathname, '/postgres');
});

test('railway: demo action runs a reset only on the named Tashkent day', () => {
  const now = new Date('2026-11-13T20:30:00Z'); // 01:30 on 14 Nov in Tashkent
  assert.equal(tashkentDate(now), '2026-11-14');
  assert.deepEqual(parseDemoAction(undefined, now), { kind: 'none' });
  assert.deepEqual(parseDemoAction(' ', now), { kind: 'none' });
  assert.deepEqual(parseDemoAction('seed', now), { kind: 'seed' });
  assert.deepEqual(parseDemoAction('reset-2026-11-14', now), { kind: 'reset', date: '2026-11-14' });
  assert.deepEqual(parseDemoAction('reset-2026-11-13', now), { kind: 'stale-reset', date: '2026-11-13' });
  for (const bad of ['reset', 'wipe', 'reset-14-11-2026', 'seed;drop']) assert.throws(() => parseDemoAction(bad, now));
});

test('railway start strips the owner credential and demo password', () => {
  for (const name of ['DATABASE_URL', 'APP_DATABASE_URL', 'DEMO_PASSWORD']) assert.ok((STRIP_BEFORE_START as readonly string[]).includes(name));
});
