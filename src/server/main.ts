import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { makePool } from './database.js';
import { telegramConfigFromEnv } from '../modules/telegram/api.js';
import { parseTrustedHops } from './client-ip.js';

const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535');
// Loopback by default. Containers set HOST=0.0.0.0 explicitly (Dockerfile) because the platform
// proxy connects from outside the container's loopback interface.
const host = process.env.HOST ?? '127.0.0.1';
if (!['127.0.0.1', '::1', '0.0.0.0', '::'].includes(host)) throw new Error('HOST must be 127.0.0.1, ::1, 0.0.0.0 or ::');
const webDirectory = fileURLToPath(new URL('../../web/', import.meta.url));
const compiled = import.meta.url.endsWith('.js');
const databaseUrl = process.env.DATABASE_URL;
const origin = process.env.APP_ORIGIN ?? `http://127.0.0.1:${port}`;
const secureCookies = process.env.COOKIE_SECURE === 'true';
const appEnv = process.env.APP_ENV ?? 'development';
if (!['development', 'test', 'staging', 'production'].includes(appEnv)) throw new Error('APP_ENV must be development, test, staging or production');
const trustProxyHops = parseTrustedHops(process.env.TRUST_PROXY_HOPS);
const deployed = process.env.NODE_ENV === 'production' || appEnv === 'staging' || appEnv === 'production';
if (deployed && (!databaseUrl || !secureCookies || !origin.startsWith('https://'))) {
  throw new Error('Deployed environments require DATABASE_URL, HTTPS APP_ORIGIN and COOKIE_SECURE=true');
}
// Bot token and webhook secret come from the environment only; startup fails on a partial or malformed set.
const telegram = telegramConfigFromEnv(process.env);
if (telegram && deployed && !origin.startsWith('https://')) throw new Error('Telegram requires an HTTPS APP_ORIGIN');
// Structured JSON lines (Cloud Logging reads `severity` and `message`). See app.ts AccessLog for
// the allowlisted fields. No request bodies, query strings, cookies, IPs, patient identifiers or secrets.
const log = (severity: string, message: string, fields: object = {}) =>
  process.stdout.write(JSON.stringify({ severity, message, ...fields }) + '\n');
const pool = databaseUrl ? makePool(databaseUrl) : undefined;
const server = await createApp(compiled ? webDirectory : undefined, pool ? { pool, origin, secureCookies, telegram, trustProxyHops } : undefined,
  deployed ? { log: entry => log(entry.status >= 500 ? 'ERROR' : 'INFO', 'request', entry) } : {});
server.listen(port, host, () => {
  if (deployed) log('INFO', 'Clinora started', { appEnv, port, trustProxyHops });
  else console.log(`Clinora foundation: http://${host}:${port}`);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  // Cloud Run sends SIGTERM and allows 10 s. Finish in-flight requests, then exit.
  setTimeout(() => process.exit(0), 8000).unref();
  server.close(() => { void (pool ? pool.end().catch(() => {}) : Promise.resolve()).finally(() => process.exit(0)); });
  server.closeIdleConnections();
});
