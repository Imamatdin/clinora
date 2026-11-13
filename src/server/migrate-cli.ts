// Container entry point for the migration step (Cloud Run job). Runs before traffic shifts;
// a non-zero exit stops the deploy and leaves the previous revision serving.
// DATABASE_URL is the schema OWNER (migrator) connection. APP_DATABASE_URL, when set, names the
// application login: its role is created or updated with DML-only privileges and the same password,
// so rotating the app secret and re-running this job keeps both in step (task 024 role split).
// Prints only fixed messages: never a connection URL, password or SQL error text.
import { makePool, migrate, MigrationError, type MigrateOptions } from './database.js';

if (!process.env.DATABASE_URL) throw new Error('Explicit DATABASE_URL required');
const options: MigrateOptions = {};
if (process.env.APP_DATABASE_URL) {
  const app = new URL(process.env.APP_DATABASE_URL);
  options.appRole = { name: decodeURIComponent(app.username), password: decodeURIComponent(app.password) };
}
const pool = makePool(process.env.DATABASE_URL);
try {
  await migrate(pool, options);
  process.stdout.write(JSON.stringify({ severity: 'INFO', message: 'Migrations applied', appRole: options.appRole ? 'granted' : 'not_configured' }) + '\n');
} catch (error) {
  const code = error instanceof MigrationError ? error.code
    : error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown';
  const file = error instanceof MigrationError ? error.file : undefined;
  process.stdout.write(JSON.stringify({ severity: 'ERROR', message: 'Migration failed', code, file }) + '\n');
  process.exitCode = 1;
} finally { await pool.end().catch(() => {}); }
