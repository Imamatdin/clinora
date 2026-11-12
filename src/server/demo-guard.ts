// Decides whether synthetic demo seeding may run. Pure: no I/O, so it is unit tested directly.
// Allowed targets: a loopback clinora_local/clinora_test database, or the staging database
// (clinora_staging) when APP_ENV=staging. Always refused when APP_ENV=production, and refused
// when NODE_ENV=production without an explicit APP_ENV (fail closed).
export function demoGuard(env: Record<string, string | undefined>): { host: string; database: string } {
  const appEnv = env.APP_ENV;
  if (appEnv === 'production') throw new Error('Synthetic demo seeding is forbidden when APP_ENV=production');
  if (env.NODE_ENV === 'production' && appEnv !== 'staging') throw new Error('NODE_ENV=production requires APP_ENV=staging for demo seeding');
  if (env.ALLOW_SYNTHETIC_DEMO !== 'true') throw new Error('Synthetic setup requires ALLOW_SYNTHETIC_DEMO=true');
  for (const key of ['DATABASE_URL', 'DEMO_PASSWORD']) if (!env[key]) throw new Error(`${key} required; no default credentials`);
  const match = /^postgres(?:ql)?:\/\/(?:[^@/]*@)?([^/?#]*)\/([^?#]+)(?:\?(.*))?$/.exec(env.DATABASE_URL!);
  if (!match) throw new Error('DATABASE_URL is not a PostgreSQL URL');
  const hostPort = match[1]!, database = decodeURIComponent(match[2]!);
  const socket = new URLSearchParams(match[3] ?? '').get('host');
  const host = socket ?? hostPort.replace(/^\[|\](?=:|$)/g, '').replace(/:\d+$/, '');
  const local = ['127.0.0.1', 'localhost', '::1'].includes(host) && ['clinora_local', 'clinora_test'].includes(database);
  const staging = appEnv === 'staging' && database === 'clinora_staging';
  if (!local && !staging) throw new Error('Demo requires a loopback clinora_local/clinora_test database, or clinora_staging with APP_ENV=staging');
  return { host, database };
}
