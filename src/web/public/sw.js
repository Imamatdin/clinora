/*
 * Clinora service worker: caches the app shell only (the page, built JS/CSS, manifest, icons).
 * API responses are never intercepted or stored, so no patient data lands in a browser cache.
 */
const CACHE = 'clinora-shell-v2';
/** Task 026: the bundled Onest font (src/web/fonts.css), precached so the installed app keeps its type offline. */
const FONTS = ['cyrillic', 'cyrillic-ext', 'latin', 'latin-ext'].flatMap(subset => [400, 500, 700].map(weight => `/assets/onest-${subset}-${weight}-normal.woff2`));
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', ...FONTS];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

/** Exported for the unit test through the global scope; decides whether a request may touch the cache. */
function shellRequest(request) {
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return null;
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return null;
  if (request.mode === 'navigate' || url.pathname === '/') return 'page';
  if (/^\/assets\/[A-Za-z0-9_.-]+\.(js|css|woff2)$/.test(url.pathname) || SHELL.includes(url.pathname)) return 'static';
  return null;
}
self.shellRequest = shellRequest;

self.addEventListener('fetch', event => {
  const kind = shellRequest(event.request);
  if (!kind) return; // Network only; the browser handles it as if there were no service worker.
  if (kind === 'page') {
    // Network first so a deploy is picked up at once; the cached shell is the offline fallback.
    event.respondWith(fetch(event.request).then(response => {
      if (response.ok) { const copy = response.clone(); event.waitUntil(caches.open(CACHE).then(cache => cache.put('/', copy))); }
      return response;
    }).catch(() => caches.match('/').then(cached => cached || Response.error())));
    return;
  }
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
    if (response.ok) { const copy = response.clone(); event.waitUntil(caches.open(CACHE).then(cache => cache.put(event.request, copy))); }
    return response;
  })));
});
