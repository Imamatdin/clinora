// Dev helper (not a test): seed a persistent schema for profiling. Usage: node --import tsx tests/load/keep-seed.ts
import { makePool, migrate } from '../../src/server/database.js';
import { provisionOwner } from '../../src/server/provision.js';
import { seedHistory } from './seed.js';
const url=process.env.TEST_DATABASE_URL!,schema='clinora_test_'+'ab'.repeat(16);
const admin=makePool(url);await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.query(`CREATE SCHEMA "${schema}"`);
const pool=makePool(url,schema);await migrate(pool);
const owner=await provisionOwner(pool,{email:'owner@example.test',password:'Synthetic-password-123',name:'Owner',clinic:'Load',clinicalAccess:true});
const seed=await seedHistory(pool,owner.clinicId,owner.userId,Number(process.env.LOAD_DAYS??730));
console.log(JSON.stringify({schema,owner,seed:{...seed}}));
await pool.end();await admin.end();
