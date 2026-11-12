// Synthetic demonstration clinic: one staff member per role (ten doctors), the full catalog shape from
// demo-catalog.ts, and one fictional patient routed to the first doctor.
// Every login shares DEMO_PASSWORD, which is supplied privately and never printed.
// Runs locally via `npm run db:demo` and in staging as the compiled `dist/server/server/demo-seed.js`.
import { randomUUID } from 'node:crypto';
import { makePool, migrate, transaction } from './database.js';
import { passwordHash } from './security.js';
import { Password } from '../contracts/notebook.js';
import { Encounter } from '../contracts/index.js';
import { Login, ROLES } from '../modules/identity/roles.js';
import { demoGuard } from './demo-guard.js';
import { DOCTORS, seedDemoCatalog } from './demo-catalog.js';
import { seedAssistantDemo } from '../modules/assistant/demo.js';

demoGuard(process.env);
Password.parse(process.env.DEMO_PASSWORD);
const prefix = process.env.DEMO_LOGIN_PREFIX ?? 'demo';
const staff: [string, string][] = [
  ['ceo', 'Синтетик Раҳбар'], ['administrator', 'Синтетик Администратор'], ['registrar', 'Синтетик Регистратор'],
  ['doctor', DOCTORS[0]![1]], ['laboratory', 'Синтетик Лаборант'], ['cashier', 'Синтетик Кассир'], ['inpatient', 'Синтетик Стационар ходими'], ['pharmacy', 'Синтетик Дорихона ходими']
];
if (staff.map(s => s[0]).join() !== ROLES.join()) throw new Error('Demo must cover every role');
const pool = makePool(process.env.DATABASE_URL!);
let catalog: unknown;
try {
  await migrate(pool);
  const hash = await passwordHash(process.env.DEMO_PASSWORD!);
  const logins = await transaction(pool, async tx => {
    const clinicId = randomUUID(), ids: Record<string, string> = {};
    await tx.query('INSERT INTO clinics(id,name) VALUES($1,$2)', [clinicId, 'Синтетик демо клиника']);
    for (const [role, name] of staff) {
      const id = randomUUID(), login = Login.parse(`${prefix}.${role === 'administrator' ? 'admin' : role === 'laboratory' ? 'lab' : role}`); ids[role] = id;
      await tx.query('INSERT INTO accounts(id,login,display_name,password_hash,managed_by_clinic_id) VALUES($1,$2,$3,$4,$5)', [id, login, name, hash, clinicId]);
      const granter = ids.ceo;
      await tx.query("INSERT INTO memberships(id,clinic_id,user_id,role,is_owner,clinical_access,patient_scope,status,granted_by) VALUES($1,$2,$3,$4,$5,$6,'assigned','active',$7)",
        [randomUUID(), clinicId, id, role === 'doctor' ? 'clinician' : 'administrator', role === 'ceo', role === 'doctor', granter]);
      await tx.query('INSERT INTO membership_roles(clinic_id,user_id,role,granted_by) VALUES($1,$2,$3,$4)', [clinicId, id, role, granter]);
      await tx.query("INSERT INTO audit_events(id,actor_id,clinic_id,action,resource_id) VALUES($1,$2,$3,'synthetic.staff',$2)", [randomUUID(), id, clinicId]);
    }
    // Nine more doctors (ten in total), each with a profile, services, split rule and queue point.
    const doctorIds = [ids.doctor!];
    for (let i = 2; i <= DOCTORS.length; i++) {
      const id = randomUUID(), login = Login.parse(`${prefix}.doctor${i}`); doctorIds.push(id);
      await tx.query('INSERT INTO accounts(id,login,display_name,password_hash,managed_by_clinic_id) VALUES($1,$2,$3,$4,$5)', [id, login, DOCTORS[i - 1]![1], hash, clinicId]);
      await tx.query("INSERT INTO memberships(id,clinic_id,user_id,role,is_owner,clinical_access,patient_scope,status,granted_by) VALUES($1,$2,$3,'clinician',false,true,'assigned','active',$4)", [randomUUID(), clinicId, id, ids.ceo]);
      await tx.query("INSERT INTO membership_roles(clinic_id,user_id,role,granted_by) VALUES($1,$2,'doctor',$3)", [clinicId, id, ids.ceo]);
    }
    catalog = await seedDemoCatalog(tx, clinicId, ids.ceo!, doctorIds);
    const doctor = ids.doctor!, patient = randomUUID();
    await tx.query('INSERT INTO patients(id,clinic_id,display_name,mrn,provenance) VALUES($1,$2,$3,$4,$5)', [patient, clinicId, 'Fictional Samira — demo only', 'SYN-DEMO-001', { source: 'manual', externalReference: null }]);
    await tx.query('INSERT INTO patient_assignments(clinic_id,patient_id,user_id) VALUES($1,$2,$3)', [clinicId, patient, doctor]);
    for (const [date, location, specialty] of [['2020-02-29', 'Synthetic room 1', 'General medicine'], ['2026-11-10', 'Synthetic room 2', 'Cardiology']] as const) {
      const stamp = new Date().toISOString(), id = randomUUID(), document = randomUUID();
      const encounter = Encounter.parse({ id, clinicId, patientId: patient, clinicianId: doctor, location: { id: null, label: location }, specialty, occurrence: { precision: 'date', date, timezone: 'Asia/Tashkent' }, createdAt: stamp, updatedAt: stamp, status: 'draft', revision: 1, provenance: { source: 'manual', externalReference: null } });
      await tx.query('INSERT INTO encounters(id,clinic_id,patient_id,clinician_id,data) VALUES($1,$2,$3,$4,$5)', [id, clinicId, patient, doctor, encounter]);
      await tx.query('INSERT INTO documents(id,clinic_id,patient_id,encounter_id) VALUES($1,$2,$3,$4)', [document, clinicId, patient, id]);
    }
    await tx.query("INSERT INTO audit_events(id,actor_id,clinic_id,action,resource_id) VALUES($1,$2,$3,'synthetic.patient',$4)", [randomUUID(), doctor, clinicId, patient]);
    await seedAssistantDemo(tx, clinicId, doctor); // Task 003C: synthetic GP patient with history and a visit dated today.
    return (await tx.query('SELECT login FROM accounts WHERE managed_by_clinic_id=$1 ORDER BY login', [clinicId])).rows.map(r => r.login as string);
  });
  console.log(`Synthetic clinic provisioned with one login per role: ${logins.join(', ')}. Password not printed.`);
  console.log(`Synthetic catalog: ${JSON.stringify(catalog)}.`);
} finally { await pool.end(); }
