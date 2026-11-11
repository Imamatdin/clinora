import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { ERROR_STATUS, type ErrorCode } from '../contracts/index.js';

const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

export async function createApp(webDirectory?: string) {
  // Serve only built index and generated assets. Never expose source, env, data, or work/.
  const files = new Map<string, { body: Buffer; contentType: string }>();
  if (webDirectory) {
    files.set('/', { body: await readFile(join(webDirectory, 'index.html')), contentType: mime['.html']! });
    for (const name of await readdir(join(webDirectory, 'assets'))) {
      if (!/^[a-zA-Z0-9_.-]+\.(js|css)$/.test(name)) continue;
      files.set('/assets/' + name, { body: await readFile(join(webDirectory, 'assets', name)), contentType: mime[extname(name)]! });
    }
  }
  return createServer((req, res) => {
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
      json(200, { service: 'clinora', increment: 0, status: 'ok', clinicalStorage: 'not_implemented', authentication: 'not_implemented', integrations: 'unavailable' });
    } else if (path === '/api' || path.startsWith('/api/')) {
      // No auth adapter exists yet. Tokens, cookies and claimed roles never grant access.
      fail('UNAUTHENTICATED');
    } else if (['GET', 'HEAD'].includes(req.method ?? '') && files.has(path)) {
      const file = files.get(path)!;
      res.writeHead(200, { 'Content-Type': file.contentType });
      res.end(req.method === 'HEAD' ? undefined : file.body);
    } else fail('NOT_FOUND');
  });
}
