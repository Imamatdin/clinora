import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { Password } from '../contracts/notebook.js';
import { transaction } from './database.js';
import { passwordHash } from './security.js';
import { Registration } from '../contracts/index.js';

/** Local owner provisioning only. Not exposed as an HTTP route. No default credentials. */
export async function provisionOwner(pool: pg.Pool, input: { email: string; password: string; name: string; clinic: string; clinicalAccess: boolean }) {
  Registration.parse({ email: input.email, displayName: input.name }); Password.parse(input.password);
  if (!input.clinic.trim()) throw new Error('Clinic name required');
  const hash = await passwordHash(input.password);
  return transaction(pool, async tx => {
    const userId = randomUUID(), clinicId = randomUUID();
    await tx.query('INSERT INTO accounts(id,email,display_name,password_hash) VALUES($1,$2,$3,$4)', [userId,input.email.toLowerCase(),input.name,hash]);
    await tx.query('INSERT INTO clinics(id,name) VALUES($1,$2)', [clinicId,input.clinic]);
    await tx.query("INSERT INTO memberships(id,clinic_id,user_id,role,is_owner,clinical_access,patient_scope,status,granted_by) VALUES($1,$2,$3,'administrator',true,$4,'clinic','active',$3)", [randomUUID(),clinicId,userId,input.clinicalAccess]);
    await tx.query('INSERT INTO audit_events(id,actor_id,clinic_id,action,resource_id) VALUES($1,$2,$3,\'owner.provisioned\',$2)', [randomUUID(),userId,clinicId]);
    return { userId, clinicId };
  });
}
