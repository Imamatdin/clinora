// Container entry point for the migration step (Cloud Run job). Runs before traffic shifts;
// a non-zero exit stops the deploy and leaves the previous revision serving.
// Prints only a fixed message: never the connection URL or SQL error text.
import { makePool, migrate } from './database.js';

if (!process.env.DATABASE_URL) throw new Error('Explicit DATABASE_URL required');
const pool = makePool(process.env.DATABASE_URL);
try {
  await migrate(pool);
  process.stdout.write(JSON.stringify({ severity: 'INFO', message: 'Migrations applied' }) + '\n');
} catch (error) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code)
    : error instanceof Error && error.message === 'Applied migration changed' ? 'applied_migration_changed' : 'unknown';
  process.stdout.write(JSON.stringify({ severity: 'ERROR', message: 'Migration failed', code }) + '\n');
  process.exitCode = 1;
} finally { await pool.end().catch(() => {}); }
