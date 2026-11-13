// Task 027: smoke check of a deployed demo (Railway now, any host later).
//   DEMO_PASSWORD='…' node scripts/smoke-deploy.mjs https://<host> [--no-browser]
// Checks /healthz, /readyz, security headers and cookie flags, then signs in as every demo role through the API
// and (unless --no-browser) through the real sign-in form in Chromium, and waits for that role's home screen.
// Synthetic demo only. The password is read from the environment and never printed.
import assert from 'node:assert/strict';

const args = process.argv.slice(2);
const base = args.find(a => !a.startsWith('--'))?.replace(/\/+$/, '');
const browser = !args.includes('--no-browser');
const password = process.env.DEMO_PASSWORD;
const prefix = process.env.DEMO_LOGIN_PREFIX ?? 'demo';
// Local test only: a self-signed proxy stands in for the platform edge. Never set this against a real host.
const insecure = process.env.SMOKE_INSECURE_TLS === '1';
if (!base || !/^https:\/\/[^/]+$/.test(base)) { console.error('Usage: DEMO_PASSWORD=… node scripts/smoke-deploy.mjs https://<host> [--no-browser]'); process.exit(2); }
if (!password) { console.error('Set DEMO_PASSWORD in the environment (it is never printed).'); process.exit(2); }
if (insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const ROLES = [['ceo', 'ceo'], ['administrator', 'admin'], ['registrar', 'registrar'], ['doctor', 'doctor'],
  ['laboratory', 'lab'], ['cashier', 'cashier'], ['inpatient', 'inpatient'], ['pharmacy', 'pharmacy']];
let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { failures++; console.log(`FAIL ${name}: ${String(error?.message ?? error).replaceAll(password, '<redacted>').split('\n')[0]}`); }
};
const get = (path, init = {}) => fetch(base + path, { redirect: 'manual', signal: AbortSignal.timeout(15000), ...init });

await check('readyz answers 200 (database reachable, migrations applied)', async () => {
  let last = 0;
  for (let i = 0; i < 12; i++) { last = (await get('/readyz').catch(() => ({ status: 0 }))).status; if (last === 200) return; await new Promise(r => setTimeout(r, 5000)); }
  assert.fail(`last status ${last}`);
});
await check('healthz answers 200', async () => assert.equal((await get('/healthz')).status, 200));
await check('security headers on /', async () => {
  const r = await get('/');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('strict-transport-security'), 'max-age=31536000');
  assert.match(r.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
});
await check('source and secrets are not served', async () => {
  for (const path of ['/.env', '/package.json', '/src/server/main.ts', '/db/migrations']) assert.equal((await get(path)).status, 404, path);
});
await check('plain http is not served as the app', async () => {
  const r = await fetch(base.replace('https://', 'http://') + '/', { redirect: 'manual', signal: AbortSignal.timeout(10000) }).catch(() => null);
  assert.ok(!r || r.status !== 200 || !(r.headers.get('set-cookie') ?? '').length, 'http answered 200 with a cookie');
});
await check('signed-out API call is refused', async () => assert.equal((await get('/api/auth/me')).status, 401));
await check('cross-site login is refused (Origin check)', async () => {
  const r = await get('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ identifier: `${prefix}.ceo`, password }) });
  assert.equal(r.status, 403);
});

for (const [role, suffix] of ROLES) {
  await check(`API sign-in as ${prefix}.${suffix} reaches role ${role}`, async () => {
    const r = await get('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ identifier: `${prefix}.${suffix}`, password }) });
    assert.equal(r.status, 200, `login status ${r.status}`);
    const cookie = r.headers.get('set-cookie') ?? '';
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict']) assert.ok(cookie.includes(flag), `cookie lacks ${flag}`);
    assert.ok(!/domain=/i.test(cookie), 'cookie must not set Domain');
    const session = cookie.split(';')[0];
    const me = await (await get('/api/auth/me', { headers: { cookie: session } })).json();
    assert.equal(me.mustChangePassword, false);
    assert.ok(me.clinics?.[0]?.roles?.includes(role), `roles: ${JSON.stringify(me.clinics?.[0]?.roles)}`);
    await get('/api/auth/logout', { method: 'POST', headers: { cookie: session, origin: base, 'x-csrf-token': me.csrf } });
  });
}

if (browser) {
  let chromium;
  try { ({ chromium } = await import('playwright')); } catch { try { ({ chromium } = await import('@playwright/test')); } catch { chromium = null; } }
  if (!chromium) { failures++; console.log('FAIL browser checks: Playwright not installed (npm ci && npx playwright install chromium), or pass --no-browser'); }
  else {
    // SMOKE_CHROMIUM: path to an already installed Chrome/Chromium, if Playwright's own download is not present.
    const b = await chromium.launch(process.env.SMOKE_CHROMIUM ? { executablePath: process.env.SMOKE_CHROMIUM } : {})
      .catch(error => { failures++; console.log(`FAIL browser launch: ${String(error.message).split('\n')[0]} (npx playwright install chromium, or --no-browser)`); return null; });
    if (b) try {
      for (const [role, suffix] of ROLES) {
        await check(`browser sign-in as ${prefix}.${suffix} shows the ${role} home screen`, async () => {
          const context = await b.newContext({ ignoreHTTPSErrors: insecure, viewport: { width: 390, height: 844 } });
          try {
            const page = await context.newPage();
            await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
            await page.locator('input[name=identifier]').fill(`${prefix}.${suffix}`);
            await page.locator('input[name=password]').fill(password);
            await page.locator('form button.primary').click();
            await page.locator(`main.home[data-role="${role}"]`).waitFor({ timeout: 20000 });
            assert.equal(await page.locator('[role=alert]').count(), 0, 'an error is shown');
          } finally { await context.close(); }
        });
      }
    } finally { await b.close(); }
  }
}

console.log(failures ? `${failures} check(s) failed` : 'All smoke checks passed');
process.exit(failures ? 1 : 0);
