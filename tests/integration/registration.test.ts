import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { httpFixture } from './fixture.js';
import { seedRegistration, openDay, closeDay } from './registration-fixture.js';
import pg from 'pg';
import { transaction } from '../../src/server/database.js';
import { requireRole } from '../../src/server/roles.js';
import { createVisit } from '../../src/modules/registration/actions.js';
import { passwordHash } from '../../src/server/security.js';

let f: Awaited<ReturnType<typeof httpFixture>>, g: Awaited<ReturnType<typeof seedRegistration>>;
let owner: ReturnType<typeof f.client>, registrar: ReturnType<typeof f.client>, doctorA: ReturnType<typeof f.client>,
  doctorB: ReturnType<typeof f.client>, doctorC: ReturnType<typeof f.client>;
const key = () => randomUUID();
const url = (p: string) => `/api/clinics/${f.owner.clinicId}/${p}`;
const json = async (r: Response) => { const body = await r.json(); return body; };
let dayId = '';

const newPatient = (over: Record<string, unknown> = {}) => ({ fullName: 'Синтетик Бемор ' + randomUUID().slice(0, 6), birthDate: '1990-05-01', gender: 'female',
  phone: null, districtId: null, mahallaId: null, address: null, source: 'walk_in', idempotencyKey: key(), ...over });
async function register(over: Record<string, unknown> = {}) {
  const r = await registrar.request(url('registration/patients'), newPatient(over)); assert.equal(r.status, 201); return json(r);
}
async function visit(patientId: string, points: { queuePointId: string; serviceIds: string[] }[], idempotencyKey = key()) {
  return registrar.request(url('registration/visits'), { patientId, points, idempotencyKey });
}

test.before(async () => {
  f = await httpFixture();
  g = await seedRegistration(f.pool, f.owner.clinicId, f.owner.userId, f.password);
  owner = f.client(); await owner.login();
  registrar = f.client(); await registrar.login(g.email('registrar'));
  doctorA = f.client(); await doctorA.login(g.email('doctor-a'));
  doctorB = f.client(); await doctorB.login(g.email('doctor-b'));
  doctorC = f.client(); await doctorC.login(g.email('doctor-c'));
});
test.after(async () => { await f?.close(); });

test('every new route rejects unauthenticated, wrong-role and cross-clinic calls before parsing the body', async () => {
  const cashierId = randomUUID(), c = f.owner.clinicId;
  await f.pool.query("INSERT INTO accounts(id,email,display_name,password_hash) VALUES($1,'cashier.r007@example.test','Synthetic Cashier',$2)", [cashierId, await passwordHash(f.password)]);
  await f.pool.query("INSERT INTO memberships(id,clinic_id,user_id,status,granted_by) VALUES($1,$2,$3,'active',$4)", [key(), c, cashierId, f.owner.userId]);
  await f.pool.query("INSERT INTO membership_roles(clinic_id,user_id,role,granted_by) VALUES($1,$2,'cashier',$3)", [c, cashierId, f.owner.userId]);
  const cashier = f.client(), foreign = f.client(), anonymous = f.client();
  await cashier.login('cashier.r007@example.test'); await foreign.login('other@example.test');
  const someId = randomUUID();
  const routes: [string, unknown][] = [['registration/options', undefined], ['registration/search', {}], ['registration/duplicates', {}], ['registration/patients', {}],
    [`registration/patients/${someId}`, undefined], [`registration/patients/${someId}`, {}], ['registration/visits', {}], [`registration/visits/${someId}/tickets`, undefined],
    ['queue/mine', undefined], ['queue/call-next', {}], [`queue/tickets/${someId}/status`, {}]];
  for (const [path, body] of routes) {
    assert.equal((await anonymous.request(url(path), body)).status, 401, path);
    assert.equal((await cashier.request(url(path), body)).status, 403, path);
    assert.equal((await foreign.request(url(path), body)).status, 404, path);
  }
  // Doctors do not register; registrars do not run doctor queues.
  assert.equal((await doctorA.request(url('registration/options'))).status, 403);
  assert.equal((await doctorA.request(url('registration/patients'), newPatient())).status, 403);
  assert.equal((await registrar.request(url('queue/mine'))).status, 403);
  assert.equal((await registrar.request(url('queue/call-next'), { idempotencyKey: key() })).status, 403);
});

test('no open business day rejects visits; numbering restarts each day; tickets never cross days', async () => {
  const p = await register();
  const route = [{ queuePointId: g.pointA, serviceIds: [g.consultA] }];
  const before = (await f.pool.query('SELECT count(*)::int n FROM visits')).rows[0].n;
  assert.equal((await visit(p.id, route)).status, 409);
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM visits')).rows[0].n, before);
  const yesterday = await openDay(f.pool, f.owner.clinicId, f.owner.userId, -1);
  const first = await json(await visit(p.id, route)), second = await json(await visit(p.id, route));
  assert.deepEqual([first.tickets[0].number, second.tickets[0].number], [1, 2]);
  await closeDay(f.pool, yesterday, f.owner.userId);
  assert.equal((await visit(p.id, route)).status, 409);
  // Yesterday's waiting ticket is gone from the board and cannot be moved.
  assert.equal((await doctorA.request(url(`queue/tickets/${first.tickets[0].id}/status`), { status: 'in_progress', idempotencyKey: key() })).status, 404);
  dayId = await openDay(f.pool, f.owner.clinicId, f.owner.userId);
  const today = await json(await visit(p.id, route));
  assert.equal(today.tickets[0].number, 1);
  const board = await json(await doctorA.request(url('queue/mine')));
  assert.deepEqual(board.map((t: { id: string }) => t.id), [today.tickets[0].id]);
  assert.equal((await f.pool.query('SELECT business_day_id FROM visits WHERE id=$1', [today.visitId])).rows[0].business_day_id, dayId);
});

test('50 concurrent ticket requests for one point give 50 distinct consecutive numbers; a repeated key gives the same ticket', async () => {
  const c = f.owner.clinicId, point = randomUUID();
  await f.pool.query("INSERT INTO queue_points(id,clinic_id,kind,service_group_id,name_uz_cyrl) VALUES($1,$2,'service',$3,'УТТ')", [point, c, g.labGroup]);
  const patients: string[] = [];
  for (let i = 0; i < 50; i++) patients.push((await register()).id);
  // Real parallel transactions: one connection each, all contending for the same counter row.
  const wide = new pg.Pool({ connectionString: f.url, max: 50, options: `-c search_path=${f.schema}` });
  try {
    const keys = patients.map(() => key());
    // Hold all 50 connections first so the 50 transactions really overlap.
    const clients = await Promise.all(patients.map(() => wide.connect())); clients.forEach(client => client.release());
    const results = await Promise.all(patients.map((patientId, i) => transaction(wide, async tx =>
      createVisit(await requireRole(tx, g.registrar, c, ['registrar']), { patientId, points: [{ queuePointId: point, serviceIds: [] }], idempotencyKey: keys[i]! }))));
    const numbers = results.map(r => r.tickets[0]!.number).sort((a, b) => a - b);
    assert.deepEqual(numbers, Array.from({ length: 50 }, (_, i) => i + 1));
    const replay = await transaction(wide, async tx =>
      createVisit(await requireRole(tx, g.registrar, c, ['registrar']), { patientId: patients[7]!, points: [{ queuePointId: point, serviceIds: [] }], idempotencyKey: keys[7]! }));
    assert.deepEqual(replay, results[7]);
  } finally { await wide.end(); }
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM queue_tickets WHERE queue_point_id=$1', [point])).rows[0].n, 50);
  // Over HTTP: a double submit with one key creates one visit and returns the same ticket.
  const p = await register(), idem = key(), route = [{ queuePointId: point, serviceIds: [] }];
  const [a, b] = await Promise.all([visit(p.id, route, idem), visit(p.id, route, idem)]);
  assert.equal(a.status, 201); assert.equal(b.status, 201);
  const [ra, rb] = [await json(a), await json(b)];
  assert.deepEqual(ra, rb); assert.equal(ra.tickets[0].number, 51);
  assert.equal((await visit(p.id, [{ queuePointId: g.pointA, serviceIds: [] }], idem)).status, 409);
});

test('routed doctors read the patient, an unrouted doctor gets 404, the registrar never sees clinical notes', async () => {
  const p = await register();
  const r = await visit(p.id, [{ queuePointId: g.pointA, serviceIds: [g.consultA] }, { queuePointId: g.pointB, serviceIds: [g.consultB] },
    { queuePointId: g.pointLab, serviceIds: [g.labBlood, g.labUrine] }]);
  assert.equal(r.status, 201); const v = await json(r);
  assert.equal(v.tickets.length, 3);
  assert.equal((await doctorA.request(url(`patients/${p.id}`))).status, 200);
  assert.equal((await doctorB.request(url(`patients/${p.id}`))).status, 200);
  assert.equal((await doctorC.request(url(`patients/${p.id}`))).status, 404);
  assert.equal((await registrar.request(url(`patients/${p.id}`))).status, 404);
  // A note written by doctor A stays out of the registrar's view of the same patient.
  const enc = await doctorA.request(url(`patients/${p.id}/encounters`), { occurrence: { precision: 'date', date: '2026-11-12', timezone: 'Asia/Tashkent' }, location: 'Room 1', specialty: 'Terapiya' }, { 'Idempotency-Key': 'r007-encounter-key-0001' });
  assert.equal(enc.status, 201);
  const reg = await registrar.request(url(`registration/patients/${p.id}`)); assert.equal(reg.status, 200);
  const text = JSON.stringify(await reg.json());
  assert.doesNotMatch(text, /encounter|Terapiya|Room 1|note/i);
  assert.equal((await registrar.request(url(`patients/${p.id}/encounters`), { occurrence: { precision: 'date', date: '2026-11-12', timezone: 'Asia/Tashkent' }, location: 'x', specialty: 'x' }, { 'Idempotency-Key': 'r007-encounter-key-0002' })).status, 404);
  // Charges: one ordered line per chosen service, performer set for doctor points, linked to the ticket.
  const lines = (await f.pool.query('SELECT service_id,status,source,performer_user_id,queue_ticket_id,unit_price_uzs FROM charge_lines WHERE visit_id=$1 ORDER BY unit_price_uzs', [v.visitId])).rows;
  assert.deepEqual(lines.map(l => [l.status, l.source]), Array(4).fill(['ordered', 'registration']));
  assert.equal(lines.find(l => l.service_id === g.consultA).performer_user_id, g.doctorA);
  assert.equal(lines.find(l => l.service_id === g.labBlood).performer_user_id, null);
  assert.ok(lines.every(l => v.tickets.some((t: { id: string }) => t.id === l.queue_ticket_id)));
  // A service that is not offered at the chosen point is rejected and nothing is created.
  const count = (await f.pool.query('SELECT count(*)::int n FROM visits')).rows[0].n;
  assert.equal((await visit(p.id, [{ queuePointId: g.pointB, serviceIds: [g.consultA] }])).status, 404);
  assert.equal((await visit(p.id, [{ queuePointId: g.pointA, serviceIds: [g.unpriced] }])).status, 409);
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM visits')).rows[0].n, count);
});

test('doctor queue: own tickets only, call next, missed call, in progress, completed; revoked access disappears', async () => {
  const p = await register();
  const v = await json(await visit(p.id, [{ queuePointId: g.pointA, serviceIds: [] }, { queuePointId: g.pointB, serviceIds: [] }]));
  const ticketA = v.tickets.find((t: { queuePointId: string }) => t.queuePointId === g.pointA);
  const ticketB = v.tickets.find((t: { queuePointId: string }) => t.queuePointId === g.pointB);
  const mineC = await json(await doctorC.request(url('queue/mine'))); assert.deepEqual(mineC, []);
  assert.equal((await doctorC.request(url(`queue/tickets/${ticketA.id}/status`), { status: 'in_progress', idempotencyKey: key() })).status, 404);
  assert.equal((await doctorA.request(url(`queue/tickets/${ticketB.id}/status`), { status: 'in_progress', idempotencyKey: key() })).status, 404);
  assert.equal((await doctorA.request(url('queue/call-next'), { queuePointId: g.pointB, idempotencyKey: key() })).status, 404);
  // Doctor A's queue may hold earlier waiting tickets; call until this patient's ticket is called. One patient is active
  // at a time (task 010), so each earlier patient is cancelled before calling the next.
  let called: { id: string; status: string } | null = null;
  for (let i = 0; i < 10 && called?.id !== ticketA.id; i++) {
    if (called) assert.equal((await doctorA.request(url(`queue/tickets/${called.id}/status`), { status: 'cancelled', idempotencyKey: key() })).status, 200);
    const callKey = key();
    const r = await json(await doctorA.request(url('queue/call-next'), { idempotencyKey: callKey }));
    assert.deepEqual(await json(await doctorA.request(url('queue/call-next'), { idempotencyKey: callKey })), r, 'repeat returns same ticket');
    called = r.ticket;
  }
  assert.equal(called?.id, ticketA.id); assert.equal(called?.status, 'called');
  const step = async (status: string) => doctorA.request(url(`queue/tickets/${ticketA.id}/status`), { status, idempotencyKey: key() });
  assert.equal((await json(await step('waiting'))).status, 'waiting'); // Missed call goes back to the queue.
  assert.equal((await json(await step('in_progress'))).status, 'in_progress');
  assert.equal((await step('waiting')).status, 409);
  const done = await json(await step('completed')); assert.equal(done.status, 'completed'); assert.ok(done.completedAt);
  assert.equal((await step('in_progress')).status, 409);
  const audit = (await f.pool.query("SELECT count(*)::int n FROM audit_events WHERE action='queue.ticket_status' AND resource_id=$1", [ticketA.id])).rows[0].n;
  assert.equal(audit, 3);
  // An administrator can manage any point.
  assert.equal((await json(await owner.request(url(`queue/tickets/${ticketB.id}/status`), { status: 'cancelled', idempotencyKey: key() }))).status, 'cancelled');
  // Removing the assignment removes the ticket from the doctor's board and the patient from their reach.
  await f.pool.query('DELETE FROM patient_assignments WHERE clinic_id=$1 AND patient_id=$2 AND user_id=$3', [f.owner.clinicId, p.id, g.doctorA]);
  const mine = await json(await doctorA.request(url('queue/mine')));
  assert.ok(!mine.some((t: { id: string }) => t.id === ticketA.id));
  assert.equal((await doctorA.request(url(`patients/${p.id}`))).status, 404);
});

test('call next after assignment revocation: active ticket and replay disclose no patient (task 019)', async () => {
  const p = await register();
  const v = await json(await visit(p.id, [{ queuePointId: g.pointA, serviceIds: [] }]));
  const ticket = v.tickets[0];
  // Reach this patient's ticket at doctor A's point, cancelling anyone called before it.
  let called: { id: string } | null = null, callKey = '';
  for (let i = 0; i < 20 && called?.id !== ticket.id; i++) {
    if (called) assert.equal((await owner.request(url(`queue/tickets/${called.id}/status`), { status: 'cancelled', idempotencyKey: key() })).status, 200);
    callKey = key();
    called = (await json(await doctorA.request(url('queue/call-next'), { idempotencyKey: callKey }))).ticket;
  }
  assert.equal(called?.id, ticket.id);
  await f.pool.query('DELETE FROM patient_assignments WHERE clinic_id=$1 AND patient_id=$2 AND user_id=$3', [f.owner.clinicId, p.id, g.doctorA]);
  const replayed = await doctorA.request(url('queue/call-next'), { idempotencyKey: callKey });
  assert.equal(replayed.status, 200);
  const replayText = await replayed.text();
  assert.deepEqual(JSON.parse(replayText), { ticket: null, alreadyActive: false }, 'replay of the original call hides the patient');
  assert.ok(!replayText.includes(p.fullName));
  const fresh = await doctorA.request(url('queue/call-next'), { idempotencyKey: key() });
  const freshText = await fresh.text();
  assert.deepEqual(JSON.parse(freshText), { ticket: null, alreadyActive: true }, 'the active slot is held, but nothing is disclosed');
  assert.ok(!freshText.includes(p.fullName) && !freshText.includes(p.id));
  // An administrator still sees and resolves the ticket.
  const managerView = await json(await owner.request(url('queue/call-next'), { queuePointId: g.pointA, idempotencyKey: key() }));
  assert.equal(managerView.ticket.id, ticket.id); assert.equal(managerView.alreadyActive, true);
  assert.equal((await owner.request(url(`queue/tickets/${ticket.id}/status`), { status: 'cancelled', idempotencyKey: key() })).status, 200);
});

test('charge lines keep the price in force at creation; later catalog changes do not touch them', async () => {
  const p = await register();
  const first = await json(await visit(p.id, [{ queuePointId: g.pointA, serviceIds: [g.consultA] }]));
  await f.pool.query('INSERT INTO service_prices(id,clinic_id,service_id,price_uzs,effective_from,set_by) VALUES($1,$2,$3,175000,now(),$4)', [key(), f.owner.clinicId, g.consultA, f.owner.userId]);
  const second = await json(await visit(p.id, [{ queuePointId: g.pointA, serviceIds: [g.consultA] }]));
  const price = async (visitId: string) => (await f.pool.query('SELECT unit_price_uzs FROM charge_lines WHERE visit_id=$1', [visitId])).rows[0].unit_price_uzs;
  assert.equal(await price(first.visitId), '100000');
  assert.equal(await price(second.visitId), '175000');
  const options = await json(await registrar.request(url('registration/options')));
  const pointA = options.points.find((x: { id: string }) => x.id === g.pointA);
  assert.equal(pointA.services.find((s: { id: string }) => s.id === g.consultA).priceUzs, '175000');
  assert.ok(pointA.waiting >= 1);
  assert.equal(options.day.id, dayId);
});

test('duplicate warning on same phone or same name + birth date in any script; proceeding needs a reason', async () => {
  const phone = '+998 90 555 12 34';
  const original = await register({ fullName: 'Ҳасанова Ўғилой', birthDate: '1985-02-03', phone });
  assert.equal(original.phone, '+998905551234');
  const byPhone = await json(await registrar.request(url('registration/duplicates'), { fullName: 'Бошқа Одам', phone: '905551234' }));
  assert.deepEqual(byPhone.map((p: { id: string }) => p.id), [original.id]);
  const byName = await json(await registrar.request(url('registration/duplicates'), { fullName: "Hasanova O'g'iloy", birthDate: '1985-02-03' }));
  assert.deepEqual(byName.map((p: { id: string }) => p.id), [original.id]);
  assert.deepEqual(await json(await registrar.request(url('registration/duplicates'), { fullName: 'Hasanova Ogiloy', birthDate: '1985-02-04' })), []);
  const blocked = await registrar.request(url('registration/patients'), newPatient({ fullName: 'Hasanova Oʻgʻiloy', birthDate: '1985-02-03' }));
  assert.equal(blocked.status, 409);
  const twin = await register({ fullName: 'Hasanova Oʻgʻiloy', birthDate: '1985-02-03', duplicateReason: 'Synthetic: different person, same name' });
  const override = (await f.pool.query('SELECT matched_patient_ids,reason,created_by FROM patient_duplicate_overrides WHERE patient_id=$1', [twin.id])).rows[0];
  assert.deepEqual(override.matched_patient_ids, [original.id]); assert.equal(override.created_by, g.registrar);
  const audit = (await f.pool.query("SELECT detail FROM audit_events WHERE action='registration.patient_registered' AND resource_id=$1", [twin.id])).rows[0];
  assert.deepEqual(audit.detail, { patientNo: twin.patientNo, duplicateMatches: 1 });
  assert.ok(!JSON.stringify(audit.detail).includes('Synthetic'));
  // Search: last four phone digits, patient number, and name across scripts.
  const find = async (query: string) => (await json(await registrar.request(url('registration/search'), { query }))).map((p: { id: string }) => p.id);
  assert.ok((await find('1234')).includes(original.id));
  assert.ok((await find('90 555-12-34')).includes(original.id));
  assert.deepEqual((await find(String(original.patientNo)))[0], original.id);
  assert.ok((await find('hasanova')).includes(original.id));
  assert.ok((await find('ўғилой ҳасанова')).includes(twin.id));
  assert.deepEqual(await find('zzzz-nobody'), []);
});

test('editing a name updates full_name and display_name together; stale edits are rejected', async () => {
  const p = await register();
  const current = (await json(await registrar.request(url(`registration/patients/${p.id}`)))).patient;
  const edit = { fullName: 'Тузатилган Исм', birthDate: '1990-05-01', gender: 'female', phone: '+998901112233', districtId: g.district, mahallaId: g.mahalla,
    address: 'Синтетик кўча 1', source: 'referral', expectedRevision: current.revision };
  const r = await registrar.request(url(`registration/patients/${p.id}`), { ...edit, idempotencyKey: key() });
  assert.equal(r.status, 200);
  const row = (await f.pool.query('SELECT full_name,display_name,district_id,mahalla_id,revision FROM patients WHERE id=$1', [p.id])).rows[0];
  assert.equal(row.full_name, 'Тузатилган Исм'); assert.equal(row.display_name, 'Тузатилган Исм'); assert.equal(row.mahalla_id, g.mahalla);
  assert.equal((await registrar.request(url(`registration/patients/${p.id}`), { ...edit, fullName: 'Эски', idempotencyKey: key() })).status, 409);
  assert.equal((await registrar.request(url(`registration/patients/${p.id}`), { ...edit, mahallaId: g.mahalla, districtId: null, expectedRevision: row.revision, idempotencyKey: key() })).status, 422);
  assert.equal((await registrar.request(url('registration/patients'), newPatient({ birthDate: '2999-01-01' }))).status, 422);
});

test('ticket page: one ticket per point, patient number but no name, no diagnosis, links the print script', async () => {
  const p = await register({ fullName: 'Махфий <Исм>' });
  const v = await json(await visit(p.id, [{ queuePointId: g.pointA, serviceIds: [g.consultA] }, { queuePointId: g.pointLab, serviceIds: [g.labBlood] }]));
  const r = await registrar.request(url(`registration/visits/${v.visitId}/tickets`));
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') ?? '', /^text\/html/);
  assert.match(r.headers.get('content-security-policy') ?? '', /script-src 'self'/);
  const html = await r.text();
  assert.equal(html.match(/<article class="ticket">/g)?.length, 2);
  assert.match(html, /<script src="\/ticket\.js" defer><\/script>/);
  assert.ok(html.includes(`<strong>${p.patientNo}</strong>`));
  assert.ok(!html.includes('Махфий') && !html.includes('<Исм>'));
  assert.ok(!html.includes('кўриги') && !html.includes('таҳлили'), 'no service names on tickets');
  for (const t of v.tickets) assert.ok(html.includes(`<p class="number">${t.number}</p>`));
  assert.equal((await doctorA.request(url(`registration/visits/${v.visitId}/tickets`))).status, 403);
  assert.equal((await registrar.request(url(`registration/visits/${randomUUID()}/tickets`))).status, 404);
});
