// CI-only provisioning exercise. Every credential is generated in memory and never printed.
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { makePool } from '../src/server/database.ts';
if(!process.env.TEST_DATABASE_URL||new URL(process.env.TEST_DATABASE_URL).pathname!=='/clinora_test')throw new Error('Dedicated test database required');
const run=promisify(execFile),password='Synthetic-'+randomUUID();
const env={...process.env,DATABASE_URL:process.env.TEST_DATABASE_URL,NODE_ENV:'test',ALLOW_SYNTHETIC_DEMO:'true',DEMO_EMAIL:'demo-'+randomUUID()+'@example.test',DEMO_PASSWORD:password};
await run(process.execPath,['--import','tsx','scripts/demo.mjs'],{env});
await run(process.execPath,['--import','tsx','scripts/database.mjs','migrate'],{env});
const pool=makePool(env.DATABASE_URL);
try {const count=await pool.query('SELECT count(*) FROM patients');if(Number(count.rows[0].count)<1)throw new Error('Demo did not persist');console.log('Explicit synthetic demo provisioning and repeat migration: PASS');}
finally{await pool.end();}
