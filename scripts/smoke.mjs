import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';

// Ask the OS for a free loopback port. Fail rather than connecting to someone else's app.
const probe = createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const child = spawn(process.execPath, ['dist/server/server/main.js'], {
  env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe']
});
let output = '';
child.stdout.on('data', chunk => { output += chunk; });
child.stderr.on('data', chunk => { output += chunk; });
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Built server startup timed out')), 10000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`Built server exited: ${code}`)); });
    child.stdout.on('data', () => { if (output.includes('Clinora foundation:')) { clearTimeout(timer); resolve(); } });
  });
  const base = `http://127.0.0.1:${port}`;
  const response = await fetch(base);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Clinora/);
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map(m => m[1]);
  assert.ok(assets.some(asset => asset.endsWith('.js')));
  assert.ok(assets.some(asset => asset.endsWith('.css')));
  for (const asset of assets) assert.equal((await fetch(base + asset)).status, 200);
  assert.equal((await (await fetch(base + '/api/health')).json()).increment, 0);
  assert.equal((await fetch(base + '/.env')).status, 404);
  for (const file of ['/sw.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png']) assert.equal((await fetch(base + file)).status, 200, file);
  // Task 026: the self-hosted font is served same-origin with its type, as the service worker precaches it.
  const font = await fetch(base + '/assets/onest-cyrillic-ext-700-normal.woff2');
  assert.equal(font.status, 200, 'font'); assert.equal(font.headers.get('content-type'), 'font/woff2');
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors https:\/\/web\.telegram\.org/);
  assert.equal((await fetch(base + '/telegram-web-app.js')).status, 404);
  assert.equal((await fetch(base + '/api/telegram/webhook', { method: 'POST' })).status, 401);
  assert.equal((await fetch(base + '/api/documents/export')).status, 401);
  console.log('Built server, HTML, JS/CSS assets, PWA files, CSP, health, source isolation and clinical denial: PASS');
} finally {
  child.kill();
  if (child.exitCode === null) await once(child, 'exit');
}
