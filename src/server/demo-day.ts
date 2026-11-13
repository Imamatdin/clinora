// Task 017: a believable synthetic clinic day for the founders' demonstration, so queues and dashboards are not
// empty. Everything goes through the same server actions the screens use (registration, doctor, inpatient,
// cashier), each as the staff member who would do it, so every invariant, audit row and charge is real.
// All patients are invented. The day stays open: queues are live and the CEO dashboard shows today's figures.
import { randomUUID } from 'node:crypto';
import type { Tx } from './database.js';
import { requireRole, type ClinicContext } from './roles.js';
import type { Role } from '../modules/identity/roles.js';
import { openDay } from '../modules/business-days/actions.js';
import { createVisit, registerPatient, type SOURCES } from '../modules/registration/actions.js';
import { completeConsultation, startVisit } from '../modules/doctor/actions.js';
import { admit } from '../modules/inpatient/actions.js';
import * as cashier from '../modules/cashier/actions.js';

/** Invented people: [full name, birth date, gender, phone (9 digits), source]. */
const PATIENTS: [string, string, 'male' | 'female', string, typeof SOURCES[number]][] = [
  ['Тошпўлатов Бекзод Улуғбекович', '1984-03-12', 'male', '901000101', 'referral'],
  ['Каримова Шахноза Алишеровна', '1991-07-25', 'female', '901000102', 'returning'],
  ['Мирзаев Ойбек Рустамович', '1967-11-02', 'male', '901000103', 'social'],
  ['Юлдашева Мадина Фарход қизи', '2001-01-19', 'female', '901000104', 'referral'],
  ['Расулов Акмал Ботирович', '1975-05-30', 'male', '901000105', 'advertisement'],
  ['Абдураҳмонова Гулчеҳра Нуриддиновна', '1958-09-08', 'female', '901000106', 'returning'],
  ['Назаров Сардор Шавкатович', '1996-12-14', 'male', '901000107', 'social'],
  ['Эргашева Дилфуза Баҳромовна', '1988-04-03', 'female', '901000108', 'referral'],
  ['Қосимов Жаҳонгир Аброрович', '1979-08-21', 'male', '901000109', 'walk_in'],
  ['Сайфуллаева Нилуфар Иброҳимовна', '1993-02-27', 'female', '901000110', 'returning'],
  ['Ҳамидов Отабек Зафарович', '1962-06-16', 'male', '901000111', 'referral'],
  ['Турсунова Малика Жамшид қизи', '2004-10-05', 'female', '901000112', 'social']
];

export type DemoDayIds = { administrator: string; registrar: string; cashier: string; inpatient: string; doctorIds: string[] };
export type DemoDayResult = { patients: number; visits: number; admissions: number; consultationsDone: number; payments: number };

export async function seedDemoDay(tx: Tx, clinicId: string, ids: DemoDayIds): Promise<DemoDayResult> {
  const as = (actorId: string, roles: Role[]): Promise<ClinicContext> => requireRole(tx, actorId, clinicId, roles);
  const key = () => randomUUID();
  await openDay(await as(ids.administrator, ['administrator']));
  const reg = await as(ids.registrar, ['registrar']);
  const point = async (userId: string) => (await tx.query("SELECT id FROM queue_points WHERE clinic_id=$1 AND kind='doctor' AND user_id=$2", [clinicId, userId])).rows[0].id as string;
  const labPoint = (await tx.query("SELECT id FROM queue_points WHERE clinic_id=$1 AND kind='service'", [clinicId])).rows[0].id as string;
  const service = async (code: string) => (await tx.query('SELECT id FROM services WHERE clinic_id=$1 AND code_1c=$2', [clinicId, code])).rows[0].id as string;
  // [patient index, doctor index, consultation code, lab tests, admit to department code]
  const plan: [number, number, string, string[], string | null][] = [
    [0, 0, 'C01', ['L01', 'L03'], null], [1, 1, 'C02', ['L07'], null], [2, 2, 'C03', [], null], [3, 5, 'C06', ['L01', 'L02'], null],
    [4, 4, 'C05', [], 'SURG'], [5, 0, 'C01', ['L04'], 'THER'], [6, 6, 'C07', [], null], [7, 3, 'C04', ['L08'], null],
    [8, 7, 'C08', [], null], [9, 1, 'C02', [], null], [10, 0, 'C01', ['L05', 'L06'], null], [11, 5, 'C06', [], null]
  ];
  const visits: { visitId: string; tickets: { id: string; queuePointId: string }[]; doctor: string; admitTo: string | null }[] = [];
  for (const [p, d, consult, labs, admitTo] of plan) {
    const [fullName, birthDate, gender, phone, source] = PATIENTS[p]!;
    const patient = await registerPatient(reg, { fullName, birthDate, gender, phone, districtId: null, mahallaId: null, address: null,
      source, idempotencyKey: key() });
    const doctor = ids.doctorIds[d]!;
    const points = [{ queuePointId: await point(doctor), serviceIds: [await service(consult)] }];
    if (labs.length) points.push({ queuePointId: labPoint, serviceIds: await Promise.all(labs.map(service)) });
    const v = await createVisit(reg, { patientId: patient.id, points, type: admitTo ? 'inpatient' : 'outpatient', idempotencyKey: key() });
    visits.push({ visitId: v.visitId, tickets: v.tickets, doctor, admitTo });
  }
  // Two patients are admitted to a free bed of their department under the doctor they saw.
  const ward = await as(ids.inpatient, ['inpatient']);
  let admissions = 0;
  for (const v of visits.filter(v => v.admitTo)) {
    const dept = (await tx.query('SELECT id FROM departments WHERE clinic_id=$1 AND code_1c=$2', [clinicId, v.admitTo])).rows[0].id;
    const bed = (await tx.query(`SELECT b.id FROM beds b JOIN rooms r ON r.id=b.room_id WHERE b.clinic_id=$1 AND r.department_id=$2
      AND NOT EXISTS (SELECT 1 FROM bed_assignments a WHERE a.bed_id=b.id AND a.to_at IS NULL) ORDER BY r.name, b.label LIMIT 1`, [clinicId, dept])).rows[0].id;
    await admit(ward, { visitId: v.visitId, departmentId: dept, doctorId: v.doctor, bedId: bed, expectedDischarge: null, key: key() });
    admissions++;
  }
  // The morning's first six consultations are finished; the rest wait in the doctors' queues.
  let consultationsDone = 0;
  for (const v of visits.slice(0, 6)) {
    const ticket = v.tickets.find(t => t.queuePointId !== labPoint)!;
    const doc = await as(v.doctor, ['doctor']);
    await startVisit(doc, ticket.id, { idempotencyKey: key() });
    await completeConsultation(doc, ticket.id, { idempotencyKey: key() });
    consultationsDone++;
  }
  // The cashier opens a shift and takes payments: five outpatients pay in full (cash or card), one pays half.
  const cash = await as(ids.cashier, ['cashier']);
  const desk = (await tx.query('SELECT id FROM cash_desks WHERE clinic_id=$1 ORDER BY name LIMIT 1', [clinicId])).rows[0].id;
  const shift = await cashier.open(cash, { deskId: desk, opening: '200000' } as never) as { id: string };
  let payments = 0;
  for (const [i, v] of visits.filter(v => !v.admitTo).slice(0, 6).entries()) {
    const bill = await cashier.bill(cash, v.visitId);
    const due = BigInt(bill.invoice.due);
    const amount = i === 5 ? due / 2n : due;
    if (amount <= 0n) continue;
    await cashier.pay(cash, v.visitId, { shiftId: shift.id, amount: amount.toString(), method: i % 2 ? 'card' : 'cash', key: key() } as never);
    payments++;
  }
  return { patients: plan.length, visits: visits.length, admissions, consultationsDone, payments };
}
