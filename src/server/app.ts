import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { ERROR_STATUS, type ErrorCode } from '../contracts/index.js';
import { api, type ApiConfig } from './notebook.js';
import { DomainError } from '../modules/identity/access.js';

const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

export async function createApp(webDirectory?: string, config?: ApiConfig) {
  // Serve only built index and generated assets. Never expose source, env, data, or work/.
  const files = new Map<string, { body: Buffer; contentType: string }>();
  if (webDirectory) {
    files.set('/', { body: await readFile(join(webDirectory, 'index.html')), contentType: mime['.html']! });
    for (const name of await readdir(join(webDirectory, 'assets'))) {
      if (!/^[a-zA-Z0-9_.-]+\.(js|css)$/.test(name)) continue;
      files.set('/assets/' + name, { body: await readFile(join(webDirectory, 'assets', name)), contentType: mime[extname(name)]! });
    }
  }
  const server = createServer(async (req, res) => {
    const requestId = randomUUID();
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(value));
    };
    const fail = (code: ErrorCode) => json(ERROR_STATUS[code], { error: { code, message: code, requestId } });
    const path = (req.url ?? '/').split('?')[0]!;
    if (path === '/api/health' && ['GET', 'HEAD'].includes(req.method ?? '')) {
      try {
        if (config) await config.pool.query('SELECT 1');
        json(200, { service: 'clinora', increment: config ? 1 : 0, status: 'ok', clinicalStorage: config ? 'postgresql' : 'not_implemented', authentication: config ? 'server_sessions' : 'not_implemented', integrations: 'unavailable' });
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
