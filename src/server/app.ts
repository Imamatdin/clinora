import { ROLES } from '../modules/identity/roles.js';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { ERROR_STATUS, type ErrorCode } from '../contracts/index.js';
import { api, type ApiConfig } from './notebook.js';
import { PayrollRulesMissing } from '../modules/payroll/actions.js';
import { LoginLimited } from '../modules/login/actions.js';
import { DomainError } from '../modules/identity/access.js';
import { isRuleViolation, migrationsCurrent, RULE_VIOLATION_MESSAGE } from './database.js';

// One structured line per request. Only method, a de-identified route shape, status and timing:
// no query strings, bodies, cookies, headers, client addresses or record identifiers.
export type AccessLog = { requestId: string; method: string; route: string; status: number; durationMs: number };
export type AppOptions = { log?: (entry: AccessLog) => void };
export const routeShape = (path: string) => path.slice(0, 200)
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
  .replace(/\/[0-9]+(?=\/|$)/g, '/:n')
  .replace(/[^a-zA-Z0-9/_.:-]/g, '?');
import { handleAssistant, startAssistantHousekeeping } from './assistant.js';
import { startReportWorker } from '../modules/reports/notify.js';

const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };
/** Installed-app files copied from src/web/public. A fixed list: nothing else at the root is served. */
const PUBLIC_FILES = ['sw.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png', 'icons/icon.svg',
  'ticket.css', 'ticket.js', ...ROLES.map(r => `help/${r}.png`)];
/**
 * Strict policy for every response. Only change for task 004: Telegram Web (web.telegram.org) may
 * frame the app so the Mini App works there. Scripts stay same-origin: the Telegram bridge is our own code.
 */
export const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors https://web.telegram.org";

export async function createApp(webDirectory?: string, config?: ApiConfig, options: AppOptions = {}) {
  if (config) startAssistantHousekeeping(config);
  // Serve only built index and generated assets. Never expose source, env, data, or work/.
  const files = new Map<string, { body: Buffer; contentType: string }>();
  if (webDirectory) {
    files.set('/', { body: await readFile(join(webDirectory, 'index.html')), contentType: mime['.html']! });
    // Task 017: printable cheat sheets are the same app page at /help/<role>.
    for (const role of ROLES) files.set(`/help/${role}`, files.get('/')!);
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
    const requestId = randomUUID(), started = process.hrtime.bigint();
    if (options.log) res.on('finish', () => options.log!({ requestId, method: (req.method ?? '').slice(0, 10), route: routeShape((req.url ?? '/').split('?')[0]!),
      status: res.statusCode, durationMs: Number((process.hrtime.bigint() - started) / 1000000n) }));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    // HTTPS deployments only (secure cookies imply HTTPS origin). No includeSubDomains: other
    // clinoraa.uz hosts are not ours to pin. No preload: that is a separate, sticky decision.
    if (config?.secureCookies) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    res.setHeader('Content-Security-Policy', CSP);
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(value));
    };
    const fail = (code: ErrorCode) => json(ERROR_STATUS[code], { error: { code, message: code, requestId } });
    const path = (req.url ?? '/').split('?')[0]!;
    const probe = ['GET', 'HEAD'].includes(req.method ?? '');
    if (path === '/healthz' && probe) {
      json(200, { status: 'ok' }); // Process is up. Deliberately no database call (liveness).
    } else if (path === '/readyz' && probe) {
      // Startup probe: database reachable and every migration in this build applied.
      // A failing new revision never receives traffic; the previous revision keeps serving.
      try {
        if (!config) { json(503, { status: 'not_ready', reason: 'no_database' }); return; }
        await config.pool.query('SELECT 1');
        if (!await migrationsCurrent(config.pool)) { json(503, { status: 'not_ready', reason: 'migrations_pending' }); return; }
        json(200, { status: 'ready' });
      } catch { json(503, { status: 'not_ready', reason: 'database_unreachable' }); }
    } else if (path === '/api/health' && ['GET', 'HEAD'].includes(req.method ?? '')) {
      try {
        if (config) await config.pool.query('SELECT 1');
        json(200, { service: 'clinora', increment: config ? 1 : 0, status: 'ok', clinicalStorage: config ? 'postgresql' : 'not_implemented', authentication: config ? 'server_sessions' : 'not_implemented', integrations: 'unavailable', telegram: config?.telegram ? 'configured' : 'not_configured' });
      } catch { fail('SERVICE_UNAVAILABLE'); }
    } else if (path === '/api' || path.startsWith('/api/')) {
      if (!config) { fail('UNAUTHENTICATED'); return; }
      if (await handleAssistant(req, res, config, requestId)) return; // Task 003C doctor assistant routes.
      try {
        const result = await api(req, config);
        if (result.cookie) res.setHeader('Set-Cookie', result.cookie);
        if (result.html !== undefined) { // Server-rendered print pages (queue tickets); same CSP as everything else.
          res.writeHead(result.status ?? 200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(req.method === 'HEAD' ? undefined : result.html);
        } else if (result.file !== undefined) { // Server-rendered files (prescription PDF).
          res.writeHead(200, { 'Content-Type': result.file.contentType, 'Content-Length': result.file.data.length,
            'Content-Disposition': `inline; filename="${result.file.filename.replace(/[^a-zA-Z0-9._-]/g, '')}"` });
          res.end(req.method === 'HEAD' ? undefined : result.file.data);
        } else json(result.status ?? 200, result.body);
      } catch (error) {
        if (error instanceof LoginLimited) {
          res.setHeader('Retry-After', String(Math.max(1, Math.ceil((Date.parse(error.unlockAt) - Date.now()) / 1000))));
          json(429, { error: { code: error.code, message: error.code, requestId, unlockAt: error.unlockAt } });
        } else if (error instanceof PayrollRulesMissing) {
          json(409,{error:{code:error.code,message:'PAYROLL_RULES_MISSING',doctors:error.doctors,requestId}});
        } else if (error instanceof DomainError) fail(error.code);
        else if (error && typeof error === 'object' && 'code' in error && error.code === '23505') fail('INVALID_INPUT');
        else if (isRuleViolation(error)) json(409, { error: { code: 'INVALID_TRANSITION', message: RULE_VIOLATION_MESSAGE, requestId } });
        else fail('SERVICE_UNAVAILABLE'); // Never expose SQL or clinical values.
      }
    } else if (['GET', 'HEAD'].includes(req.method ?? '') && files.has(path)) {
      const file = files.get(path)!;
      res.writeHead(200, { 'Content-Type': file.contentType });
      res.end(req.method === 'HEAD' ? undefined : file.body);
    } else fail('NOT_FOUND');
  });
  if(config){const stop=startReportWorker(config);server.once('close',stop);}
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}
