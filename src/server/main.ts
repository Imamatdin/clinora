import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { makePool } from './database.js';
import { telegramConfigFromEnv } from '../modules/telegram/api.js';

const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535');
const webDirectory = fileURLToPath(new URL('../../web/', import.meta.url));
const compiled = import.meta.url.endsWith('.js');
const databaseUrl = process.env.DATABASE_URL;
const origin = process.env.APP_ORIGIN ?? `http://127.0.0.1:${port}`;
const secureCookies = process.env.COOKIE_SECURE === 'true';
if (process.env.NODE_ENV === 'production' && (!databaseUrl || !secureCookies || !origin.startsWith('https://'))) {
  throw new Error('Production requires DATABASE_URL, HTTPS APP_ORIGIN and COOKIE_SECURE=true');
}
// Bot token and webhook secret come from the environment only; startup fails on a partial or malformed set.
const telegram = telegramConfigFromEnv(process.env);
if (telegram && process.env.NODE_ENV === 'production' && !origin.startsWith('https://')) throw new Error('Telegram requires an HTTPS APP_ORIGIN');
const pool = databaseUrl ? makePool(databaseUrl) : undefined;
const server = await createApp(compiled ? webDirectory : undefined, pool ? { pool, origin, secureCookies, telegram } : undefined);
server.listen(port, '127.0.0.1', () => console.log(`Clinora foundation: http://127.0.0.1:${port}`));
// No request bodies, query strings, cookies, patient identifiers, or provider secrets are logged.
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close(() => { void pool?.end(); }));
