// Task 027: Railway pre-deploy step (Railway runs it before each new deployment takes traffic; non-zero exit = the
// deployment is abandoned and the previous one keeps serving). Image is distroless, so the command is exec form:
//   /nodejs/bin/node dist/server/server/railway-predeploy.js
// 1. checks the variables, 2. creates the clinora_staging database if missing, 3. optionally wipes it for a fresh demo
// day, 4. migrates as the owner and leaves clinora_app DML-only, 5. optionally seeds the synthetic clinic.
// Prints fixed JSON lines only: never a URL, password or SQL error text.
import pg from 'pg';
import { makePool, migrate, MigrationError } from './database.js';
import { demoGuard } from './demo-guard.js';
import { seedDemoClinic } from './demo-clinic.js';
import { checkPredeployEnv, checkDatabaseUrls, maintenanceUrl, parseDemoAction, tashkentMidnight, DEMO_DATABASE } from './railway.js';

const log = (severity: 'INFO' | 'WARNING' | 'ERROR', message: string, fields: object = {}) =>
  process.stdout.write(JSON.stringify({ severity, message, ...fields }) + '\n');
const fail = (message: string, fields: object = {}) => { log('ERROR', message, fields); process.exit(1); };

const env = process.env;
const problems = checkPredeployEnv(env);
if (problems.length) fail('Railway pre-deploy: fix these variables', { problems });
let action: ReturnType<typeof parseDemoAction>;
try { action = parseDemoAction(env.DEMO_ACTION, new Date()); } catch (e) { fail('Railway pre-deploy: bad DEMO_ACTION', { problem: (e as Error).message }); }
if (action!.kind === 'seed' || action!.kind === 'reset') {
  try { demoGuard(env); } catch (e) { fail('Railway pre-deploy: demo seeding refused', { problem: (e as Error).message }); }
}
const { app } = checkDatabaseUrls(env);

const code = (error: unknown) => error instanceof MigrationError ? error.code
  : error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : 'unknown';

// 2. The database. Railway's Postgres starts with only `railway` and `postgres`; the demo guard seeds only clinora_staging.
{
  const admin = new pg.Client({ connectionString: maintenanceUrl(env.DATABASE_URL!), connectionTimeoutMillis: 10000 });
  admin.on('error', () => {});
  try {
    await admin.connect();
    if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [DEMO_DATABASE])).rowCount) {
      await admin.query(`CREATE DATABASE "${DEMO_DATABASE}"`); // constant identifier, not input
      log('INFO', 'Database created', { database: DEMO_DATABASE });
    }
  } catch (error) { fail('Railway pre-deploy: could not reach or create the database', { code: code(error) }); }
  finally { await admin.end().catch(() => {}); }
}

const pool = makePool(env.DATABASE_URL!);
try {
  // 3. Fresh demo day: wipe everything in clinora_staging (synthetic only), at most once per Tashkent day.
  if (action!.kind === 'stale-reset') log('WARNING', 'DEMO_ACTION reset date is not today in Tashkent; nothing reset. Clear the variable.', { date: action!.date });
  if (action!.kind === 'reset') {
    const seeded = (await pool.query(`SELECT max(created_at) at FROM audit_events WHERE action='synthetic.staff'`).catch(() => ({ rows: [{ at: null }] }))).rows[0]?.at as Date | null;
    if (seeded && seeded >= tashkentMidnight(action!.date)) log('INFO', 'Demo already reset today; skipped', { date: action!.date });
    else {
      await pool.query('DROP SCHEMA public CASCADE');
      await pool.query('CREATE SCHEMA public');
      log('INFO', 'Demo database wiped for a fresh demo day', { date: action!.date });
    }
  }
  // 4. Schema as the owner; clinora_app is created or updated with DML only and the password from APP_DATABASE_URL.
  await migrate(pool, { appRole: { name: app!.user, password: app!.password } });
  log('INFO', 'Migrations applied', { appRole: 'granted' });
  // 5. Seed once. A database that already has a clinic is never seeded again, so leaving DEMO_ACTION=seed is harmless.
  if (action!.kind === 'seed' || action!.kind === 'reset') {
    const clinics = Number((await pool.query('SELECT count(*)::int n FROM clinics')).rows[0].n);
    if (clinics > 0) log('INFO', 'Database already has a clinic; seed skipped', { clinics });
    else {
      const { logins, day } = await seedDemoClinic(pool, env.DEMO_PASSWORD!, env.DEMO_LOGIN_PREFIX ?? 'demo');
      log('INFO', 'Synthetic clinic seeded; password not printed', { logins: logins.length, day });
    }
  }
} catch (error) {
  log('ERROR', 'Railway pre-deploy failed', { code: code(error), file: error instanceof MigrationError ? error.file : undefined });
  process.exitCode = 1;
} finally { await pool.end().catch(() => {}); }
