import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { databaseFixture } from './fixture.js';
import { makePool, migrate, transaction, type Tx } from '../../src/server/database.js';
import { nextPatientNo, nextQueueNumber, nextReceiptNo, priceAt, withAudit } from '../../src/server/repo/index.js';
import { ServicePriceRow, ChargeLineRow, PaymentRow, ReceiptRow } from '../../src/contracts/db/index.js';
import { seedDemoCatalog, DOCTORS } from '../../scripts/demo-catalog.js';

type Db = Awaited<ReturnType<typeof databaseFixture>>;
type Q = { query: Tx['query'] };

/** Rejects with the given PostgreSQL SQLSTATE (and optionally a message pattern). */
async function rejectsWith(work: Promise<unknown>, code: string, message?: RegExp) {
  await assert.rejects(work, (error: { code?: string; message?: string }) => {
    assert.equal(error.code, code, `expected SQLSTATE ${code}, got ${error.code}: ${error.message}`);
    if (message) assert.match(error.message ?? '', message);
    return true;
  });
}
const FK = '23503', UNIQUE = '23505', CHECK = '23514', RESTRICT = '23001', NOT_NULL = '23502';

/** A minimal graph in one clinic: business day, service with price, patient, visit, desk, shift, charge line. */
async function graph(db: Q, clinicId: string, actorId: string) {
  const id = () => randomUUID();
  const g = { clinicId, actorId, day: id(), dept: id(), service: id(), bedService: id(), stockService: id(), patient: id(), visit: id(),
    desk: id(), shift: id(), line: id(), point: id(), expense: id(), room: id(), bed: id(), admission: id() };
  const q = (sql: string, values: unknown[]) => db.query(sql, values);
  await q("INSERT INTO business_days(id,clinic_id,business_date,status,opened_by) VALUES($1,$2,'2026-11-12','open',$3)", [g.day, clinicId, actorId]);
  await q("INSERT INTO departments(id,clinic_id,name_uz_cyrl) VALUES($1,$2,'Терапия')", [g.dept, clinicId]);
  await q("INSERT INTO services(id,clinic_id,kind,name_uz_cyrl) VALUES($1,$2,'consultation','Кўрик')", [g.service, clinicId]);
  await q("INSERT INTO services(id,clinic_id,kind,name_uz_cyrl) VALUES($1,$2,'bed','Палата')", [g.bedService, clinicId]);
  await q("INSERT INTO services(id,clinic_id,kind,name_uz_cyrl,track_stock) VALUES($1,$2,'medicine','Парацетамол',true)", [g.stockService, clinicId]);
  await q('INSERT INTO service_prices(id,clinic_id,service_id,price_uzs,effective_from,set_by) VALUES($1,$2,$3,100000,$4,$5)', [id(), clinicId, g.service, '2026-01-01T00:00:00Z', actorId]);
  await q("INSERT INTO patients(id,clinic_id,display_name,provenance) VALUES($1,$2,'Synthetic Patient','{\"source\":\"manual\"}')", [g.patient, clinicId]);
  await q("INSERT INTO visits(id,clinic_id,patient_id,business_day_id,type,created_by) VALUES($1,$2,$3,$4,'inpatient',$5)", [g.visit, clinicId, g.patient, g.day, actorId]);
  await q("INSERT INTO cash_desks(id,clinic_id,name) VALUES($1,$2,'Касса 1')", [g.desk, clinicId]);
  await q('INSERT INTO cash_shifts(id,clinic_id,cash_desk_id,business_day_id,cashier_user_id,opening_cash_uzs) VALUES($1,$2,$3,$4,$5,0)', [g.shift, clinicId, g.desk, g.day, actorId]);
  await q("INSERT INTO charge_lines(id,clinic_id,visit_id,service_id,quantity,unit_price_uzs,source,created_by) VALUES($1,$2,$3,$4,1,100000,'registration',$5)", [g.line, clinicId, g.visit, g.service, actorId]);
  await q("INSERT INTO queue_points(id,clinic_id,kind,user_id,name_uz_cyrl) VALUES($1,$2,'doctor',$3,'Терапевт')", [g.point, clinicId, actorId]);
  await q("INSERT INTO expense_types(id,clinic_id,name_uz_cyrl) VALUES($1,$2,'Хўжалик')", [g.expense, clinicId]);
  await q("INSERT INTO rooms(id,clinic_id,name) VALUES($1,$2,'101')", [g.room, clinicId]);
  await q("INSERT INTO beds(id,clinic_id,room_id,label,bed_service_id) VALUES($1,$2,$3,'101-1',$4)", [g.bed, clinicId, g.room, g.bedService]);
  await q('INSERT INTO admissions(id,clinic_id,visit_id,department_id,attending_user_id,admitted_at) VALUES($1,$2,$3,$4,$5,now())', [g.admission, clinicId, g.visit, g.dept, actorId]);
  return g;
}
type Graph = Awaited<ReturnType<typeof graph>>;
const payment = (db: Q, g: Graph, extra: { kind?: string; refundOf?: string | null; key?: string } = {}) => {
  const pid = randomUUID();
  return db.query(`INSERT INTO payments(id,clinic_id,visit_id,cash_shift_id,business_day_id,kind,method,amount_uzs,refund_of,idempotency_key,received_by)
    VALUES($1,$2,$3,$4,$5,$6,'cash',50000,$7,$8,$9) RETURNING *`,
    [pid, g.clinicId, g.visit, g.shift, g.day, extra.kind ?? 'payment', extra.refundOf ?? null, extra.key ?? randomUUID(), g.actorId]).then(r => r.rows[0]);
};

let db: Db, a: Graph, b: Graph;
test.before(async () => {
  db = await databaseFixture();
  a = await graph(db.pool, db.owner.clinicId, db.owner.userId);
  b = await graph(db.pool, db.other.clinicId, db.other.userId);
});
test.after(async () => { await db?.close(); });

test('fresh database migrates, rerun is a no-op, and new clinics get settings and numbered patients', async () => {
  const before = (await db.pool.query('SELECT name, applied_at FROM schema_migrations ORDER BY name')).rows;
  assert.ok(before.some(r => r.name === '010_core_schema.sql'));
  await migrate(db.pool);
  assert.deepEqual((await db.pool.query('SELECT name, applied_at FROM schema_migrations ORDER BY name')).rows, before);
  const settings = (await db.pool.query('SELECT default_locale, bed_day_rule FROM clinic_settings WHERE clinic_id=$1', [db.owner.clinicId])).rows[0];
  assert.equal(settings.default_locale, 'uz-Cyrl');
  assert.deepEqual(settings.bed_day_rule, { countAdmissionDay: true, countDischargeDay: false, minimumDays: 1 });
  const p = (await db.pool.query('SELECT patient_no, full_name FROM patients WHERE id=$1', [a.patient])).rows[0];
  assert.equal(p.full_name, 'Synthetic Patient');
  assert.ok(p.patient_no >= 1);
});

test('upgrade from a task-003A database numbers existing patients per clinic in creation order', async () => {
  const url = process.env.TEST_DATABASE_URL!;
  const schema = 'clinora_test_' + randomUUID().replaceAll('-', '');
  const admin = makePool(url); await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = makePool(url, schema);
  try {
    // Recreate exactly what a 003A deployment has: migrations 001 and 002, recorded by the runner.
    await pool.query('CREATE TABLE schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    const files = (await readdir('db/migrations')).filter(n => /^00[12]_.*\.sql$/.test(n)).sort();
    assert.deepEqual(files, ['001_notebook.sql', '002_clinic_roles.sql']);
    for (const name of files) {
      const sql = await readFile('db/migrations/' + name, 'utf8');
      await pool.query(sql);
      await pool.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)', [name, createHash('sha256').update(sql).digest('hex')]);
    }
    const user = randomUUID(), c1 = randomUUID(), c2 = randomUUID();
    await pool.query("INSERT INTO accounts(id,email,display_name,password_hash) VALUES($1,'u@example.test','U','x')", [user]);
    await pool.query("INSERT INTO clinics(id,name) VALUES($1,'One'),($2,'Two')", [c1, c2]);
    const ins = (id: string, clinic: string, name: string, at: string) => pool.query(
      "INSERT INTO patients(id,clinic_id,display_name,date_of_birth,created_at,provenance) VALUES($1,$2,$3,'1990-01-02',$4,'{}')", [id, clinic, name, at]);
    const [p1, p2, p3, q1] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await ins(p2, c1, 'Second', '2026-02-01T00:00:00Z'); await ins(p1, c1, 'First', '2026-01-01T00:00:00Z');
    await ins(p3, c1, 'Third', '2026-03-01T00:00:00Z'); await ins(q1, c2, 'Other clinic', '2026-02-15T00:00:00Z');

    await migrate(pool);
    const rows = (await pool.query('SELECT id, patient_no, full_name, birth_date FROM patients ORDER BY clinic_id, patient_no')).rows;
    const byId = Object.fromEntries(rows.map(r => [r.id, r]));
    assert.deepEqual([byId[p1].patient_no, byId[p2].patient_no, byId[p3].patient_no, byId[q1].patient_no], [1, 2, 3, 1]);
    assert.equal(byId[p2].full_name, 'Second');
    assert.equal(byId[p1].birth_date, '1990-01-02');
    const settings = (await pool.query('SELECT count(*)::int n FROM clinic_settings')).rows[0].n;
    assert.equal(settings, 2);
    // The counter continues after the migrated numbers, both via the insert default and the helper.
    const next = (await pool.query("INSERT INTO patients(id,clinic_id,display_name,provenance) VALUES($1,$2,'Fourth','{}') RETURNING patient_no", [randomUUID(), c1])).rows[0];
    assert.equal(next.patient_no, 4);
    assert.equal(await transaction(pool, tx => nextPatientNo(tx, c1)), 5);
    const applied = (await pool.query('SELECT count(*)::int n FROM schema_migrations')).rows[0].n;
    await migrate(pool);
    assert.equal((await pool.query('SELECT count(*)::int n FROM schema_migrations')).rows[0].n, applied);
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); }
});

test('append-only tables reject UPDATE and DELETE', async () => {
  const pay = await payment(db.pool, a);
  await db.pool.query('INSERT INTO payment_allocations(clinic_id,payment_id,charge_line_id,amount_uzs) VALUES($1,$2,$3,50000)', [a.clinicId, pay.id, a.line]);
  const cashOut = randomUUID();
  await db.pool.query('INSERT INTO cash_outs(id,clinic_id,cash_shift_id,business_day_id,expense_type_id,amount_uzs,created_by) VALUES($1,$2,$3,$4,$5,1000,$6)', [cashOut, a.clinicId, a.shift, a.day, a.expense, a.actorId]);
  const move = randomUUID();
  await db.pool.query("INSERT INTO stock_movements(id,clinic_id,service_id,qty,reason,created_by) VALUES($1,$2,$3,10,'receipt',$4)", [move, a.clinicId, a.stockService, a.actorId]);
  const rule = randomUUID();
  await db.pool.query("INSERT INTO doctor_split_rules(id,clinic_id,user_id,doctor_share_bp,basis,discount_bearer,categories,effective_from,created_by) VALUES($1,$2,$3,3000,'billed','clinic','{consultation}','2026-01-01',$3)", [rule, a.clinicId, a.actorId]);
  const lab = randomUUID();
  await db.pool.query("INSERT INTO lab_results(id,clinic_id,charge_line_id,version,result,entered_by) VALUES($1,$2,$3,1,'{\"values\":[],\"comment\":null}',$4)", [lab, a.clinicId, a.line, a.actorId]);
  const cases: [string, string, string][] = [
    ['payments', 'amount_uzs = 1', `id='${pay.id}'`],
    ['payment_allocations', 'amount_uzs = 1', `payment_id='${pay.id}'`],
    ['cash_outs', 'amount_uzs = 1', `id='${cashOut}'`],
    ['stock_movements', 'qty = 1', `id='${move}'`],
    ['doctor_split_rules', 'doctor_share_bp = 9000', `id='${rule}'`],
    ['service_prices', 'price_uzs = 1', `service_id='${a.service}'`],
    ['lab_results', "result = '{}'", `id='${lab}'`]
  ];
  for (const [table, set, where] of cases) {
    await rejectsWith(db.pool.query(`UPDATE ${table} SET ${set} WHERE ${where}`), RESTRICT, /append-only/);
    await rejectsWith(db.pool.query(`DELETE FROM ${table} WHERE ${where}`), RESTRICT, /append-only/);
  }
  // Financial and clinical rows with status are never deleted either.
  for (const [table, idv] of [['charge_lines', a.line], ['visits', a.visit], ['cash_shifts', a.shift], ['admissions', a.admission], ['patients', a.patient]])
    await rejectsWith(db.pool.query(`DELETE FROM ${table} WHERE id=$1`, [idv]), RESTRICT, /never deleted/);
});

test('charge line price and quantity are immutable and status moves only forward', async () => {
  const line = randomUUID();
  await db.pool.query("INSERT INTO charge_lines(id,clinic_id,visit_id,service_id,quantity,unit_price_uzs,source,created_by) VALUES($1,$2,$3,$4,2,100000,'doctor',$5)", [line, a.clinicId, a.visit, a.service, a.actorId]);
  await rejectsWith(db.pool.query('UPDATE charge_lines SET unit_price_uzs=1 WHERE id=$1', [line]), RESTRICT, /immutable/);
  await rejectsWith(db.pool.query('UPDATE charge_lines SET quantity=3 WHERE id=$1', [line]), RESTRICT, /immutable/);
  await rejectsWith(db.pool.query("INSERT INTO charge_lines(id,clinic_id,visit_id,service_id,quantity,unit_price_uzs,source,created_by) VALUES($1,$2,$3,$4,0,1,'doctor',$5)", [randomUUID(), a.clinicId, a.visit, a.service, a.actorId]), CHECK);
  await db.pool.query("UPDATE charge_lines SET status='completed', completed_by=$2, completed_at=now() WHERE id=$1", [line, a.actorId]);
  await rejectsWith(db.pool.query("UPDATE charge_lines SET status='ordered', completed_by=NULL, completed_at=NULL WHERE id=$1", [line]), CHECK, /not allowed/);
  await rejectsWith(db.pool.query("UPDATE charge_lines SET status='cancelled', cancelled_by=$2, cancelled_at=now() WHERE id=$1", [line, a.actorId]), CHECK, /needs a reason/);
  await db.pool.query("UPDATE charge_lines SET status='cancelled', cancelled_by=$2, cancelled_at=now(), cancel_reason='Synthetic: wrong service' WHERE id=$1", [line, a.actorId]);
  await rejectsWith(db.pool.query("UPDATE charge_lines SET cancel_reason='changed' WHERE id=$1", [line]), RESTRICT, /cancelled charge line is immutable/);
  const row = ChargeLineRow.parse((await db.pool.query('SELECT * FROM charge_lines WHERE id=$1', [line])).rows[0]);
  assert.equal(row.unit_price_uzs, 100000n); assert.equal(row.quantity, 2); assert.equal(row.status, 'cancelled');
});

test('illegal status transitions are rejected for visits, tickets, shifts, admissions and payroll', async () => {
  const visit = randomUUID();
  await db.pool.query("INSERT INTO visits(id,clinic_id,patient_id,business_day_id,type,created_by) VALUES($1,$2,$3,$4,'outpatient',$5)", [visit, a.clinicId, a.patient, a.day, a.actorId]);
  const ticket = randomUUID(), number = await transaction(db.pool, tx => nextQueueNumber(tx, a.clinicId, a.day, a.point));
  await db.pool.query('INSERT INTO queue_tickets(id,clinic_id,business_day_id,visit_id,queue_point_id,number) VALUES($1,$2,$3,$4,$5,$6)', [ticket, a.clinicId, a.day, visit, a.point, number]);
  await rejectsWith(db.pool.query("UPDATE queue_tickets SET status='completed' WHERE id=$1", [ticket]), CHECK, /waiting -> completed/);
  await db.pool.query("UPDATE queue_tickets SET status='called', called_at=now() WHERE id=$1", [ticket]);
  await db.pool.query("UPDATE queue_tickets SET status='in_progress', started_at=now() WHERE id=$1", [ticket]);
  await db.pool.query("UPDATE queue_tickets SET status='completed', completed_at=now() WHERE id=$1", [ticket]);
  await rejectsWith(db.pool.query("UPDATE queue_tickets SET status='waiting' WHERE id=$1", [ticket]), CHECK, /completed -> waiting/);
  await rejectsWith(db.pool.query('UPDATE queue_tickets SET number=99 WHERE id=$1', [ticket]), RESTRICT, /immutable/);
  // One ticket per visit per point per day.
  await rejectsWith(db.pool.query('INSERT INTO queue_tickets(id,clinic_id,business_day_id,visit_id,queue_point_id,number) VALUES($1,$2,$3,$4,$5,999)', [randomUUID(), a.clinicId, a.day, visit, a.point]), UNIQUE);

  await db.pool.query("UPDATE visits SET status='closed', closed_at=now() WHERE id=$1", [visit]);
  await rejectsWith(db.pool.query("UPDATE visits SET status='open', closed_at=NULL WHERE id=$1", [visit]), CHECK, /closed -> open/);
  await rejectsWith(db.pool.query("UPDATE visits SET status='cancelled' WHERE id=$1", [visit]), CHECK, /closed -> cancelled/);

  const shift = randomUUID(), desk = randomUUID();
  await db.pool.query("INSERT INTO cash_desks(id,clinic_id,name) VALUES($1,$2,'Касса 9')", [desk, a.clinicId]);
  await db.pool.query('INSERT INTO cash_shifts(id,clinic_id,cash_desk_id,business_day_id,cashier_user_id,opening_cash_uzs) VALUES($1,$2,$3,$4,$5,0)', [shift, a.clinicId, desk, a.day, a.actorId]);
  await rejectsWith(db.pool.query("UPDATE cash_shifts SET status='closed' WHERE id=$1", [shift]), CHECK); // closing needs count and report
  await rejectsWith(db.pool.query('UPDATE cash_shifts SET opening_cash_uzs=5 WHERE id=$1', [shift]), RESTRICT, /opening facts/);
  await db.pool.query("UPDATE cash_shifts SET status='closed', closed_at=now(), counted_cash_uzs=0, close_report='{}' WHERE id=$1", [shift]);
  await rejectsWith(db.pool.query("UPDATE cash_shifts SET status='open', closed_at=NULL, counted_cash_uzs=NULL, close_report=NULL WHERE id=$1", [shift]), RESTRICT, /closed cash shift/);

  const admission = randomUUID(), v2 = randomUUID();
  await db.pool.query("INSERT INTO visits(id,clinic_id,patient_id,business_day_id,type,created_by) VALUES($1,$2,$3,$4,'inpatient',$5)", [v2, a.clinicId, a.patient, a.day, a.actorId]);
  await db.pool.query('INSERT INTO admissions(id,clinic_id,visit_id,department_id,attending_user_id,admitted_at) VALUES($1,$2,$3,$4,$5,now())', [admission, a.clinicId, v2, a.dept, a.actorId]);
  await db.pool.query("UPDATE admissions SET status='discharged', discharged_at=now() WHERE id=$1", [admission]);
  await rejectsWith(db.pool.query("UPDATE admissions SET status='admitted', discharged_at=NULL WHERE id=$1", [admission]), CHECK, /discharged -> admitted/);

  const period = randomUUID();
  await db.pool.query("INSERT INTO payroll_periods(id,clinic_id,from_date,to_date) VALUES($1,$2,'2026-11-01','2026-11-30')", [period, a.clinicId]);
  await db.pool.query("UPDATE payroll_periods SET status='final', finalized_by=$2, finalized_at=now() WHERE id=$1", [period, a.actorId]);
  await rejectsWith(db.pool.query("UPDATE payroll_periods SET status='draft', finalized_by=NULL, finalized_at=NULL WHERE id=$1", [period]), RESTRICT, /final payroll/);
});

test('discount needs a reason and an approver, and only voiding may change it, once', async () => {
  const ins = (reason: string | null, approver: string | null) => db.pool.query(
    "INSERT INTO discounts(id,clinic_id,visit_id,kind,percent_bp,reason,approved_by,created_by) VALUES($1,$2,$3,'percent',1000,$4,$5,$6) RETURNING id",
    [randomUUID(), a.clinicId, a.visit, reason, approver, a.actorId]);
  await rejectsWith(ins(null, a.actorId), NOT_NULL);
  await rejectsWith(ins('   ', a.actorId), CHECK);
  await rejectsWith(ins('Synthetic reason', null), NOT_NULL);
  await rejectsWith(db.pool.query("INSERT INTO discounts(id,clinic_id,visit_id,kind,percent_bp,amount_uzs,reason,approved_by,created_by) VALUES($1,$2,$3,'percent',1000,500,'r',$4,$4)", [randomUUID(), a.clinicId, a.visit, a.actorId]), CHECK);
  const id = (await ins('Synthetic: veteran', a.actorId)).rows[0].id;
  await rejectsWith(db.pool.query('UPDATE discounts SET percent_bp=5000 WHERE id=$1', [id]), RESTRICT, /except for voiding/);
  await rejectsWith(db.pool.query('UPDATE discounts SET voided_by=$2, voided_at=now() WHERE id=$1', [id, a.actorId]), CHECK); // void needs a reason
  await db.pool.query("UPDATE discounts SET voided_by=$2, voided_at=now(), void_reason='Synthetic: entered twice' WHERE id=$1", [id, a.actorId]);
  await rejectsWith(db.pool.query("UPDATE discounts SET void_reason='other' WHERE id=$1", [id]), RESTRICT, /voided discount/);
  await rejectsWith(db.pool.query('DELETE FROM discounts WHERE id=$1', [id]), RESTRICT);
});

test('payments: idempotency key is unique per clinic, refunds reference a payment, receipts only count prints', async () => {
  const key = 'synthetic-key-' + randomUUID();
  const first = PaymentRow.parse(await payment(db.pool, a, { key }));
  assert.equal(first.amount_uzs, 50000n);
  await rejectsWith(payment(db.pool, a, { key }), UNIQUE);
  await payment(db.pool, b, { key }); // another clinic may reuse the same key
  await rejectsWith(payment(db.pool, a, { kind: 'refund' }), CHECK);
  await rejectsWith(payment(db.pool, a, { kind: 'refund', refundOf: (await payment(db.pool, b)).id }), FK); // refund of another clinic's payment
  await payment(db.pool, a, { kind: 'refund', refundOf: first.id });

  const receiptNo = await transaction(db.pool, tx => nextReceiptNo(tx, a.clinicId));
  const rid = randomUUID();
  await db.pool.query("INSERT INTO receipts(id,clinic_id,receipt_no,visit_id,payment_id,kind,snapshot,issued_by) VALUES($1,$2,$3,$4,$5,'payment','{\"total\":\"50000\"}',$6)", [rid, a.clinicId, receiptNo, a.visit, first.id, a.actorId]);
  await db.pool.query('UPDATE receipts SET print_count=print_count+1 WHERE id=$1', [rid]);
  await rejectsWith(db.pool.query('UPDATE receipts SET print_count=0 WHERE id=$1', [rid]), RESTRICT);
  await rejectsWith(db.pool.query("UPDATE receipts SET snapshot='{}' WHERE id=$1", [rid]), RESTRICT);
  const receipt = ReceiptRow.parse((await db.pool.query('SELECT * FROM receipts WHERE id=$1', [rid])).rows[0]);
  assert.equal(receipt.receipt_no, receiptNo); assert.equal(receipt.print_count, 1);
});

test('one open shift per desk and one open bed assignment per bed and per admission', async () => {
  await rejectsWith(db.pool.query('INSERT INTO cash_shifts(id,clinic_id,cash_desk_id,business_day_id,cashier_user_id,opening_cash_uzs) VALUES($1,$2,$3,$4,$5,0)', [randomUUID(), a.clinicId, a.desk, a.day, a.actorId]), UNIQUE);

  const v = randomUUID(), adm2 = randomUUID(), first = randomUUID();
  await db.pool.query("INSERT INTO visits(id,clinic_id,patient_id,business_day_id,type,created_by) VALUES($1,$2,$3,$4,'inpatient',$5)", [v, a.clinicId, a.patient, a.day, a.actorId]);
  await db.pool.query('INSERT INTO admissions(id,clinic_id,visit_id,department_id,attending_user_id,admitted_at) VALUES($1,$2,$3,$4,$5,now())', [adm2, a.clinicId, v, a.dept, a.actorId]);
  await db.pool.query('INSERT INTO bed_assignments(id,clinic_id,admission_id,bed_id,from_at) VALUES($1,$2,$3,$4,now())', [first, a.clinicId, a.admission, a.bed]);
  await rejectsWith(db.pool.query('INSERT INTO bed_assignments(id,clinic_id,admission_id,bed_id,from_at) VALUES($1,$2,$3,$4,now())', [randomUUID(), a.clinicId, adm2, a.bed]), UNIQUE);
  const bed2 = randomUUID();
  await db.pool.query("INSERT INTO beds(id,clinic_id,room_id,label,bed_service_id) VALUES($1,$2,$3,'101-2',$4)", [bed2, a.clinicId, a.room, a.bedService]);
  await rejectsWith(db.pool.query('INSERT INTO bed_assignments(id,clinic_id,admission_id,bed_id,from_at) VALUES($1,$2,$3,$4,now())', [randomUUID(), a.clinicId, a.admission, bed2]), UNIQUE);
  // Transfer: close the first, then open the next; closing is write-once.
  await db.pool.query('UPDATE bed_assignments SET to_at=now() WHERE id=$1', [first]);
  await db.pool.query('INSERT INTO bed_assignments(id,clinic_id,admission_id,bed_id,from_at) VALUES($1,$2,$3,$4,now())', [randomUUID(), a.clinicId, adm2, a.bed]);
  await rejectsWith(db.pool.query('UPDATE bed_assignments SET to_at=NULL WHERE id=$1', [first]), RESTRICT);
  // Beds must use a bed-kind service; dispensing needs a visit and charge line.
  await rejectsWith(db.pool.query("INSERT INTO beds(id,clinic_id,room_id,label,bed_service_id) VALUES($1,$2,$3,'101-3',$4)", [randomUUID(), a.clinicId, a.room, a.service]), CHECK, /bed service/);
  await rejectsWith(db.pool.query("INSERT INTO stock_movements(id,clinic_id,service_id,qty,reason,created_by) VALUES($1,$2,$3,-1,'dispense',$4)", [randomUUID(), a.clinicId, a.stockService, a.actorId]), CHECK);
  await rejectsWith(db.pool.query("INSERT INTO stock_movements(id,clinic_id,service_id,qty,reason,created_by) VALUES($1,$2,$3,5,'receipt',$4)", [randomUUID(), a.clinicId, a.service, a.actorId]), CHECK, /@stock/);
});

test('a row in clinic A cannot reference a row in clinic B', async () => {
  const q = (sql: string, values: unknown[]) => rejectsWith(db.pool.query(sql, values), FK);
  await q("INSERT INTO visits(id,clinic_id,patient_id,business_day_id,type,created_by) VALUES($1,$2,$3,$4,'outpatient',$5)", [randomUUID(), a.clinicId, b.patient, a.day, a.actorId]);
  await q("INSERT INTO visits(id,clinic_id,patient_id,business_day_id,type,created_by) VALUES($1,$2,$3,$4,'outpatient',$5)", [randomUUID(), a.clinicId, a.patient, b.day, a.actorId]);
  await q("INSERT INTO charge_lines(id,clinic_id,visit_id,service_id,quantity,unit_price_uzs,source,created_by) VALUES($1,$2,$3,$4,1,1,'doctor',$5)", [randomUUID(), a.clinicId, a.visit, b.service, a.actorId]);
  await q("INSERT INTO charge_lines(id,clinic_id,visit_id,service_id,quantity,unit_price_uzs,source,performer_user_id,created_by) VALUES($1,$2,$3,$4,1,1,'doctor',$5,$6)", [randomUUID(), a.clinicId, a.visit, a.service, b.actorId, a.actorId]);
  await q('INSERT INTO payment_allocations(clinic_id,payment_id,charge_line_id,amount_uzs) VALUES($1,$2,$3,1)', [a.clinicId, (await payment(db.pool, a)).id, b.line]);
  const freeDesk = randomUUID();
  await db.pool.query("INSERT INTO cash_desks(id,clinic_id,name) VALUES($1,$2,'Касса B')", [freeDesk, b.clinicId]);
  await q('INSERT INTO cash_shifts(id,clinic_id,cash_desk_id,business_day_id,cashier_user_id,opening_cash_uzs) VALUES($1,$2,$3,$4,$5,0)', [randomUUID(), a.clinicId, freeDesk, a.day, a.actorId]);
  // The bed-kind trigger looks the service up inside clinic A, finds nothing and refuses before the FK runs.
  await rejectsWith(db.pool.query("INSERT INTO beds(id,clinic_id,room_id,label,bed_service_id) VALUES($1,$2,$3,'x',$4)", [randomUUID(), a.clinicId, a.room, b.bedService]), CHECK);
  await q('INSERT INTO bed_assignments(id,clinic_id,admission_id,bed_id,from_at) VALUES($1,$2,$3,$4,now())', [randomUUID(), a.clinicId, a.admission, b.bed]);
  await q("INSERT INTO queue_points(id,clinic_id,kind,user_id,name_uz_cyrl) VALUES($1,$2,'doctor',$3,'x')", [randomUUID(), a.clinicId, b.actorId]);
  await q('INSERT INTO queue_counters(clinic_id,business_day_id,queue_point_id) VALUES($1,$2,$3)', [a.clinicId, a.day, b.point]);
  await q('INSERT INTO service_prices(id,clinic_id,service_id,price_uzs,effective_from,set_by) VALUES($1,$2,$3,1,now(),$4)', [randomUUID(), a.clinicId, b.service, a.actorId]);
  await q('INSERT INTO doctor_profiles(clinic_id,user_id,specialty_uz_cyrl) VALUES($1,$2,$3)', [a.clinicId, b.actorId, 'x']);
  // Encounter linked to a visit of another patient in the same clinic is also refused.
  const other = (await db.pool.query("INSERT INTO patients(id,clinic_id,display_name,provenance) VALUES($1,$2,'Another Synthetic','{}') RETURNING id", [randomUUID(), a.clinicId])).rows[0].id;
  await q('INSERT INTO encounters(id,clinic_id,patient_id,clinician_id,data,visit_id) VALUES($1,$2,$3,$4,$5,$6)', [randomUUID(), a.clinicId, other, a.actorId, {}, a.visit]);
  // The queue counter helper refuses to create a counter for another clinic's point.
  await rejectsWith(transaction(db.pool, tx => nextQueueNumber(tx, a.clinicId, a.day, b.point)), FK);
});

test('priceAt returns the price in force around a price change and null before the first price', async () => {
  const change = new Date('2026-06-01T00:00:00Z');
  await db.pool.query('INSERT INTO service_prices(id,clinic_id,service_id,price_uzs,effective_from,set_by) VALUES($1,$2,$3,120000,$4,$5)', [randomUUID(), a.clinicId, a.service, change, a.actorId]);
  const at = (iso: string) => transaction(db.pool, tx => priceAt(tx, a.clinicId, a.service, new Date(iso)));
  assert.equal(await at('2025-12-31T23:59:59Z'), null);
  assert.equal((await at('2026-01-01T00:00:00Z'))!.priceUzs, 100000n);
  assert.equal((await at('2026-05-31T23:59:59.999Z'))!.priceUzs, 100000n);
  assert.equal((await at('2026-06-01T00:00:00Z'))!.priceUzs, 120000n);
  assert.equal((await at('2027-01-01T00:00:00Z'))!.priceUzs, 120000n);
  assert.equal(await transaction(db.pool, tx => priceAt(tx, b.clinicId, a.service, new Date())), null); // other clinic sees nothing
  await rejectsWith(db.pool.query('INSERT INTO service_prices(id,clinic_id,service_id,price_uzs,effective_from,set_by) VALUES($1,$2,$3,1,$4,$5)', [randomUUID(), a.clinicId, a.service, change, a.actorId]), UNIQUE);
  const rows = (await db.pool.query('SELECT * FROM service_prices WHERE service_id=$1', [a.service])).rows.map(r => ServicePriceRow.parse(r));
  assert.equal(rows.length, 2);
});

test('counters give distinct consecutive values under 50 concurrent transactions', async () => {
  const run = <T>(fn: (tx: Tx) => Promise<T>) => Promise.all(Array.from({ length: 50 }, () => transaction(db.pool, fn)));
  const point = randomUUID();
  await db.pool.query("INSERT INTO queue_points(id,clinic_id,kind,user_id,name_uz_cyrl) VALUES($1,$2,'doctor',$3,'Навбат')", [point, a.clinicId, a.actorId]);
  const tickets = await run(tx => nextQueueNumber(tx, a.clinicId, a.day, point));
  assert.deepEqual([...tickets].sort((x, y) => x - y), Array.from({ length: 50 }, (_, i) => i + 1));

  const start = (await db.pool.query('SELECT last_no FROM patient_counters WHERE clinic_id=$1', [a.clinicId])).rows[0].last_no as number;
  const patients = await run(async tx => {
    const no = await nextPatientNo(tx, a.clinicId);
    await tx.query("INSERT INTO patients(id,clinic_id,patient_no,display_name,full_name,provenance) VALUES($1,$2,$3,'Synthetic','Synthetic','{}')", [randomUUID(), a.clinicId, no]);
    return no;
  });
  assert.deepEqual([...patients].sort((x, y) => x - y), Array.from({ length: 50 }, (_, i) => start + i + 1));

  const receipts = await run(tx => nextReceiptNo(tx, b.clinicId));
  assert.equal(new Set(receipts.map(String)).size, 50);
  // A rolled-back caller does not burn a number.
  const before = await transaction(db.pool, tx => nextReceiptNo(tx, b.clinicId));
  await assert.rejects(transaction(db.pool, async tx => { await nextReceiptNo(tx, b.clinicId); throw new Error('synthetic rollback'); }));
  assert.equal(await transaction(db.pool, tx => nextReceiptNo(tx, b.clinicId)), before + 1n);
});

test('withAudit writes inside the caller transaction and rolls back with it', async () => {
  const resource = randomUUID();
  await assert.rejects(transaction(db.pool, async tx => {
    await withAudit(tx, { actorId: a.actorId, clinicId: a.clinicId }, 'charge.cancelled', resource, { amountUzs: 100000n });
    throw new Error('synthetic rollback');
  }));
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM audit_events WHERE resource_id=$1', [resource])).rows[0].n, 0);
  await transaction(db.pool, tx => withAudit(tx, { actorId: a.actorId, clinicId: a.clinicId }, 'charge.cancelled', resource, { amountUzs: 100000n }));
  const row = (await db.pool.query('SELECT action, detail FROM audit_events WHERE resource_id=$1', [resource])).rows[0];
  assert.deepEqual(row, { action: 'charge.cancelled', detail: { amountUzs: '100000' } });
  await assert.rejects(transaction(db.pool, tx => withAudit(tx, { actorId: a.actorId, clinicId: a.clinicId }, 'Bad Action', resource)), /dotted/);
});

test('demo catalog seeds the full shape into a migrated clinic', async () => {
  const doctors: string[] = [];
  await transaction(db.pool, async tx => {
    for (let i = 0; i < DOCTORS.length; i++) {
      const id = randomUUID(); doctors.push(id);
      await tx.query("INSERT INTO accounts(id,login,display_name,password_hash) VALUES($1,$2,$3,'x')", [id, `synthetic.doc${i}.${randomUUID().slice(0, 8)}`, DOCTORS[i]![1]]);
      await tx.query("INSERT INTO memberships(id,clinic_id,user_id,role,status,granted_by) VALUES($1,$2,$3,'clinician','active',$4)", [randomUUID(), b.clinicId, id, b.actorId]);
    }
    const result = await seedDemoCatalog(tx, b.clinicId, b.actorId, doctors);
    assert.deepEqual(result, { departments: 3, doctors: 10, services: 65, labTests: 10, medicines: 15, rooms: 8, beds: 20 });
  });
  const count = async (sql: string) => (await db.pool.query(sql, [b.clinicId])).rows[0].n as number;
  assert.equal(await count('SELECT count(DISTINCT kind)::int n FROM services WHERE clinic_id=$1 AND code_1c IS NOT NULL'), 10);
  assert.equal(await count('SELECT count(*)::int n FROM services s WHERE clinic_id=$1 AND code_1c IS NOT NULL AND NOT EXISTS (SELECT 1 FROM service_prices p WHERE p.service_id=s.id)'), 0);
  assert.equal(await count('SELECT count(*)::int n FROM doctor_split_rules WHERE clinic_id=$1 AND user_id <> (SELECT user_id FROM memberships WHERE clinic_id=$1 AND is_owner)'), 10);
  assert.equal(await count('SELECT count(*)::int n FROM services WHERE clinic_id=$1 AND code_1c IS NOT NULL AND (name_uz_latn IS NULL OR name_ru IS NULL OR name_uz_latn ~ \'[А-Яа-яЁёЎўҚқҒғҲҳ]\')'), 0);
  assert.equal(await count('SELECT count(*)::int n FROM cash_desks WHERE clinic_id=$1 AND name = \'Касса 2\''), 1);
  assert.equal(await count("SELECT count(*)::int n FROM (SELECT service_id FROM stock_movements WHERE clinic_id=$1 AND reason='receipt' AND note IS NOT NULL GROUP BY service_id HAVING sum(qty) > 0) s"), 15);
});
