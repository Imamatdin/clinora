import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { CSP } from '../src/server/app.js';

/** Runs public/sw.js in a sandbox with recorded caches and network. */
async function loadWorker() {
  const handlers = new Map<string, (event: unknown) => void>();
  const puts: string[] = [];
  const cache = { addAll: async (urls: string[]) => { puts.push(...urls); }, put: async (req: { url?: string } | string) => { puts.push(typeof req === 'string' ? req : req.url!); } };
  const self: Record<string, unknown> = {
    location: new URL('https://clinic.example.test/'),
    addEventListener: (type: string, fn: (event: unknown) => void) => handlers.set(type, fn),
    skipWaiting: async () => {}, clients: { claim: async () => {} }
  };
  const context = vm.createContext({ self, URL, Response: { error: () => ({ error: true }) },
    caches: { open: async () => cache, keys: async () => [], match: async () => undefined, delete: async () => true },
    fetch: async () => ({ ok: true, clone() { return this; } }) });
  vm.runInContext(await readFile('src/web/public/sw.js', 'utf8'), context);
  return { self, handlers, puts };
}
const request = (url: string, method = 'GET', mode = 'cors') => ({ url, method, mode });

test('service worker never intercepts or caches API requests', async () => {
  const { self, handlers, puts } = await loadWorker();
  const shellRequest = self.shellRequest as (r: unknown) => string | null;
  for (const url of ['/api/auth/me', '/api/clinics/x/staff', '/api', '/api/device', '/api/telegram/session'])
    for (const method of ['GET', 'POST']) assert.equal(shellRequest(request('https://clinic.example.test' + url, method)), null, `${method} ${url}`);
  assert.equal(shellRequest(request('https://clinic.example.test/', 'GET', 'navigate')), 'page');
  assert.equal(shellRequest(request('https://clinic.example.test/assets/index-abc.js')), 'static');
  assert.equal(shellRequest(request('https://other.example/assets/x.js')), null, 'other origins untouched');
  const fetchHandler = handlers.get('fetch')!;
  let responded = 0;
  for (const url of ['/api/auth/me', '/api/clinics/x/patients']) fetchHandler({ request: request('https://clinic.example.test' + url), respondWith: () => { responded++; }, waitUntil: () => {} });
  assert.equal(responded, 0, 'API requests go straight to the network');
  await new Promise<void>(resolve => handlers.get('install')!({ waitUntil: (p: Promise<unknown>) => { void p.then(() => resolve()); } }));
  assert.ok(puts.length > 0 && puts.every(u => !u.includes('/api')), 'precache is shell only');
});

test('security headers: Telegram Web may frame the app, scripts stay same-origin', () => {
  assert.match(CSP, /frame-ancestors https:\/\/web\.telegram\.org(;|$)/);
  assert.match(CSP, /script-src 'self';/);
  assert.doesNotMatch(CSP, /telegram\.org.*script|unsafe-inline|unsafe-eval|\*/);
  assert.match(CSP, /object-src 'none'/);
});

test('manifest names the app and its icons for installation', async () => {
  const manifest = JSON.parse(await readFile('src/web/public/manifest.webmanifest', 'utf8'));
  assert.equal(manifest.display, 'standalone'); assert.equal(manifest.start_url, '/');
  assert.deepEqual(manifest.icons.map((i: { sizes: string }) => i.sizes).sort(), ['192x192', '512x512', '512x512']);
  assert.ok(manifest.icons.some((i: { purpose?: string }) => i.purpose === 'maskable'));
});

test('task 026: the service worker precaches exactly the font files fonts.css serves', async () => {
  const { puts } = await (async () => {
    const w = await loadWorker();
    await new Promise<void>(resolve => w.handlers.get('install')!({ waitUntil: (p: Promise<unknown>) => { void p.then(() => resolve()); } }));
    return w;
  })();
  const css = await readFile('src/web/fonts.css', 'utf8');
  const files = [...css.matchAll(/files\/((?:onest|source-serif-4)-[a-z-]+-\d+-normal\.woff2)/g)].map(m => '/assets/' + m[1]).sort();
  assert.equal(files.length, 16);
  assert.deepEqual(puts.filter(u => u.endsWith('.woff2')).sort(), files);
  assert.doesNotMatch(css, /https?:\/\//, 'no font CDN');
});
