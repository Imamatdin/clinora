import { randomUUID as id } from 'node:crypto';
import type pg from 'pg';
import { passwordHash } from '../../src/server/security.js';

/**
 * Synthetic registration setup for one clinic (task 007): a registrar, three doctors (A and B have queue
 * points; C is a doctor nobody is routed to), a laboratory queue point, priced services and an address
 * catalog. Every name and price is invented. `password` is the fixture password so the clients can sign in.
 */
export async function seedRegistration(pool: pg.Pool, clinicId: string, ownerId: string, password: string, prefix = 'r007') {
  const hash = await passwordHash(password);
  const g = {
    registrar: id(), doctorA: id(), doctorB: id(), doctorC: id(), department: id(), labGroup: id(),
    consultA: id(), consultB: id(), labBlood: id(), labUrine: id(), unpriced: id(),
    pointA: id(), pointB: id(), pointLab: id(), district: id(), mahalla: id()
  };
  const email = (who: string) => `${prefix}.${who}@example.test`;
  const people: [string, string, string, string][] = [
    [g.registrar, email('registrar'), 'Синтетик Регистратор', 'registrar'],
    [g.doctorA, email('doctor-a'), 'Синтетик Терапевт', 'doctor'],
    [g.doctorB, email('doctor-b'), 'Синтетик Кардиолог', 'doctor'],
    [g.doctorC, email('doctor-c'), 'Синтетик Невролог', 'doctor']
  ];
  for (const [user, mail, name, role] of people) {
    await pool.query('INSERT INTO accounts(id,email,display_name,password_hash) VALUES($1,$2,$3,$4)', [user, mail, name, hash]);
    await pool.query("INSERT INTO memberships(id,clinic_id,user_id,role,clinical_access,patient_scope,status,granted_by) VALUES($1,$2,$3,$4,$5,'assigned','active',$6)",
      [id(), clinicId, user, role === 'doctor' ? 'clinician' : 'administrator', role === 'doctor', ownerId]);
    await pool.query('INSERT INTO membership_roles(clinic_id,user_id,role,granted_by) VALUES($1,$2,$3,$4)', [clinicId, user, role, ownerId]);
  }
  await pool.query("INSERT INTO departments(id,clinic_id,name_uz_cyrl) VALUES($1,$2,'Синтетик бўлим')", [g.department, clinicId]);
  await pool.query("INSERT INTO service_groups(id,clinic_id,department_id,name_uz_cyrl) VALUES($1,$2,$3,'Лаборатория')", [g.labGroup, clinicId, g.department]);
  const services: [string, string, string, string | null, number | null][] = [
    [g.consultA, 'consultation', 'Терапевт кўриги', null, 100000],
    [g.consultB, 'consultation', 'Кардиолог кўриги', null, 150000],
    [g.labBlood, 'lab', 'Умумий қон таҳлили', g.labGroup, 45000],
    [g.labUrine, 'lab', 'Умумий сийдик таҳлили', g.labGroup, 30000],
    [g.unpriced, 'consultation', 'Нархсиз кўрик', null, null]
  ];
  for (const [service, kind, name, group, price] of services) {
    await pool.query('INSERT INTO services(id,clinic_id,group_id,department_id,kind,name_uz_cyrl) VALUES($1,$2,$3,$4,$5,$6)', [service, clinicId, group, g.department, kind, name]);
    if (price !== null) await pool.query("INSERT INTO service_prices(id,clinic_id,service_id,price_uzs,effective_from,set_by) VALUES($1,$2,$3,$4,'2026-01-01T00:00:00+05:00',$5)",
      [id(), clinicId, service, price, ownerId]);
  }
  for (const [doctor, specialty, list] of [[g.doctorA, 'Терапевт', [g.consultA, g.unpriced]], [g.doctorB, 'Кардиолог', [g.consultB]], [g.doctorC, 'Невролог', []]] as const) {
    await pool.query('INSERT INTO doctor_profiles(clinic_id,user_id,department_id,specialty_uz_cyrl) VALUES($1,$2,$3,$4)', [clinicId, doctor, g.department, specialty]);
    for (const service of list) await pool.query('INSERT INTO doctor_services(clinic_id,user_id,service_id) VALUES($1,$2,$3)', [clinicId, doctor, service]);
  }
  await pool.query("INSERT INTO queue_points(id,clinic_id,kind,user_id,name_uz_cyrl,name_uz_latn,name_ru) VALUES($1,$2,'doctor',$3,'Терапевт','Terapevt','Терапевт'),($4,$2,'doctor',$5,'Кардиолог','Kardiolog','Кардиолог')",
    [g.pointA, clinicId, g.doctorA, g.pointB, g.doctorB]);
  await pool.query("INSERT INTO queue_points(id,clinic_id,kind,service_group_id,name_uz_cyrl,name_uz_latn,name_ru) VALUES($1,$2,'service',$3,'Лаборатория','Laboratoriya','Лаборатория')",
    [g.pointLab, clinicId, g.labGroup]);
  await pool.query("INSERT INTO districts(id,clinic_id,name_uz_cyrl,name_uz_latn,name_ru) VALUES($1,$2,'Юнусобод тумани','Yunusobod tumani','Юнусабадский район')", [g.district, clinicId]);
  await pool.query("INSERT INTO mahallas(id,clinic_id,district_id,name_uz_cyrl) VALUES($1,$2,$3,'Минор маҳалласи')", [g.mahalla, clinicId, g.district]);
  return { ...g, email };
}

/** Opens a business day for the clinic dated today (clinic time) or `offsetDays` from today. */
export async function openDay(pool: pg.Pool, clinicId: string, ownerId: string, offsetDays = 0): Promise<string> {
  const dayId = id();
  await pool.query("INSERT INTO business_days(id,clinic_id,business_date,status,opened_by) VALUES($1,$2,(now() AT TIME ZONE 'Asia/Tashkent')::date + $4::int,'open',$3)",
    [dayId, clinicId, ownerId, offsetDays]);
  return dayId;
}
export async function closeDay(pool: pg.Pool, dayId: string, ownerId: string) {
  await pool.query("UPDATE business_days SET status='closed',closed_by=$2,closed_at=now(),close_snapshot='{}' WHERE id=$1", [dayId, ownerId]);
}
