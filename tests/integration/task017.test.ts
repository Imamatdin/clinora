import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { httpFixture } from './fixture.js';
import { passwordHash } from '../../src/server/security.js';
import { transaction } from '../../src/server/database.js';
import { seedDemoStaff, type DemoStaff } from '../../src/server/demo-staff.js';
import { seedDemoCatalog } from '../../src/server/demo-catalog.js';

/*
 * Task 017 cross-module fixes, against PostgreSQL through HTTP (synthetic clinic from the shared demo seed):
 * 1. Registration can mark an arrival for admission; only such inpatient visits can be admitted.
 * 2. Lab results confirmed after their business day closed: the completion posts to the open day, the closed
 *    day's snapshot is unchanged; with no day open the confirmation waits and posts when the next day opens.
 */
let f: Awaited<ReturnType<typeof httpFixture>>;
type Posting = Awaited<ReturnType<typeof signIn>>;
let staff: DemoStaff, owner: Posting, registrar: Posting, ward: Posting, lab: Posting;
const key = (): string => randomUUID();
const url = (p: string) => `/api/clinics/${f.owner.clinicId}/${p}`;
const json = async (r: Response) => { const text = await r.text(); try { return JSON.parse(text); } catch { return text; } };
async function signIn(identifier: string) {
  const c = f.client();
  assert.equal((await c.request('/api/auth/login', { identifier, password: f.password })).status, 200);
  const me = await json(await c.request('/api/auth/me'));
  // Login names (not emails): sign in through the identifier form and send this session's CSRF token explicitly.
  return Object.assign(c, { post: (path: string, body: unknown) => c.request(path, body, { 'X-CSRF-Token': me.csrf }) });
}
const service = async (code: string) => (await f.pool.query('SELECT id FROM services WHERE clinic_id=$1 AND code_1c=$2', [f.owner.clinicId, code])).rows[0].id as string;

test.before(async () => {
  f = await httpFixture();
  const c = f.owner.clinicId, hash = await passwordHash(f.password);
  staff = await transaction(f.pool, async tx => { const s = await seedDemoStaff(tx, c, f.owner.userId, hash, 't17'); await seedDemoCatalog(tx, c, f.owner.userId, s.doctorIds); return s; });
  owner = await signIn('owner@example.test'); registrar = await signIn('t17.registrar'); ward = await signIn('t17.inpatient'); lab = await signIn('t17.lab');
});
test.after(async () => { await f.close(); });

test('late lab results: pending with no open day, posted when a day opens; confirmed on the open day otherwise; closed snapshot unchanged', async () => {
  const o = owner, l = lab, c = f.owner.clinicId, u = f.owner.userId;
  // A day two dates back is still open (the clinic forgot to close it); two lab tests were ordered on it.
  // Runs first: today's business day has not been opened yet.
  assert.equal((await json(await o.request(url('business-days/current')))).openDay, null);
  const old = key(), patient = key(), visit = key();
  await f.pool.query("INSERT INTO business_days(id,clinic_id,business_date,status,opened_by) VALUES($1,$2,(now() AT TIME ZONE 'Asia/Tashkent')::date-2,'open',$3)", [old, c, u]);
  await f.pool.query("INSERT INTO patients(id,clinic_id,display_name,full_name,provenance) VALUES($1,$2,'Синтетик Таҳлил','Синтетик Таҳлил','{}')", [patient, c]);
  await f.pool.query("INSERT INTO visits(id,clinic_id,patient_id,business_day_id,type,created_by) VALUES($1,$2,$3,$4,'outpatient',$5)", [visit, c, patient, old, u]);
  const [l1, l2] = [key(), key()];
  for (const [id, code] of [[l1, 'L01'], [l2, 'L03']] as const)
    await f.pool.query("INSERT INTO charge_lines(id,clinic_id,visit_id,service_id,quantity,unit_price_uzs,source,created_by) VALUES($1,$2,$3,$4,1,45000,'doctor',$5)", [id, c, visit, await service(code), u]);
  for (const id of [l1, l2]) assert.equal((await l.post(url(`lab/orders/${id}/results`), { expectedVersion: 0, values: [{ name: 'Синтетик', value: '1' }], comment: '', idempotencyKey: key() })).status, 201);
  assert.equal((await o.post(url(`business-days/${old}/close`), {})).status, 200);
  const snapshot = async () => (await f.pool.query('SELECT close_snapshot::text s FROM business_days WHERE id=$1', [old])).rows[0].s as string;
  const before = await snapshot();

  // No day open: the lab still sees the waiting orders, flagged late; confirming records a pending confirmation only.
  const list = await json(await l.request(url('lab/orders')));
  assert.equal(list.day, null);
  assert.deepEqual(list.orders.filter((x: { id: string }) => [l1, l2].includes(x.id)).map((x: { late: boolean }) => x.late), [true, true]);
  const pending = await json(await l.post(url(`lab/orders/${l1}/confirm`), { idempotencyKey: key() }));
  assert.equal(pending.status, 'pending');
  assert.equal((await f.pool.query('SELECT status FROM charge_lines WHERE id=$1', [l1])).rows[0].status, 'ordered');
  // Repeating from another device does not create a second pending record.
  assert.equal((await json(await l.post(url(`lab/orders/${l1}/confirm`), { idempotencyKey: key() }))).status, 'pending');
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM lab_pending_confirmations WHERE charge_line_id=$1', [l1])).rows[0].n, 1);

  // The next day opens: the pending confirmation posts to it exactly once.
  const opened = await json(await o.post(url('business-days/open'), {}));
  const posted = (await f.pool.query('SELECT status, completed_business_day_id FROM charge_lines WHERE id=$1', [l1])).rows[0];
  assert.deepEqual(posted, { status: 'completed', completed_business_day_id: opened.id });
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM lab_pending_confirmations WHERE posted_business_day_id=$1', [opened.id])).rows[0].n, 1);

  // With a day open, the second late result is confirmed at once and posted to that day.
  const late = await json(await l.post(url(`lab/orders/${l2}/confirm`), { idempotencyKey: key() }));
  assert.equal(late.status, 'completed'); assert.equal(late.late, true); assert.equal(late.postedTo, opened.businessDate);
  assert.equal((await f.pool.query('SELECT completed_business_day_id FROM charge_lines WHERE id=$1', [l2])).rows[0].completed_business_day_id, opened.id);
  // The closed day's report is never rewritten; the line value and its visit day stay as they were.
  assert.equal(await snapshot(), before);
  assert.deepEqual((await f.pool.query('SELECT business_day_id FROM visits WHERE id=$1', [visit])).rows[0], { business_day_id: old });
  // Completed late orders leave the waiting list.
  const after = await json(await l.request(url('lab/orders')));
  assert.equal(after.orders.some((x: { id: string }) => [l1, l2].includes(x.id)), false);
});

test('a visit marked for admission can be admitted; an outpatient visit cannot', async () => {
  const o = owner, r = registrar, w = ward, c = f.owner.clinicId;
  // The lab test below opened today's day; open it here only when this test runs alone.
  if (!(await json(await o.request(url('business-days/current')))).openDay) assert.equal((await o.post(url('business-days/open'), {})).status, 201);
  const surgeonPoint = (await f.pool.query("SELECT id FROM queue_points WHERE clinic_id=$1 AND user_id=$2", [c, staff.doctorIds[4]])).rows[0].id;
  const visitFor = async (fullName: string, type?: 'inpatient') => {
    const p = await json(await r.post(url('registration/patients'), { fullName, birthDate: '1970-01-02', gender: 'male', phone: null, districtId: null, mahallaId: null, address: null, source: null, idempotencyKey: key() }));
    const res = await r.post(url('registration/visits'), { patientId: p.id, points: [{ queuePointId: surgeonPoint, serviceIds: [await service('C05')] }], ...(type ? { type } : {}), idempotencyKey: key() });
    assert.equal(res.status, 201, JSON.stringify(await json(res.clone())));
    return (await json(res)).visitId as string;
  };
  const admitted = await visitFor('Синтетик Ётқизиладиган', 'inpatient'), outpatient = await visitFor('Синтетик Амбулатор');
  assert.deepEqual((await f.pool.query('SELECT type FROM visits WHERE id = ANY($1) ORDER BY type', [[admitted, outpatient]])).rows.map(x => x.type), ['inpatient', 'outpatient']);
  const surg = (await f.pool.query("SELECT id FROM departments WHERE clinic_id=$1 AND code_1c='SURG'", [c])).rows[0].id;
  const bed = (await f.pool.query("SELECT b.id FROM beds b JOIN rooms r ON r.id=b.room_id WHERE b.clinic_id=$1 AND r.department_id=$2 ORDER BY b.label LIMIT 1", [c, surg])).rows[0].id;
  const admit = (visitId: string) => w.post(url('inpatient/admit'), { visitId, departmentId: surg, doctorId: staff.doctorIds[4], bedId: bed, expectedDischarge: null, key: key() });
  assert.equal((await admit(outpatient)).status, 404);
  assert.equal((await admit(admitted)).status, 201);
  // The ward view lists only inpatient visits waiting for a bed.
  const view = await json(await w.request(url('inpatient')));
  assert.equal(view.visits.some((v: { id: string }) => v.id === outpatient), false);
});
