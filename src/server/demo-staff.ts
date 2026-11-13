// Synthetic staff for one clinic: one person per non-CEO role plus nine more doctors (ten in total, matching
// demo-catalog.ts). Shared by `npm run db:demo` and the task 017 full-day browser test so both exercise the
// same clinic shape. Every name is invented; the password hash is supplied by the caller and never printed.
import { randomUUID } from 'node:crypto';
import type { Tx } from './database.js';
import { Login, type Role } from '../modules/identity/roles.js';
import { DOCTORS } from './demo-catalog.js';

/** [role, login suffix, display name]. */
export const DEMO_STAFF: readonly [Exclude<Role, 'ceo'>, string, string][] = [
  ['administrator', 'admin', 'Синтетик Администратор'], ['registrar', 'registrar', 'Синтетик Регистратор'],
  ['doctor', 'doctor', DOCTORS[0]![1]], ['laboratory', 'lab', 'Синтетик Лаборант'], ['cashier', 'cashier', 'Синтетик Кассир'],
  ['inpatient', 'inpatient', 'Синтетик Стационар ходими'], ['pharmacy', 'pharmacy', 'Синтетик Дорихона ходими']
];
export type DemoStaff = { ids: Record<Exclude<Role, 'ceo'>, string>; doctorIds: string[]; logins: Record<string, string> };

async function member(tx: Tx, clinicId: string, granter: string, id: string, login: string, name: string, hash: string, role: Exclude<Role, 'ceo'>) {
  await tx.query('INSERT INTO accounts(id,login,display_name,password_hash,managed_by_clinic_id) VALUES($1,$2,$3,$4,$5)', [id, Login.parse(login), name, hash, clinicId]);
  await tx.query("INSERT INTO memberships(id,clinic_id,user_id,role,is_owner,clinical_access,patient_scope,status,granted_by) VALUES($1,$2,$3,$4,false,$5,'assigned','active',$6)",
    [randomUUID(), clinicId, id, role === 'doctor' ? 'clinician' : 'administrator', role === 'doctor', granter]);
  await tx.query('INSERT INTO membership_roles(clinic_id,user_id,role,granted_by) VALUES($1,$2,$3,$4)', [clinicId, id, role, granter]);
  await tx.query("INSERT INTO audit_events(id,actor_id,clinic_id,action,resource_id) VALUES($1,$2,$3,'synthetic.staff',$2)", [randomUUID(), id, clinicId]);
}

/** Adds the staff to an existing clinic whose CEO is `ceoId`. Logins are `<prefix>.<suffix>`, extra doctors `<prefix>.doctor2`…`doctor10`. */
export async function seedDemoStaff(tx: Tx, clinicId: string, ceoId: string, hash: string, prefix: string): Promise<DemoStaff> {
  const ids = {} as DemoStaff['ids'], logins: Record<string, string> = {};
  for (const [role, suffix, name] of DEMO_STAFF) {
    const id = randomUUID(); ids[role] = id; logins[suffix] = `${prefix}.${suffix}`;
    await member(tx, clinicId, ceoId, id, logins[suffix]!, name, hash, role);
  }
  const doctorIds = [ids.doctor];
  for (let i = 2; i <= DOCTORS.length; i++) {
    const id = randomUUID(); doctorIds.push(id); logins[`doctor${i}`] = `${prefix}.doctor${i}`;
    await member(tx, clinicId, ceoId, id, logins[`doctor${i}`]!, DOCTORS[i - 1]![1], hash, 'doctor');
  }
  return { ids, doctorIds, logins };
}
