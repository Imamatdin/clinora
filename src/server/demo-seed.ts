// Seeds the synthetic demonstration clinic (demo-clinic.ts). Every login shares DEMO_PASSWORD, which is supplied
// privately and never printed. Runs locally via `npm run db:demo` and in staging as the compiled
// `dist/server/server/demo-seed.js`. On Railway the pre-deploy step seeds instead (railway-predeploy.ts).
import { makePool, migrate } from './database.js';
import { demoGuard } from './demo-guard.js';
import { seedDemoClinic } from './demo-clinic.js';

demoGuard(process.env);
const pool = makePool(process.env.DATABASE_URL!);
try {
  await migrate(pool);
  const { logins, catalog, day } = await seedDemoClinic(pool, process.env.DEMO_PASSWORD!, process.env.DEMO_LOGIN_PREFIX ?? 'demo');
  console.log(`Synthetic clinic provisioned with one login per role: ${logins.join(', ')}. Password not printed.`);
  console.log(`Synthetic catalog: ${JSON.stringify(catalog)}.`);
  console.log(`Synthetic clinic day (open): ${JSON.stringify(day)}.`);
} finally { await pool.end(); }
