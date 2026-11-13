// Task 027: throwaway synthetic demo on Railway. Pure checks (no I/O) shared by railway-predeploy.ts and
// railway-start.ts, unit tested in tests/railway.test.ts. Google Cloud (docs/DEPLOY.md) does not use this file.
//
// Railway gives the pre-deploy step and the web process the same variables, so both credentials are present:
//   DATABASE_URL      schema owner (Railway's Postgres admin user). Used only by the pre-deploy step.
//   APP_DATABASE_URL  clinora_app, DML only (task 024). The web process connects with this one; the start wrapper
//                     removes the owner credential and the demo password from process.env before the app loads.
import { parseTrustedHops } from './client-ip.js';

export const DEMO_DATABASE = 'clinora_staging';

/** Every variable the Railway web process reads at startup, with the value it must have. */
export const RAILWAY_START_VARIABLES: readonly (readonly [string, string])[] = [
  ['NODE_ENV', 'production'],
  ['APP_ENV', 'staging (this wrapper refuses anything else)'],
  ['APP_ORIGIN', 'https://<the Railway or custom domain>, no path'],
  ['COOKIE_SECURE', 'true'],
  ['TRUST_PROXY_HOPS', '1 (Railway edge; verified on the host)'],
  ['APP_DATABASE_URL', `postgresql://clinora_app:<password>@<host>:<port>/${DEMO_DATABASE}`],
  ['DATABASE_URL', `postgresql://<owner>:<password>@<host>:<port>/${DEMO_DATABASE} (removed before the app starts)`],
  ['ASSISTANT_SIMULATION', 'true (labelled simulated assistant; no provider keys)'],
  ['PORT', 'injected by Railway (image default 8080)'],
];
/** Real providers and Telegram stay off in the demo; their presence is a configuration mistake. */
export const RAILWAY_FORBIDDEN_VARIABLES = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'TELEGRAM_BOT_USERNAME',
  'AISHA_API_KEY', 'VERTEX_API_KEY', 'VERTEX_SERVICE_ACCOUNT_JSON'] as const;

type Env = Record<string, string | undefined>;
export type DbUrl = { user: string; password: string; host: string; port: string; database: string };

/** Parses a postgres URL without ever putting its text (which holds a password) into an error message. */
export function parseDbUrl(name: string, value: string | undefined): DbUrl {
  if (!value) throw new Error(`${name} is missing`);
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${name} is not a valid URL`); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error(`${name} must start with postgresql://`);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const parsed = { user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), host: url.hostname, port: url.port || '5432', database };
  if (!parsed.user || !parsed.password || !parsed.host) throw new Error(`${name} needs a user, a password and a host`);
  if (Object.values(parsed).some(v => v.includes('${{'))) throw new Error(`${name} contains an unresolved Railway reference`);
  if (parsed.database !== DEMO_DATABASE) throw new Error(`${name} must name the database ${DEMO_DATABASE}`);
  return parsed;
}

/** Owner and app URLs: same server and database, different users. Returns every problem, not just the first. */
export function checkDatabaseUrls(env: Env): { problems: string[]; owner: DbUrl | undefined; app: DbUrl | undefined } {
  const problems: string[] = [];
  let owner: DbUrl | undefined, app: DbUrl | undefined;
  try { owner = parseDbUrl('DATABASE_URL', env.DATABASE_URL); } catch (e) { problems.push((e as Error).message); }
  try { app = parseDbUrl('APP_DATABASE_URL', env.APP_DATABASE_URL); } catch (e) { problems.push((e as Error).message); }
  if (owner && app) {
    if (owner.host !== app.host || owner.port !== app.port) problems.push('DATABASE_URL and APP_DATABASE_URL must point at the same server');
    if (owner.user === app.user) problems.push('APP_DATABASE_URL must use its own login (clinora_app), not the owner');
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(app.user)) problems.push('APP_DATABASE_URL user must be a lowercase identifier such as clinora_app');
  }
  return { problems, owner, app };
}

export function checkPredeployEnv(env: Env): string[] {
  const problems = checkDatabaseUrls(env).problems;
  if (env.APP_ENV !== 'staging') problems.unshift('APP_ENV must be staging');
  return problems;
}

export function checkStartEnv(env: Env): string[] {
  const problems: string[] = [];
  if (env.NODE_ENV !== 'production') problems.push('NODE_ENV must be production');
  if (env.APP_ENV !== 'staging') problems.push('APP_ENV must be staging');
  try {
    const origin = new URL(env.APP_ORIGIN ?? '');
    if (origin.protocol !== 'https:' || origin.origin !== env.APP_ORIGIN) problems.push('APP_ORIGIN must be https://<host> with no path or trailing slash');
  } catch { problems.push('APP_ORIGIN is missing or not a URL (https://<host>)'); }
  if (env.COOKIE_SECURE !== 'true') problems.push('COOKIE_SECURE must be true');
  if (env.TRUST_PROXY_HOPS === undefined || env.TRUST_PROXY_HOPS === '') problems.push('TRUST_PROXY_HOPS is missing (1 behind Railway)');
  else { try { parseTrustedHops(env.TRUST_PROXY_HOPS); } catch (e) { problems.push((e as Error).message); } }
  if (env.ASSISTANT_SIMULATION !== 'true') problems.push('ASSISTANT_SIMULATION must be true in the demo');
  for (const name of RAILWAY_FORBIDDEN_VARIABLES) if (env[name]) problems.push(`${name} must not be set in the demo`);
  problems.push(...checkDatabaseUrls(env).problems);
  return problems;
}

/** The calendar date in Tashkent (UTC+5, no daylight saving) for a moment. */
export const tashkentDate = (now: Date) => new Date(now.getTime() + 5 * 3600_000).toISOString().slice(0, 10);
/** UTC instant of 00:00 in Tashkent on that date. */
export const tashkentMidnight = (date: string) => new Date(`${date}T00:00:00+05:00`);

export type DemoAction = { kind: 'none' } | { kind: 'seed' } | { kind: 'reset'; date: string } | { kind: 'stale-reset'; date: string };
/**
 * DEMO_ACTION: unset or empty = nothing; `seed` = seed when the database has no clinic yet;
 * `reset-YYYY-MM-DD` = wipe and reseed, only when that date is today in Tashkent (a reset left set from an earlier day
 * does nothing). The caller additionally skips a reset when today's seed already exists, so redeploys the same day
 * never wipe the demo twice.
 */
export function parseDemoAction(value: string | undefined, now: Date): DemoAction {
  const v = (value ?? '').trim();
  if (v === '') return { kind: 'none' };
  if (v === 'seed') return { kind: 'seed' };
  const m = /^reset-(\d{4}-\d{2}-\d{2})$/.exec(v);
  if (!m || Number.isNaN(tashkentMidnight(m[1]!).getTime())) throw new Error('DEMO_ACTION must be empty, seed, or reset-YYYY-MM-DD');
  return m[1] === tashkentDate(now) ? { kind: 'reset', date: m[1]! } : { kind: 'stale-reset', date: m[1]! };
}

/** Maintenance database on the same server, used only to create the demo database when it does not exist. */
export function maintenanceUrl(ownerUrl: string): string {
  const url = new URL(ownerUrl);
  url.pathname = '/postgres';
  return url.toString();
}

/** Variables the web process must not keep once it is running as clinora_app. */
export const STRIP_BEFORE_START = ['DATABASE_URL', 'APP_DATABASE_URL', 'DEMO_PASSWORD', 'DEMO_ACTION', 'CLINORA_APP_PASSWORD', 'PGPASSWORD', 'POSTGRES_PASSWORD'] as const;
