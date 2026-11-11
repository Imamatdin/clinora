import { makePool, migrate } from '../src/server/database.ts';
import { provisionOwner } from '../src/server/provision.ts';

if (!process.env.DATABASE_URL) throw new Error('Explicit DATABASE_URL required');
const pool = makePool(process.env.DATABASE_URL);
try {
  if (process.argv[2] === 'migrate') { await migrate(pool); console.log('Migrations applied.'); }
  else if (process.argv[2] === 'bootstrap') {
    for (const key of ['BOOTSTRAP_EMAIL','BOOTSTRAP_PASSWORD','BOOTSTRAP_NAME','BOOTSTRAP_CLINIC']) if (!process.env[key]) throw new Error(`${key} is required`);
    await provisionOwner(pool, { email: process.env.BOOTSTRAP_EMAIL, password: process.env.BOOTSTRAP_PASSWORD,
      name: process.env.BOOTSTRAP_NAME, clinic: process.env.BOOTSTRAP_CLINIC, clinicalAccess: process.env.BOOTSTRAP_CLINICAL === 'true' });
    console.log('Owner provisioned. No professional verification was asserted.');
  } else throw new Error('Use migrate or bootstrap');
} finally { await pool.end(); }
