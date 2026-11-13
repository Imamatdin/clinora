import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { httpFixture, patientInput, encounterInput, key } from './fixture.js';
import { inpatientGraph } from '../helpers/inpatient.js';
import { seedRegistration, openDay } from './registration-fixture.js';
import { transaction } from '../../src/server/database.js';
import { requireRole } from '../../src/server/roles.js';
import { setOwnPin } from '../../src/modules/devices/actions.js';
import { createVisit } from '../../src/modules/registration/actions.js';
import { dispatchAccountNotices, renderNotice } from '../../src/modules/telegram/notify.js';
import { digest, passwordHash } from '../../src/server/security.js';

// Task 022 regression tests: one per audit item. Every value is synthetic.
type F = Awaited<ReturnType<typeof httpFixture>>;
const id = () => randomUUID();

/** A staff account this clinic manages, signed in with a known password (no temporary-password step). */
async function staff(f: F, login: string, roles: string[], opts: { scope?: 'clinic' | 'assigned' } = {}) {
  const userId = id(), password = 'Synthetic-' + id();
  await f.pool.query('INSERT INTO accounts(id,login,display_name,password_hash,managed_by_clinic_id) VALUES($1,$2,$3,$4,$5)',
    [userId, login, 'Синтетик ' + login, await passwordHash(password), f.owner.clinicId]);
  await f.pool.query("INSERT INTO memberships(id,clinic_id,user_id,role,clinical_access,patient_scope,status,granted_by) VALUES($1,$2,$3,$4,$5,$6,'active',$7)",
    [id(), f.owner.clinicId, userId, roles.includes('doctor') ? 'clinician' : 'administrator', roles.includes('doctor'), opts.scope ?? 'assigned', f.owner.userId]);
  for (const role of roles) await f.pool.query('INSERT INTO membership_roles(clinic_id,user_id,role,granted_by) VALUES($1,$2,$3,$4)', [f.owner.clinicId, userId, role, f.owner.userId]);
  const client = f.client();
  const r = await client.request('/api/auth/login', { identifier: login, password }); assert.equal(r.status, 200);
  const me = await (await client.request('/api/auth/me')).json();
  return { userId, login, password, client: withCsrf(client, me.csrf), name: 'Синтетик ' + login };
}
/** The fixture client only sets CSRF in login(); identifier sign-in needs it attached by hand. */
function withCsrf(c: ReturnType<F['client']>, csrf: string) {
  return { ...c, request: (path: string, body?: unknown, extra: Record<string, string> = {}) => c.request(path, body, body === undefined ? extra : { 'X-CSRF-Token': csrf, ...extra }) };
}

test('022.1 approval PIN: one counter per approver across cashier and ward and devices; real targets only; manager clears; 6 digits; Telegram notice', async t => {
  const f = await httpFixture(); t.after(() => f.close());
  const owner = f.client(); await owner.login();
  const base = `/api/clinics/${f.owner.clinicId}`, g = await inpatientGraph(f, 1);
  await f.pool.query("INSERT INTO memberships(id,clinic_id,user_id,status,granted_by) VALUES($1,$2,$3,'active',$4)", [id(), f.owner.clinicId, f.other.userId, f.owner.userId]);
  await f.pool.query("INSERT INTO membership_roles(clinic_id,user_id,role,granted_by) VALUES($1,$2,'administrator',$3)", [f.owner.clinicId, f.other.userId, f.owner.userId]);
  // CEO and administrator PINs need 6 digits.
  await assert.rejects(transaction(f.pool, tx => setOwnPin(tx, f.other.userId, '4826')), /INVALID_INPUT/);
  // A PIN set before task 022 (length unknown) approves nothing, is not counted, and must be changed at next sign-in.
  await f.pool.query('INSERT INTO account_pins(account_id,pin_hash) VALUES($1,$2)', [f.other.userId, await passwordHash('4826')]);
  const admin = f.client(); await admin.login('other@example.test');
  assert.equal((await (await admin.request('/api/auth/me')).json()).pinChangeRequired, true);
  const discount = { approverId: f.other.userId, pin: '4826', visitId: g.visit, operation: 'discount', payload: { kind: 'fixed', amount: '10', reason: 'Synthetic waiver' } };
  assert.equal((await owner.request(base + '/cashier/approvals', discount)).status, 403);
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM approval_pin_attempts WHERE account_id=$1 AND failed_attempts>0', [f.other.userId])).rows[0].n, 0);
  await transaction(f.pool, tx => setOwnPin(tx, f.other.userId, '482613'));
  assert.equal((await (await admin.request('/api/auth/me')).json()).pinChangeRequired, false);
  await f.pool.query('INSERT INTO telegram_links(account_id,telegram_user_id,clinic_id) VALUES($1,$2,$3)', [f.other.userId, 880022, f.owner.clinicId]);

  // The owner works on an enrolled shared PC (ward overrides need one).
  const device = id();
  await f.pool.query('INSERT INTO devices(id,clinic_id,label,token_hash,created_by) VALUES($1,$2,$3,$4,$5)', [device, f.owner.clinicId, 'Synthetic ward PC', digest(digest(device)), f.owner.userId]);
  await f.pool.query("UPDATE sessions SET via='device',device_id=$2 WHERE token_hash=$1", [digest(decodeURIComponent(owner.cookie.split('=')[1]!)), device]);
  const pc = { Cookie: owner.cookie + `; clinora_device=${digest(device)}` };
  const approve = (body: unknown) => owner.request(base + '/cashier/approvals', body, pc);
  const wrong = { ...discount, pin: '000000' };
  const override = (stay: string, pin: string) => owner.request(base + `/inpatient/${stay}/services`, { key: key(), serviceId: g.services.medicine, quantity: 12, override: { reason: 'Synthetic shortage', approverId: f.other.userId, pin } }, pc);

  // Guesses against targets that do not exist in this clinic are refused before the PIN is checked and never counted.
  for (let i = 0; i < 6; i++) assert.equal((await approve({ ...wrong, visitId: id() })).status, 404);
  assert.equal((await approve({ ...wrong, operation: 'refund', payload: { shiftId: id(), paymentId: id(), amount: '10', reason: 'x', key: key() } })).status, 404);
  assert.equal((await approve({ ...wrong, operation: 'void', payload: { discountId: id(), reason: 'x' } })).status, 404);
  assert.equal((await override(id(), '000000')).status, 404);
  const counted = async () => (await f.pool.query('SELECT failed_attempts, locked_at IS NOT NULL locked FROM approval_pin_attempts WHERE account_id=$1', [f.other.userId])).rows[0] ?? { failed_attempts: 0, locked: false };
  assert.deepEqual(await counted(), { failed_attempts: 0, locked: false });

  // Three cashier failures and two ward failures share one counter and lock approving.
  for (let i = 0; i < 3; i++) assert.equal((await approve(wrong)).status, 403);
  for (let i = 0; i < 2; i++) assert.equal((await override(g.admission, '000000')).status, 403);
  assert.deepEqual(await counted(), { failed_attempts: 5, locked: true });
  assert.equal((await approve({ ...discount, pin: '482613' })).status, 403, 'locked: the right PIN is refused');
  assert.equal((await override(g.admission, '482613')).status, 403, 'locked for ward overrides too');
  // Another session elsewhere is locked as well.
  const elsewhere = f.client(); await elsewhere.login();
  assert.equal((await elsewhere.request(base + '/cashier/approvals', { ...discount, pin: '482613' })).status, 403);

  // The approver hears about it on Telegram, with no amounts or patient data.
  // (The app's background worker may have sent it already; either way it goes out exactly once.)
  await dispatchAccountNotices(f.pool, f.config.telegram, f.config.origin);
  await dispatchAccountNotices(f.pool, f.config.telegram, f.config.origin);
  const sent = f.telegramApi.calls.filter(c => c.method === 'sendMessage' && String((c.payload as { chat_id: unknown }).chat_id) === '880022').map(c => (c.payload as { text: string }).text);
  assert.deepEqual(sent, [renderNotice('access.approval_locked', {}, 'uz-Cyrl', f.config.origin).text]);
  assert.ok(!sent[0]!.includes('Синтетик Бемор') && !/\d{2,}/.test(sent[0]!));

  // Nobody clears their own lock; no time expiry; a CEO clears it (audited) and the right PIN works again.
  assert.equal((await admin.request(base + `/staff/${f.other.userId}/approval-unlock`, {})).status, 403);
  await f.pool.query("UPDATE approval_pin_attempts SET locked_at=now()-interval '90 days' WHERE account_id=$1", [f.other.userId]);
  assert.equal((await approve({ ...discount, pin: '482613' })).status, 403);
  const access = await (await elsewhere.request(base + '/staff/access')).json();
  assert.equal(access.find((r: { userId: string }) => r.userId === f.other.userId).approvalLocked, true);
  assert.equal((await elsewhere.request(base + `/staff/${f.other.userId}/approval-unlock`, {})).status, 200);
  assert.equal((await f.pool.query("SELECT count(*)::int n FROM audit_events WHERE action='approval.unlocked' AND resource_id=$1 AND actor_id=$2", [f.other.userId, f.owner.userId])).rows[0].n, 1);
  assert.equal((await approve({ ...discount, pin: '482613' })).status, 200);
});

test('022.2 doctor workspace rule on assistant and notebook routes: only the encounter clinician reads the draft, writes or approves', async t => {
  const f = await httpFixture(); t.after(() => f.close());
  const C = f.owner.clinicId, A = await staff(f, 'doc.author', ['doctor']), B = await staff(f, 'doc.other', ['doctor'], { scope: 'clinic' });
  const p = await (await A.client.request(`/api/clinics/${C}/patients`, patientInput, { 'Idempotency-Key': key() })).json();
  const e = await (await A.client.request(`/api/clinics/${C}/patients/${p.id}/encounters`, encounterInput, { 'Idempotency-Key': key() })).json();
  const enc = e.encounter.id, draft = `/api/clinics/${C}/patients/${p.id}/encounters/${enc}/draft`, assistant = `/api/clinics/${C}/assistant/patients/${p.id}/encounters/${enc}`;
  const note = { expectedRevision: 0, templateId: 'general-note-v1', note: { reported: 'Synthetic author draft', observed: '', assessment: 'Synthetic draft assessment', plan: '' } };
  assert.equal((await A.client.request(draft, note, { 'Idempotency-Key': key() })).status, 200);
  // B has clinic-wide patient access but is not this encounter's clinician.
  assert.equal((await B.client.request(draft, { ...note, expectedRevision: 1 }, { 'Idempotency-Key': key() })).status, 404, 'notebook overwrite refused');
  assert.equal((await B.client.request(assistant)).status, 404, 'assistant draft not readable');
  assert.equal((await B.client.request(assistant + '/fields/complaints', { action: 'clear', expectedFieldRevision: 0 })).status, 404, 'assistant field write refused');
  assert.equal((await B.client.request(assistant + '/approve', { expectedDraftRevision: 0, expectedDocumentRevision: 1, fieldRevisions: {} })).status, 404, 'assistant approval refused');
  assert.equal((await B.client.request(assistant + '/captures', { clientKey: key(), mimeType: 'audio/webm' })).status, 404, 'no capture on another clinician\'s visit');
  assert.equal((await f.pool.query('SELECT current_revision FROM documents WHERE encounter_id=$1', [enc])).rows[0].current_revision, 1, 'nothing written by B');
  // B reads another clinician's encounter only as its approved version: none yet, so no draft text leaks.
  const before = await (await B.client.request(`/api/clinics/${C}/patients/${p.id}`)).json();
  assert.equal(before.visits[0].version, null);
  assert.ok(!JSON.stringify(before).includes('Synthetic author draft'));
  // The author approves in the doctor workspace; B now reads exactly the approved version.
  const saved = await (await A.client.request(`/api/clinics/${C}/doctor/encounters/${enc}/note`, { idempotencyKey: key(), expectedRevision: 1, note: { reported: 'Synthetic approved', observed: '', assessment: 'J06.9', plan: '' } })).json();
  const approved = await (await A.client.request(`/api/clinics/${C}/doctor/encounters/${enc}/approve`, { idempotencyKey: key(), expectedRevision: saved.revision })).json();
  assert.equal((await A.client.request(draft, { ...note, expectedRevision: approved.revision, amendmentReason: 'Synthetic later draft', note: { ...note.note, reported: 'Synthetic unapproved amendment' } }, { 'Idempotency-Key': key() })).status, 200);
  const after = await (await B.client.request(`/api/clinics/${C}/patients/${p.id}`)).json();
  assert.equal(after.visits[0].version.id, approved.versionId);
  assert.ok(!JSON.stringify(after).includes('Synthetic unapproved amendment'));
  // The author still sees their own current draft.
  assert.ok(JSON.stringify(await (await A.client.request(`/api/clinics/${C}/patients/${p.id}`)).json()).includes('Synthetic unapproved amendment'));
});

test('022.3 public self-registration is closed', async t => {
  const f = await httpFixture(); t.after(() => f.close());
  const c = f.client();
  const r = await c.request('/api/auth/register', { email: 'walk-in@example.test', displayName: 'Synthetic Walk-in', password: 'Synthetic-password-1234' });
  assert.equal(r.status, 404);
  assert.equal((await f.pool.query("SELECT count(*)::int n FROM accounts WHERE email='walk-in@example.test'")).rows[0].n, 0);
});

test('022.4 credential resets: administrator resets of a doctor need CEO confirmation; the person is told on Telegram and at next sign-in', async t => {
  const f = await httpFixture(); t.after(() => f.close());
  const C = f.owner.clinicId, base = `/api/clinics/${C}`, ceo = f.client(); await ceo.login();
  const admin = await staff(f, 'anna.admin', ['administrator']), doctor = await staff(f, 'doc.target', ['doctor']), cashier = await staff(f, 'bek.cashier', ['cashier']);
  await f.pool.query('INSERT INTO telegram_links(account_id,telegram_user_id,clinic_id) VALUES($1,$2,$3)', [doctor.userId, 990011, C]);
  const hashBefore = (await f.pool.query('SELECT password_hash FROM accounts WHERE id=$1', [doctor.userId])).rows[0].password_hash;

  // Administrator -> doctor: held for the CEO; nothing changes; repeating does not create a second request.
  const first = await admin.client.request(`${base}/staff/${doctor.userId}/password-reset`, {});
  assert.equal(first.status, 202); const pending = await first.json();
  assert.equal(pending.pendingConfirmation, true);
  assert.equal((await f.pool.query('SELECT password_hash FROM accounts WHERE id=$1', [doctor.userId])).rows[0].password_hash, hashBefore);
  assert.equal((await (await admin.client.request(`${base}/staff/${doctor.userId}/password-reset`, {})).json()).requestId, pending.requestId);
  assert.equal((await f.pool.query("SELECT count(*)::int n FROM account_notices WHERE account_id=$1 AND kind='credential_request'", [f.owner.userId])).rows[0].n, 1, 'CEO told once');
  // Only a CEO confirms.
  assert.equal((await admin.client.request(`${base}/staff/credential-requests`)).status, 403);
  assert.equal((await admin.client.request(`${base}/staff/credential-requests/${pending.requestId}/confirm`, {})).status, 403);
  const list = await (await ceo.request(`${base}/staff/credential-requests`)).json();
  assert.deepEqual(list.map((r: { id: string; kind: string; target: string; requester: string }) => [r.id, r.kind, r.target, r.requester]), [[pending.requestId, 'password', doctor.name, admin.name]]);
  assert.equal((await ceo.request(`${base}/staff/credential-requests/${pending.requestId}/confirm`, {})).status, 200);
  // Confirmed: the administrator's reset goes through once; the next one needs a new confirmation.
  const done = await admin.client.request(`${base}/staff/${doctor.userId}/password-reset`, {});
  assert.equal(done.status, 200); const { temporaryPassword } = await done.json();
  assert.equal((await admin.client.request(`${base}/staff/${doctor.userId}/password-reset`, {})).status, 202, 'confirmation is single-use');
  // A non-doctor's reset by the administrator needs no CEO step (the person is still told).
  assert.equal((await admin.client.request(`${base}/staff/${cashier.userId}/password-reset`, {})).status, 200);
  assert.equal((await f.pool.query("SELECT count(*)::int n FROM account_notices WHERE account_id=$1 AND kind='password_reset'", [cashier.userId])).rows[0].n, 1);

  // The doctor is told on Telegram (no names or patient data in the message)...
  await dispatchAccountNotices(f.pool, f.config.telegram, f.config.origin);
  const toDoctor = f.telegramApi.calls.filter(c => c.method === 'sendMessage' && String((c.payload as { chat_id: unknown }).chat_id) === '990011');
  assert.deepEqual(toDoctor.map(c => (c.payload as { text: string }).text), [renderNotice('access.password_reset', {}, 'uz-Cyrl', f.config.origin).text]);
  // ...and on next sign-in: "Your password was reset by <name> at <time>".
  const d = f.client();
  assert.equal((await d.request('/api/auth/login', { identifier: doctor.login, password: temporaryPassword })).status, 200);
  const me = await (await d.request('/api/auth/me')).json();
  assert.equal(me.mustChangePassword, true);
  assert.deepEqual(me.notices.map((n: { kind: string; actorName: string }) => [n.kind, n.actorName]), [['password_reset', admin.name]]);
  assert.ok(!Number.isNaN(Date.parse(me.notices[0].at)));
  const dc = withCsrf(d, me.csrf);
  assert.equal((await dc.request('/api/auth/password', { currentPassword: temporaryPassword, newPassword: 'Synthetic-new-password-9' })).status, 200);
  assert.equal((await dc.request('/api/auth/notices/seen', { ids: [me.notices[0].id] })).status, 200);
  assert.deepEqual((await (await d.request('/api/auth/me')).json()).notices, []);
  // Nobody dismisses someone else's notice.
  const ceoNotice = (await f.pool.query("SELECT id FROM account_notices WHERE account_id=$1 AND kind='credential_request'", [f.owner.userId])).rows[0].id;
  await dc.request('/api/auth/notices/seen', { ids: [ceoNotice] });
  assert.equal((await f.pool.query('SELECT seen_at FROM account_notices WHERE id=$1', [ceoNotice])).rows[0].seen_at, null);

  // Telegram invite for the doctor: same CEO step; the warning goes to the chat linked when the invite was made.
  const inv = await admin.client.request(`${base}/staff/${doctor.userId}/telegram-invite`, {});
  assert.equal(inv.status, 202); const invReq = await inv.json();
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM telegram_invites WHERE account_id=$1', [doctor.userId])).rows[0].n, 0, 'no invite before confirmation');
  assert.equal((await ceo.request(`${base}/staff/credential-requests/${invReq.requestId}/confirm`, {})).status, 200);
  assert.equal((await admin.client.request(`${base}/staff/${doctor.userId}/telegram-invite`, {})).status, 201);
  assert.equal((await f.pool.query("SELECT telegram_chat::text chat FROM account_notices WHERE account_id=$1 AND kind='telegram_invite'", [doctor.userId])).rows[0].chat, '990011');
  // A CEO's own reset of a doctor needs no confirmation.
  assert.equal((await ceo.request(`${base}/staff/${doctor.userId}/password-reset`, {})).status, 200);
});

test('022.5 routing access lasts while the visit is open, the clinic window after close, or the stay; re-routing renews it', async t => {
  const f = await httpFixture(); t.after(() => f.close());
  const C = f.owner.clinicId, base = `/api/clinics/${C}`, ceo = f.client(); await ceo.login();
  const g = await seedRegistration(f.pool, C, f.owner.userId, f.password);
  const day = await openDay(f.pool, C, f.owner.userId);
  const doctor = f.client(); await doctor.login(g.email('doctor-a'));
  const patient = id();
  await f.pool.query(`INSERT INTO patients(id,clinic_id,display_name,provenance) VALUES($1,$2,'Синтетик Йўналтирилган','{"source":"manual"}')`, [patient, C]);
  const route = () => transaction(f.pool, async tx => createVisit(await requireRole(tx, g.registrar, C, ['registrar']), { patientId: patient, points: [{ queuePointId: g.pointA, serviceIds: [] }], idempotencyKey: key() }));
  const first = await route();
  const card = async () => (await doctor.request(`${base}/doctor/patients/${patient}`)).status;
  const closeAgo = (visit: string, days: number) => f.pool.query("UPDATE visits SET status='closed', closed_at=now()-make_interval(days => $2) WHERE id=$1", [visit, days]);
  assert.equal(await card(), 200, 'open visit');
  await closeAgo(first.visitId, 10);
  assert.equal(await card(), 200, 'closed 10 days ago, inside the default 30');
  assert.equal((await ceo.request(`${base}/settings/access`, { assignmentDays: 5, telegramVoice: false })).status, 200);
  assert.equal(await card(), 404, 'clinic window shortened to 5 days');
  assert.equal((await doctor.request(`${base}/settings/access`, { assignmentDays: 3650, telegramVoice: true })).status, 403, 'only the CEO changes it');
  assert.equal((await ceo.request(`${base}/settings/access`, { assignmentDays: 30, telegramVoice: false })).status, 200);
  await f.pool.query("UPDATE visits SET closed_at=now()-interval '31 days' WHERE id=$1", [first.visitId]);
  assert.equal(await card(), 404, 'expired 30 days after close');
  // Also out of the doctor's queue reads and the notebook.
  assert.equal((await doctor.request(`${base}/patients/${patient}`)).status, 404);
  // Admitted patients keep access during the stay.
  const stay = id(), dept = (await f.pool.query('SELECT id FROM departments WHERE clinic_id=$1 LIMIT 1', [C])).rows[0].id;
  await f.pool.query("INSERT INTO visits(id,clinic_id,patient_id,business_day_id,type,created_by) VALUES($1,$2,$3,$4,'inpatient',$5)", [stay, C, patient, day, f.owner.userId]);
  await f.pool.query('INSERT INTO admissions(id,clinic_id,visit_id,department_id,attending_user_id,admitted_at) VALUES($1,$2,$3,$4,$5,now())', [id(), C, stay, dept, g.doctorA]);
  assert.equal(await card(), 200, 'admitted');
  await f.pool.query("UPDATE admissions SET status='discharged', discharged_at=now() WHERE visit_id=$1", [stay]);
  assert.equal(await card(), 404, 'discharged; routing grant still expired');
  // Re-routing grants it again, on the new visit.
  const second = await route();
  assert.equal(await card(), 200, 're-routed');
  assert.equal((await f.pool.query('SELECT visit_id FROM patient_assignments WHERE clinic_id=$1 AND patient_id=$2 AND user_id=$3', [C, patient, g.doctorA])).rows[0].visit_id, second.visitId);
});

test('022.6 day-close Telegram notice carries no totals', async t => {
  const f = await httpFixture(); t.after(() => f.close());
  const { dispatchReports } = await import('../../src/modules/reports/notify.js');
  const { closeDay } = await import('../../src/modules/business-days/actions.js');
  const g = await inpatientGraph(f, 0);
  await f.pool.query('INSERT INTO telegram_links(account_id,telegram_user_id,clinic_id) VALUES($1,$2,$3)', [f.owner.userId, 660011, f.owner.clinicId]);
  const day = (await f.pool.query("SELECT id FROM business_days WHERE clinic_id=$1 AND status='open'", [g.clinic])).rows[0].id;
  await transaction(f.pool, async tx => closeDay(await requireRole(tx, f.owner.userId, g.clinic, ['ceo']), day));
  await dispatchReports(f.config, g.clinic);
  const msg = f.telegramApi.calls.filter(c => c.method === 'sendMessage').at(-1)!.payload as { text: string; reply_markup: { inline_keyboard: { web_app: { url: string } }[][] } };
  assert.equal(msg.text, 'Иш куни ёпилди.');
  assert.ok(msg.reply_markup.inline_keyboard[0]![0]!.web_app.url.includes(`report=${day}`), 'button opens the totals in the app');
});

test('022.7 database rule rejections answer 409 with a plain message, other failures stay 503', async t => {
  const f = await httpFixture(); t.after(() => f.close());
  const c = f.client(); await c.login();
  const base = `/api/clinics/${f.owner.clinicId}`;
  // The oldest guards now raise restrict_violation like the rest.
  const day = id();
  await f.pool.query("INSERT INTO business_days(id,clinic_id,business_date,status,opened_by,closed_by,closed_at,close_snapshot) VALUES($1,$2,'2020-01-01','closed',$3,$3,now(),'{}')", [day, f.owner.clinicId, f.owner.userId]);
  await assert.rejects(f.pool.query("UPDATE business_days SET business_date='2020-01-02' WHERE id=$1", [day]), (e: { code?: string }) => e.code === '23001');
  // A rule trigger rejecting a write reaches the client as 409 INVALID_TRANSITION, not 503.
  await f.pool.query("CREATE FUNCTION reject_022() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic closed record' USING ERRCODE='restrict_violation'; END $$; CREATE TRIGGER reject_022 BEFORE INSERT ON patients FOR EACH ROW EXECUTE FUNCTION reject_022()");
  const r = await c.request(`${base}/patients`, patientInput, { 'Idempotency-Key': key() });
  assert.equal(r.status, 409);
  const body = await r.json();
  assert.equal(body.error.code, 'INVALID_TRANSITION');
  assert.match(body.error.message, /closed|can no longer be changed/);
  assert.ok(!body.error.message.includes('synthetic closed record'), 'database text is not exposed');
  await f.pool.query("CREATE OR REPLACE FUNCTION reject_022() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic outage'; END $$");
  assert.equal((await c.request(`${base}/patients`, patientInput, { 'Idempotency-Key': key() })).status, 503);
});
