import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { httpFixture } from './fixture.js';
import { passwordHash } from '../../src/server/security.js';

/*
 * Task 010 acceptance (CI): doctor and laboratory workspaces against PostgreSQL through HTTP.
 * Synthetic clinic: doctors A and B each with a queue point; patient P1 routed to A, P2 routed to B.
 */
let f: Awaited<ReturnType<typeof httpFixture>>;
type Client = ReturnType<typeof f.client>;
let A: Client, B: Client, lab: Client, cashier: Client;
const key = () => randomUUID();
const ids = { a: randomUUID(), b: randomUUID(), lab: randomUUID(), cashier: randomUUID(), day: randomUUID(), pointA: randomUUID(), pointB: randomUUID(),
  p1: randomUUID(), p2: randomUUID(), p3: randomUUID(), consult: randomUUID(), labTest: randomUUID(), unpriced: randomUUID(), medicine: randomUUID() };
const url = (p: string) => `/api/clinics/${f.owner.clinicId}/${p}`;
const json = async (r: Response) => { const text = await r.text(); try { return JSON.parse(text); } catch { return text; } };

async function member(id: string, email: string, name: string, role: string, clinical: boolean) {
  const c = f.owner.clinicId, u = f.owner.userId;
  await f.pool.query('INSERT INTO accounts(id,email,display_name,password_hash) VALUES($1,$2,$3,$4)', [id, email, name, await passwordHash(f.password)]);
  await f.pool.query("INSERT INTO memberships(id,clinic_id,user_id,role,clinical_access,patient_scope,status,granted_by) VALUES($1,$2,$3,$4,$5,'assigned','active',$6)",
    [key(), c, id, clinical ? 'clinician' : 'administrator', clinical, u]);
  await f.pool.query('INSERT INTO membership_roles(clinic_id,user_id,role,granted_by) VALUES($1,$2,$3,$4)', [c, id, role, u]);
}
/** A visit for `patient` with a ticket on `point` and a registration consultation line linked to the ticket. */
async function visitWithTicket(patient: string, point: string, number: number) {
  const c = f.owner.clinicId, u = f.owner.userId, visit = key(), ticket = key(), line = key();
  await f.pool.query("INSERT INTO visits(id,clinic_id,patient_id,business_day_id,type,created_by) VALUES($1,$2,$3,$4,'outpatient',$5)", [visit, c, patient, ids.day, u]);
  await f.pool.query('INSERT INTO queue_tickets(id,clinic_id,business_day_id,visit_id,queue_point_id,number) VALUES($1,$2,$3,$4,$5,$6)', [ticket, c, ids.day, visit, point, number]);
  await f.pool.query("INSERT INTO charge_lines(id,clinic_id,visit_id,service_id,quantity,unit_price_uzs,source,created_by,queue_ticket_id) VALUES($1,$2,$3,$4,1,100000,'registration',$5,$6)",
    [line, c, visit, ids.consult, u, ticket]);
  return { visit, ticket, line };
}
let v1: Awaited<ReturnType<typeof visitWithTicket>>, v2: Awaited<ReturnType<typeof visitWithTicket>>, v3: Awaited<ReturnType<typeof visitWithTicket>>;

test.before(async () => {
  f = await httpFixture();
  const c = f.owner.clinicId, u = f.owner.userId;
  await member(ids.a, 'doctor.a@example.test', 'Synthetic Doctor A', 'doctor', true);
  await member(ids.b, 'doctor.b@example.test', 'Synthetic Doctor B', 'doctor', true);
  await member(ids.lab, 'lab@example.test', 'Synthetic Lab', 'laboratory', false);
  await member(ids.cashier, 'cashier.010@example.test', 'Synthetic Cashier', 'cashier', false);
  await f.pool.query("INSERT INTO doctor_profiles(clinic_id,user_id,specialty_uz_cyrl) VALUES($1,$2,'Терапевт'),($1,$3,'Кардиолог')", [c, ids.a, ids.b]);
  await f.pool.query("INSERT INTO business_days(id,clinic_id,business_date,status,opened_by) VALUES($1,$2,(now() AT TIME ZONE 'Asia/Tashkent')::date,'open',$3)", [ids.day, c, u]);
  await f.pool.query("INSERT INTO queue_points(id,clinic_id,kind,user_id,name_uz_cyrl) VALUES($1,$2,'doctor',$3,'Терапевт 1-хона'),($4,$2,'doctor',$5,'Кардиолог 2-хона')", [ids.pointA, c, ids.a, ids.pointB, ids.b]);
  await f.pool.query("INSERT INTO patients(id,clinic_id,display_name,full_name,provenance) VALUES($1,$2,'Synthetic Bemor Bir','Synthetic Bemor Bir','{}'),($3,$2,'Synthetic Bemor Ikki','Synthetic Bemor Ikki','{}'),($4,$2,'Synthetic Bemor Uch','Synthetic Bemor Uch','{}')", [ids.p1, c, ids.p2, ids.p3]);
  // Registration (task 007) routes P1 to A and P2 to B.
  await f.pool.query('INSERT INTO patient_assignments(clinic_id,patient_id,user_id) VALUES($1,$2,$3),($1,$4,$5),($1,$6,$3)', [c, ids.p1, ids.a, ids.p2, ids.b, ids.p3]);
  await f.pool.query(`INSERT INTO services(id,clinic_id,kind,name_uz_cyrl) VALUES($1,$2,'consultation','Терапевт кўриги'),($3,$2,'lab','Умумий қон таҳлили'),
    ($4,$2,'procedure','Нархсиз муолажа'),($5,$2,'medicine','Синтетик дори')`, [ids.consult, c, ids.labTest, ids.unpriced, ids.medicine]);
  for (const [s, price] of [[ids.consult, 100000], [ids.labTest, 45000], [ids.medicine, 1000]] as const)
    await f.pool.query("INSERT INTO service_prices(id,clinic_id,service_id,price_uzs,effective_from,set_by) VALUES($1,$2,$3,$4,'2026-01-01',$5)", [key(), c, s, price, u]);
  v1 = await visitWithTicket(ids.p1, ids.pointA, 1);
  v2 = await visitWithTicket(ids.p2, ids.pointB, 1);
  v3 = await visitWithTicket(ids.p3, ids.pointA, 2);
  A = f.client(); B = f.client(); lab = f.client(); cashier = f.client();
  await A.login('doctor.a@example.test'); await B.login('doctor.b@example.test'); await lab.login('lab@example.test'); await cashier.login('cashier.010@example.test');
});
test.after(async () => { await f?.close(); });

const ROUTES: [string, unknown][] = [
  // The queue itself (queue/mine, queue/call-next, ticket status) is task 007's API, guarded in registration.test.ts.
  [`doctor/tickets/${randomUUID()}/start`, {}],
  [`doctor/tickets/${randomUUID()}/complete`, {}], [`doctor/patients/${randomUUID()}`, undefined], ['doctor/catalog', undefined],
  [`doctor/encounters/${randomUUID()}`, undefined], [`doctor/encounters/${randomUUID()}/note`, {}], [`doctor/encounters/${randomUUID()}/approve`, {}],
  [`doctor/encounters/${randomUUID()}/orders`, {}], [`doctor/encounters/${randomUUID()}/prescription`, undefined], [`doctor/encounters/${randomUUID()}/prescription.pdf`, undefined],
  ['lab/orders', undefined], [`lab/orders/${randomUUID()}`, undefined], [`lab/orders/${randomUUID()}/results`, {}], [`lab/orders/${randomUUID()}/confirm`, {}]
];

test('every new route rejects anonymous, wrong-role and other-clinic callers before reading the body', async () => {
  const anonymous = f.client(), foreign = f.client(); await foreign.login('other@example.test');
  for (const [path, body] of ROUTES) {
    assert.equal((await anonymous.request(url(path), body)).status, 401, path);
    assert.equal((await cashier.request(url(path), body)).status, 403, `cashier ${path}`);
    assert.equal((await foreign.request(url(path), body)).status, 404, `foreign ${path}`);
  }
  // Doctors cannot write lab results; lab staff cannot use any doctor route.
  for (const [path, body] of ROUTES) {
    if (path.startsWith('lab/') && body !== undefined) assert.equal((await A.request(url(path), body)).status, 403, `doctor ${path}`);
    if (path.startsWith('doctor/')) assert.equal((await lab.request(url(path), body)).status, 403, `lab ${path}`);
  }
});

test('doctor sees only own queue; another doctor\'s patient, ticket and encounter read as 404', async () => {
  const qa = await json(await A.request(url('queue/mine')));
  assert.deepEqual(qa.map((t: { id: string }) => t.id), [v1.ticket, v3.ticket]);
  assert.equal(qa[0].patient.fullName, 'Synthetic Bemor Bir');
  assert.equal((await A.request(url(`doctor/patients/${ids.p2}`))).status, 404);
  assert.equal((await A.request(url(`doctor/patients/${ids.p1}`))).status, 200);
  for (const op of ['start', 'complete']) assert.equal((await A.request(url(`doctor/tickets/${v2.ticket}/${op}`), { idempotencyKey: key() })).status, 404, op);
  assert.equal((await A.request(url(`queue/tickets/${v2.ticket}/status`), { status: 'called', idempotencyKey: key() })).status, 404);
  const started = await json(await B.request(url(`doctor/tickets/${v2.ticket}/start`), { idempotencyKey: key() }));
  assert.equal((await A.request(url(`doctor/encounters/${started.encounterId}`))).status, 404);
  assert.equal((await A.request(url(`doctor/encounters/${started.encounterId}/note`), { idempotencyKey: key(), expectedRevision: 0, note: { reported: 'x', observed: '', assessment: '', plan: '' } })).status, 404);
  // The notebook enforces the same assignment scope.
  assert.equal((await A.request(url(`patients/${ids.p2}`))).status, 404);
});

let encounterA = '';
test('call next (task 007 API) calls one patient even from several devices; completing the consultation twice completes the line once', async () => {
  // Two patients wait for doctor A. Five presses at once, each with its own key, call exactly one of them.
  const calls = await Promise.all([1, 2, 3, 4, 5].map(() => A.request(url('queue/call-next'), { idempotencyKey: key() })));
  const bodies0 = await Promise.all(calls.map(json));
  assert.deepEqual(bodies0.map(b => b.ticket.id), Array(5).fill(v1.ticket));
  assert.equal(bodies0.filter(b => !b.alreadyActive).length, 1);
  const statuses = async () => (await f.pool.query('SELECT id, status FROM queue_tickets WHERE id = ANY($1) ORDER BY number', [[v1.ticket, v3.ticket]])).rows.map(r => r.status);
  assert.deepEqual(await statuses(), ['called', 'waiting']);
  // A manager calling for the doctor's point does not call a second patient either.
  const owner = f.client(); await owner.login();
  const managerCall = await json(await owner.request(url('queue/call-next'), { queuePointId: ids.pointA, idempotencyKey: key() }));
  assert.equal(managerCall.ticket?.id, v1.ticket, JSON.stringify(managerCall)); assert.equal(managerCall.alreadyActive, true);
  assert.deepEqual(await statuses(), ['called', 'waiting']);
  const start = await json(await A.request(url(`doctor/tickets/${v1.ticket}/start`), { idempotencyKey: key() }));
  const again = await json(await A.request(url(`doctor/tickets/${v1.ticket}/start`), { idempotencyKey: key() }));
  assert.equal(again.encounterId, start.encounterId, 'one encounter per doctor per visit');
  encounterA = start.encounterId;
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM encounters WHERE visit_id=$1', [v1.visit])).rows[0].n, 1);
  const results = await Promise.all([1, 2].map(() => A.request(url(`doctor/tickets/${v1.ticket}/complete`), { idempotencyKey: key() })));
  assert.deepEqual(results.map(r => r.status), [200, 200]);
  const bodies = await Promise.all(results.map(json));
  assert.deepEqual(bodies.map(b => b.completedNow).sort(), [false, true]);
  const line = (await f.pool.query('SELECT status, completed_by, performer_user_id FROM charge_lines WHERE id=$1', [v1.line])).rows[0];
  assert.deepEqual(line, { status: 'completed', completed_by: ids.a, performer_user_id: ids.a });
  assert.equal((await f.pool.query("SELECT count(*)::int n FROM audit_events WHERE action='doctor.consultation_completed' AND resource_id=$1", [v1.ticket])).rows[0].n, 2);
  assert.equal((await f.pool.query('SELECT status FROM queue_tickets WHERE id=$1', [v1.ticket])).rows[0].status, 'completed');
  // Only after the active patient is finished does call next move on.
  assert.equal((await json(await A.request(url('queue/call-next'), { idempotencyKey: key() }))).ticket.id, v3.ticket);
});

test('note approval writes an immutable version; later edits are explicit amendments; the PDF follows the approved version', async () => {
  assert.ok(encounterA);
  const base = url(`doctor/encounters/${encounterA}`);
  const rx = [{ medicine: 'Парацетамол 500 мг', dose: '1 таблетка', frequency: 'кунига 3 марта', duration: '5 кун', notes: 'овқатдан кейин' }];
  const note = { reported: 'Синтетик шикоят: 3 кун иситма', observed: '', assessment: 'J06.9 ЎРВИ (синтетик)', plan: 'Кўп суюқлик' };
  // Approving an empty note is refused; a stale revision is refused.
  assert.equal((await A.request(base + '/approve', { idempotencyKey: key(), expectedRevision: 1 })).status, 409);
  const saved = await json(await A.request(base + '/note', { idempotencyKey: key(), expectedRevision: 0, note, prescription: rx }));
  assert.equal(saved.revision, 1);
  assert.equal((await A.request(base + '/note', { idempotencyKey: key(), expectedRevision: 0, note, prescription: rx })).status, 409, 'stale save');
  const approveInput = { idempotencyKey: key(), expectedRevision: 1 };
  const approved = await json(await A.request(base + '/approve', approveInput));
  assert.equal(approved.revision, 2);
  assert.deepEqual(await json(await A.request(base + '/approve', approveInput)), approved, 'retry returns the same approval');
  assert.equal((await A.request(base + '/approve', { idempotencyKey: key(), expectedRevision: 2 })).status, 409, 'already approved');
  const stored = (await f.pool.query('SELECT version_id, revision, approved_by, amends_approval_id FROM note_approvals WHERE id=$1', [approved.approvalId])).rows[0];
  assert.deepEqual(stored, { version_id: approved.versionId, revision: 2, approved_by: ids.a, amends_approval_id: null });
  const version = (await f.pool.query('SELECT data FROM document_versions WHERE id=$1', [approved.versionId])).rows[0].data;
  assert.ok(version.fields.every((x: { status: string }) => x.status === 'clinician_confirmed'));
  assert.equal(version.fields.find((x: { key: string }) => x.key === 'observed').value, null, 'blank stays unrecorded, not normal');
  await assert.rejects(f.pool.query("UPDATE document_versions SET data='{}' WHERE id=$1", [approved.versionId]));
  await assert.rejects(f.pool.query('DELETE FROM note_approvals WHERE id=$1', [approved.approvalId]));

  const view = await json(await A.request(base));
  assert.equal(view.approval.current, true); assert.deepEqual(view.prescription, rx);
  // Editing after approval needs a reason and becomes an amendment of that approval.
  const changed = { ...note, assessment: 'J20.9 Ўткир бронхит (синтетик)' };
  assert.equal((await A.request(base + '/note', { idempotencyKey: key(), expectedRevision: 2, note: changed, prescription: rx })).status, 409);
  const amended = await json(await A.request(base + '/note', { idempotencyKey: key(), expectedRevision: 2, note: changed, prescription: [], amendmentReason: 'Ташхис аниқлаштирилди' }));
  assert.equal(amended.kind, 'amendment');
  const draft = (await f.pool.query('SELECT data FROM document_versions WHERE id=$1', [amended.versionId])).rows[0].data;
  assert.equal(draft.amendsApprovalId, approved.approvalId); assert.equal(draft.parentVersionId, approved.versionId);
  // The prescription still shows the approved version, not the newer draft.
  const doc = await json(await A.request(base + '/prescription'));
  assert.equal(doc.versionId, approved.versionId); assert.equal(doc.diagnosis, note.assessment); assert.deepEqual(doc.lines, rx);
  const pdf = await A.request(base + '/prescription.pdf');
  assert.equal(pdf.status, 200); assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  const bytes = Buffer.from(await pdf.arrayBuffer());
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  assert.ok(bytes.includes(approved.versionId) || bytes.includes(Buffer.from('﻿' + `version ${approved.versionId}`, 'utf16le').swap16()), 'PDF metadata names the approved version');
  // Approving the amendment supersedes the first approval; the PDF moves to the new version.
  const second = await json(await A.request(base + '/approve', { idempotencyKey: key(), expectedRevision: 3 }));
  assert.equal((await f.pool.query('SELECT amends_approval_id FROM note_approvals WHERE id=$1', [second.approvalId])).rows[0].amends_approval_id, approved.approvalId);
  const doc2 = await json(await A.request(base + '/prescription'));
  assert.equal(doc2.versionId, second.versionId); assert.deepEqual(doc2.lines, []); assert.equal(doc2.diagnosis, changed.assessment);
});

test('notebook timeline shows the approval; notebook edits after approval are amendments and keep the prescription', async () => {
  const rows = (await json(await A.request(url(`patients/${ids.p1}`)))).visits;
  const visit = rows.find((v: { encounter: { id: string } }) => v.encounter.id === encounterA);
  assert.equal(visit.revision, 4); assert.equal(visit.approval.revision, 4); assert.equal(visit.approval.current, true);
  const note = { reported: 'Қўшимча', observed: '', assessment: 'J20.9', plan: '' };
  const blocked = await A.request(url(`patients/${ids.p1}/encounters/${encounterA}/draft`), { expectedRevision: 4, note, templateId: 'general-note-v1' }, { 'Idempotency-Key': key() });
  assert.equal(blocked.status, 409);
  // Restore a prescription through the doctor route first, approve it, then amend through the notebook.
  const base = url(`doctor/encounters/${encounterA}`);
  const rx = [{ medicine: 'Амоксициллин 500 мг', dose: '1 капсула', frequency: 'кунига 2 марта', duration: '7 кун', notes: '' }];
  const s = await json(await A.request(base + '/note', { idempotencyKey: key(), expectedRevision: 4, note, prescription: rx, amendmentReason: 'Антибиотик қўшилди' }));
  await json(await A.request(base + '/approve', { idempotencyKey: key(), expectedRevision: s.revision }));
  const ok = await A.request(url(`patients/${ids.p1}/encounters/${encounterA}/draft`), { expectedRevision: 6, note: { ...note, plan: 'Назорат 3 кундан кейин' }, templateId: 'general-note-v1', amendmentReason: 'Режа тўлдирилди' }, { 'Idempotency-Key': key() });
  assert.equal(ok.status, 200);
  const body = await json(ok);
  assert.equal(body.version.kind, 'amendment'); assert.equal(body.approval.current, false);
  assert.ok(body.version.fields.some((x: { key: string }) => x.key === 'rx.lines'), 'notebook save keeps the prescription field');
  assert.deepEqual((await json(await A.request(base))).prescription, rx);
});

test('doctor orders a lab test at the current price; lab enters versioned results and confirms once; doctor sees the result', async () => {
  const base = url(`doctor/encounters/${encounterA}`);
  const catalog = await json(await A.request(url('doctor/catalog')));
  assert.ok(catalog.some((s: { id: string }) => s.id === ids.labTest));
  assert.ok(!catalog.some((s: { id: string }) => s.id === ids.unpriced || s.id === ids.medicine), 'unpriced and pharmacy items are not offered');
  assert.equal((await A.request(base + '/orders', { idempotencyKey: key(), items: [{ serviceId: ids.unpriced, quantity: 1 }] })).status, 409, 'no price, no charge');
  assert.equal((await A.request(base + '/orders', { idempotencyKey: key(), items: [{ serviceId: ids.medicine, quantity: 1 }] })).status, 404);
  const orderInput = { idempotencyKey: key(), items: [{ serviceId: ids.labTest, quantity: 1 }] };
  const ordered = await json(await A.request(base + '/orders', orderInput));
  assert.deepEqual(await json(await A.request(base + '/orders', orderInput)), ordered, 'retry orders once');
  const lineId = ordered.lines[0].id;
  const row = (await f.pool.query('SELECT status, unit_price_uzs, source, created_by FROM charge_lines WHERE id=$1', [lineId])).rows[0];
  assert.deepEqual(row, { status: 'ordered', unit_price_uzs: '45000', source: 'doctor', created_by: ids.a });

  const list = await json(await lab.request(url('lab/orders')));
  assert.deepEqual(list.orders.map((o: { id: string }) => o.id), [lineId]);
  assert.equal(list.orders[0].patientName, 'Synthetic Bemor Bir');
  assert.equal((await lab.request(url(`lab/orders/${lineId}/confirm`), { idempotencyKey: key() })).status, 409, 'no result, no confirmation');
  const values = [{ name: 'Гемоглобин', value: '128', unit: 'г/л', reference: '120–160' }, { name: 'Лейкоцитлар', value: '11,2', unit: '×10⁹/л', reference: '4–9' }];
  const r1 = await json(await lab.request(url(`lab/orders/${lineId}/results`), { idempotencyKey: key(), expectedVersion: 0, values, comment: '' }));
  assert.equal(r1.version, 1);
  assert.equal((await lab.request(url(`lab/orders/${lineId}/results`), { idempotencyKey: key(), expectedVersion: 0, values, comment: '' })).status, 409, 'stale result');
  await assert.rejects(f.pool.query("UPDATE lab_results SET result='{}' WHERE id=$1", [r1.id]));
  const confirms = await Promise.all([1, 2].map(() => lab.request(url(`lab/orders/${lineId}/confirm`), { idempotencyKey: key() })));
  assert.deepEqual(confirms.map(r => r.status), [200, 200]);
  assert.deepEqual((await Promise.all(confirms.map(json))).map(b => b.completedNow).sort(), [false, true]);
  const done = (await f.pool.query('SELECT status, completed_by, unit_price_uzs FROM charge_lines WHERE id=$1', [lineId])).rows[0];
  assert.deepEqual(done, { status: 'completed', completed_by: ids.lab, unit_price_uzs: '45000' });
  // A correction after confirmation is a new version; the charge is untouched.
  const r2 = await json(await lab.request(url(`lab/orders/${lineId}/results`), { idempotencyKey: key(), expectedVersion: 1, values: [values[0]!], comment: 'Қайта ўлчанди' }));
  assert.equal(r2.version, 2);
  const detail = await json(await lab.request(url(`lab/orders/${lineId}`)));
  assert.deepEqual(detail.versions.map((v: { version: number }) => v.version), [2, 1]);
  assert.equal(detail.versions[0].afterConfirmation, true);
  assert.equal(JSON.stringify(detail).includes('Синтетик шикоят'), false, 'lab detail carries no note text');
  const card = await json(await A.request(url(`doctor/patients/${ids.p1}`)));
  const result = card.labs.find((l: { id: string }) => l.id === lineId);
  assert.equal(result.status, 'completed'); assert.equal(result.result.version, 2); assert.equal(result.result.values[0].value, '128');
  assert.equal(card.visits[0].diagnosis, 'J20.9');
});

test('a price set through the catalog (task 005) is the price the doctor sees and the price charged; earlier lines keep theirs', async () => {
  const owner = f.client(); await owner.login();
  const set = await owner.request(url('catalog/prices'), { serviceId: ids.labTest, priceUzs: '52000', idempotencyKey: key() });
  assert.equal(set.status, 201);
  const offered = (await json(await A.request(url('doctor/catalog')))).find((s: { id: string }) => s.id === ids.labTest);
  assert.equal(offered.priceUzs, '52000');
  const ordered = await json(await A.request(url(`doctor/encounters/${encounterA}/orders`), { idempotencyKey: key(), items: [{ serviceId: ids.labTest, quantity: 1 }] }));
  assert.equal(ordered.lines[0].unitPriceUzs, '52000');
  const prices = (await f.pool.query("SELECT unit_price_uzs::text p FROM charge_lines WHERE service_id=$1 AND source='doctor' ORDER BY created_at", [ids.labTest])).rows.map(r => r.p);
  assert.deepEqual(prices, ['45000', '52000']);
});

test('lab cannot read notes or touch payments; doctor cannot edit lab results; revoked routing removes access', async () => {
  // The notebook answers a denied patient read with a uniform 404 (no existence oracle); either way, no note.
  assert.ok([403, 404].includes((await lab.request(url(`patients/${ids.p1}`))).status));
  assert.equal((await lab.request(url('patients'))).status, 403);
  assert.equal((await lab.request(url('cashier'))).status, 403);
  assert.equal((await lab.request(url(`cashier/visits/${v1.visit}/payments`), {})).status, 403);
  const line = (await f.pool.query("SELECT id FROM charge_lines WHERE source='doctor' LIMIT 1")).rows[0].id;
  assert.equal((await A.request(url(`lab/orders/${line}/results`), { idempotencyKey: key(), expectedVersion: 2, values: [{ name: 'x', value: '1' }] })).status, 403);
  assert.equal((await A.request(url(`lab/orders/${line}/confirm`), { idempotencyKey: key() })).status, 403);
  await f.pool.query('DELETE FROM patient_assignments WHERE clinic_id=$1 AND patient_id=$2 AND user_id=$3', [f.owner.clinicId, ids.p1, ids.a]);
  assert.equal((await A.request(url(`doctor/encounters/${encounterA}`))).status, 404);
  assert.equal((await A.request(url(`doctor/encounters/${encounterA}/prescription.pdf`))).status, 404);
  assert.equal((await A.request(url(`doctor/patients/${ids.p1}`))).status, 404);
  await f.pool.query('INSERT INTO patient_assignments(clinic_id,patient_id,user_id) VALUES($1,$2,$3)', [f.owner.clinicId, ids.p1, ids.a]);
});

test('an approved note blocks a later assistant approval of the same document', async () => {
  const { approve } = await import('../../src/modules/assistant/service.js');
  const { transaction } = await import('../../src/server/database.js');
  await assert.rejects(transaction(f.pool, async tx => {
    // Minimal assistant draft on the approved document; approval must refuse before writing anything.
    const draft = randomUUID();
    await tx.query("INSERT INTO assistant_drafts(id,clinic_id,patient_id,encounter_id,form_id) VALUES($1,$2,$3,$4,'gp-v1')", [draft, f.owner.clinicId, ids.p1, encounterA]);
    return approve(tx, { userId: ids.a, sessionId: randomUUID(), expiresAt: new Date(Date.now() + 3600e3).toISOString() }, f.owner.clinicId, ids.p1, encounterA, { expectedDraftRevision: 0, expectedDocumentRevision: 0, fieldRevisions: {} });
  }), (e: Error & { code?: string }) => e.code === 'INVALID_TRANSITION');
});
