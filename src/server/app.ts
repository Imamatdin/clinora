import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { ERROR_STATUS, type ErrorCode } from '../contracts/index.js';
import { api, type ApiConfig } from './notebook.js';
import { DomainError } from '../modules/identity/access.js';

const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };
/** Installed-app files copied from src/web/public. A fixed list: nothing else at the root is served. */
const PUBLIC_FILES = ['sw.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png', 'icons/icon.svg'];
/**
 * Strict policy for every response. Only change for task 004: Telegram Web (web.telegram.org) may
 * frame the app so the Mini App works there. Scripts stay same-origin: the Telegram bridge is our own code.
 */
export const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors https://web.telegram.org";

export async function createApp(webDirectory?: string, config?: ApiConfig) {
  // Serve only built index and generated assets. Never expose source, env, data, or work/.
  const files = new Map<string, { body: Buffer; contentType: string }>();
  if (webDirectory) {
    files.set('/', { body: await readFile(join(webDirectory, 'index.html')), contentType: mime['.html']! });
    for (const name of await readdir(join(webDirectory, 'assets'))) {
      if (!/^[a-zA-Z0-9_.-]+\.(js|css)$/.test(name)) continue;
      files.set('/assets/' + name, { body: await readFile(join(webDirectory, 'assets', name)), contentType: mime[extname(name)]! });
    }
    for (const name of PUBLIC_FILES) {
      const body = await readFile(join(webDirectory, name)).catch(() => null);
      if (body) files.set('/' + name, { body, contentType: mime[extname(name)]! });
    }
  }
  const server = createServer(async (req, res) => {
    const requestId = randomUUID();
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', CSP);
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(value));
    };
    const fail = (code: ErrorCode) => json(ERROR_STATUS[code], { error: { code, message: code, requestId } });
    const path = (req.url ?? '/').split('?')[0]!;
    if (path === '/api/health' && ['GET', 'HEAD'].includes(req.method ?? '')) {
      try {
        if (config) await config.pool.query('SELECT 1');
        json(200, { service: 'clinora', increment: config ? 1 : 0, status: 'ok', clinicalStorage: config ? 'postgresql' : 'not_implemented', authentication: config ? 'server_sessions' : 'not_implemented', integrations: 'unavailable', telegram: config?.telegram ? 'configured' : 'not_configured' });
      } catch { fail('SERVICE_UNAVAILABLE'); }
    } else if (path === '/api' || path.startsWith('/api/')) {
      if (!config) { fail('UNAUTHENTICATED'); return; }
      try {
        const result = await api(req, config);
        if (result.cookie) res.setHeader('Set-Cookie', result.cookie);
        json(result.status ?? 200, result.body);
      } catch (error) {
        if (error instanceof DomainError) fail(error.code);
        else if (error && typeof error === 'object' && 'code' in error && error.code === '23505') fail('INVALID_INPUT');
        else fail('SERVICE_UNAVAILABLE'); // Never expose SQL or clinical values.
      }
    } else if (['GET', 'HEAD'].includes(req.method ?? '') && files.has(path)) {
      const file = files.get(path)!;
      res.writeHead(200, { 'Content-Type': file.contentType });
      res.end(req.method === 'HEAD' ? undefined : file.body);
    } else fail('NOT_FOUND');
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}
