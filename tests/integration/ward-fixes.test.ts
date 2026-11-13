// Task 020 regression tests: inpatient, pharmacy and surgery review fixes. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { httpFixture } from './fixture.js';
import { inpatientGraph } from '../helpers/inpatient.js';
import { passwordHash, digest, token } from '../../src/server/security.js';
import { createSession } from '../../src/server/access.js';

const key = () => randomUUID();
type F = Awaited<ReturnType<typeof httpFixture>>;
async function setup(t: test.TestContext, days = 0, businessDayAgo = 0) {
  const f = await httpFixture(); t.after(() => f.close()); const client = f.client(); await client.login();
  const g = await inpatientGraph(f, days, businessDayAgo);
  const api = async (path: string, body?: unknown, status = 200) => {
    const r = await client.request(`/api/clinics/${g.clinic}/${path}`, body); const v = await r.json();
    assert.equal(r.status, status, `${path} ${JSON.stringify(v)}`); return v;
  };
  return { f, g, client, api };
}

/** A staff member signed in on an enrolled shared PC (device and session cookies, like a browser). */
async function onDevice(f: F, userId: string, deviceId?: string) {
  const device = deviceId ?? randomUUID(), raw = token();
  if (!deviceId) await f.pool.query("INSERT INTO devices(id,clinic_id,label,token_hash,created_by) VALUES($1,$2,'Палата ПК',$3,$4)", [device, f.owner.clinicId, digest(raw), f.owner.userId]);
  else await f.pool.query('UPDATE devices SET token_hash=$2 WHERE id=$1', [device, digest(raw)]);
  const session = await createSession(f.pool, userId, 'device', device);
  const cookie = `clinora_device=${raw}; clinora_session=${session}`;
  const me = await (await fetch(f.config.origin + '/api/auth/me', { headers: { Cookie: cookie } })).json();
  return {
    device,
    async request(path: string, body?: unknown) {
      return fetch(f.config.origin + path, { method: body === undefined ? 'GET' : 'POST',
        headers: { Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: f.config.origin, 'X-CSRF-Token': me.csrf }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    }
  };
}
async function staff(f: F, roles: string[], pin?: string) {
  const id = randomUUID();
  await f.pool.query("INSERT INTO accounts(id,login,display_name,password_hash) VALUES($1,$2,$3,'disabled')", [id, `ward.${id.slice(0, 8)}`, `Синтетик ${roles[0]}`]);
  await f.pool.query("INSERT INTO memberships(id,clinic_id,user_id,status,granted_by) VALUES($1,$2,$3,'active',$4)", [key(), f.owner.clinicId, id, f.owner.userId]);
  for (const role of roles) await f.pool.query('INSERT INTO membership_roles(clinic_id,user_id,role,granted_by) VALUES($1,$2,$3,$4)', [f.owner.clinicId, id, role, f.owner.userId]);
  if (pin) await f.pool.query('INSERT INTO account_pins(account_id,pin_hash) VALUES($1,$2)', [id, await passwordHash(pin)]);
  return id;
}

test('P1: surgery and pharmacy pickers list a stay admitted on an earlier business day; both charges record', async t => {
  const { f, g, api } = await setup(t, 1, 1);
  const oldDay = (await f.pool.query("SELECT id FROM business_days WHERE clinic_id=$1 AND status='open'", [g.clinic])).rows[0].id;
  const outpatient = key();
  await f.pool.query("INSERT INTO visits(id,clinic_id,patient_id,business_day_id,type,created_by) VALUES($1,$2,$3,$4,'outpatient',$5)", [outpatient, g.clinic, g.patient, oldDay, g.actor]);
  await api(`business-days/${oldDay}/close`, {});
  await api('business-days/open', {}, 201);
  const surgeryService = key();
  await f.pool.query("INSERT INTO services(id,clinic_id,kind,name_uz_cyrl) VALUES($1,$2,'surgery','Синтетик операция')", [surgeryService, g.clinic]);
  await f.pool.query("INSERT INTO service_prices(id,clinic_id,service_id,price_uzs,effective_from,set_by) VALUES($1,$2,$3,500000,'2000-01-01',$4)", [key(), g.clinic, surgeryService, g.actor]);
  assert.ok((await api('pharmacy/visits')).some((v: { id: string }) => v.id === g.visit), 'pharmacy picker');
  const options = await api('surgery/options');
  assert.ok(options.visits.some((v: { id: string; admission_id: string }) => v.id === g.visit && v.admission_id === g.admission), 'surgery picker');
  await api('surgery', { idempotencyKey: key(), visitId: g.visit, admissionId: g.admission, surgeonId: g.actor, serviceId: surgeryService, performedAt: new Date().toISOString() }, 201);
  await api('pharmacy/dispense', { idempotencyKey: key(), visitId: g.visit, serviceId: g.services.medicine, qty: 1 }, 201);
  // An outpatient visit left open on the old day still does not appear.
  assert.ok(!(await api('pharmacy/visits')).some((v: { id: string }) => v.id === outpatient));
});

test('P2: after discharge the invoice keeps lines frozen and shows live payments and due', async t => {
  const { f, g, api } = await setup(t);
  const { id } = await api('inpatient/admit', { key: key(), visitId: g.visit, departmentId: g.dept, doctorId: g.actor, bedId: g.bed, expectedDischarge: null }, 201);
  await api(`inpatient/${id}/services`, { key: key(), serviceId: g.services.lab, quantity: 1 });
  const final = await api(`inpatient/${id}/discharge`, { key: key() });
  assert.equal(final.due, '350000'); assert.equal(final.linesAsOf, final.paymentsAsOf);
  const desk = key(); await f.pool.query("INSERT INTO cash_desks(id,clinic_id,name) VALUES($1,$2,'Synthetic desk')", [desk, g.clinic]);
  const shift = await api('cashier/shifts', { deskId: desk, opening: '0' }, 201);
  await api(`cashier/visits/${g.visit}/payments`, { shiftId: shift.id, amount: '350000', method: 'cash', key: key() }, 201);
  const after = await api(`inpatient/${id}/invoice`);
  assert.deepEqual(after.lines, final.lines);
  assert.equal(after.value, final.value); assert.equal(after.paid, '350000'); assert.equal(after.due, '0');
  assert.equal(after.linesAsOf, final.linesAsOf);
  assert.ok(Date.parse(after.paymentsAsOf) >= Date.parse(final.linesAsOf));
  const pdf = await (await f.client().request(`/api/clinics/${g.clinic}/inpatient/${id}/invoice-pdf`)).status;
  assert.notEqual(pdf, 500);
});

test('P2: bed-day and caretaker charges carry the real creation time; the billed date is charge_date', async t => {
  const { f, g, api } = await setup(t, 3);
  await f.pool.query('INSERT INTO caretakers(id,clinic_id,admission_id,full_name,from_date,daily_service_id) VALUES($1,$2,$3,$4,$5,$6)', [key(), g.clinic, g.admission, 'Synthetic Caretaker', g.start, g.services.caretaker]);
  const through = (await f.pool.query('SELECT ($1::date-1)::text d', [g.today])).rows[0].d;
  const before = (await f.pool.query('SELECT now() at')).rows[0].at as Date;
  await api('inpatient/daily', { key: key(), through });
  for (const table of ['bed_day_charges', 'caretaker_day_charges']) {
    const rows = (await f.pool.query(`SELECT b.charge_date::text, c.created_at, c.completed_at FROM ${table} b JOIN charge_lines c ON c.id=b.charge_line_id WHERE c.visit_id=$1 ORDER BY b.charge_date`, [g.visit])).rows;
    assert.ok(rows.length >= 2, table);
    assert.equal(new Set(rows.map(r => r.charge_date)).size, rows.length, `${table} one line per billed date`);
    assert.equal(rows[0].charge_date, g.start);
    for (const r of rows) {
      assert.ok(r.created_at >= before, `${table} ${r.charge_date} created_at is not backdated`);
      assert.equal(r.completed_at.valueOf(), r.created_at.valueOf());
    }
  }
});

test('P3: ward dispenses out-of-stock medicine with a CEO PIN approval on the same device; wrong PINs never touch the sign-in PIN', async t => {
  const { f, g } = await setup(t);
  const nurse = await staff(f, ['inpatient']);
  await f.pool.query('INSERT INTO account_pins(account_id,pin_hash,pin_digits) VALUES($1,$2,6) ON CONFLICT(account_id) DO UPDATE SET pin_hash=EXCLUDED.pin_hash,pin_digits=6', [g.actor, await passwordHash('482613')]);
  const pc = await onDevice(f, nurse);
  const post = async (path: string, body: unknown, status: number) => {
    const r = await pc.request(`/api/clinics/${g.clinic}/inpatient${path}`, body); const v = await r.json();
    assert.equal(r.status, status, `${path} ${JSON.stringify(v)}`); return v;
  };
  const ward = await (await pc.request(`/api/clinics/${g.clinic}/inpatient`)).json();
  assert.deepEqual(ward.approvers.map((a: { id: string }) => a.id), [g.actor]);
  const { id } = await post('/admit', { key: key(), visitId: g.visit, departmentId: g.dept, doctorId: g.actor, bedId: g.bed, expectedDischarge: null }, 201);
  const short = { key: key(), serviceId: g.services.medicine, quantity: 12 };
  await post(`/${id}/services`, short, 409); // 10 on hand, no approval
  // A wrong PIN is refused, committed to its own counter, and leaves the approver's sign-in PIN alone.
  await post(`/${id}/services`, { ...short, key: key(), override: { reason: 'Synthetic shortage', approverId: g.actor, pin: '000000' } }, 403);
  assert.equal((await f.pool.query('SELECT failed_attempts FROM approval_pin_attempts WHERE account_id=$1', [g.actor])).rows[0].failed_attempts, 1);
  assert.equal((await f.pool.query('SELECT failed_attempts FROM account_pins WHERE account_id=$1', [g.actor])).rows[0].failed_attempts, 0);
  // A non-manager cannot be named as approver, even with their correct PIN.
  const other = await staff(f, ['inpatient'], '1357');
  await post(`/${id}/services`, { ...short, key: key(), override: { reason: 'Synthetic shortage', approverId: other, pin: '1357' } }, 403);
  const approved = { ...short, key: key(), override: { reason: 'Synthetic shortage', approverId: g.actor, pin: '482613' } };
  const result = await post(`/${id}/services`, approved, 200);
  assert.deepEqual(await post(`/${id}/services`, approved, 200), result, 'retry returns the same charge');
  const movement = (await f.pool.query("SELECT qty,created_by,override_approved_by,override_reason FROM stock_movements WHERE service_id=$1 AND reason='dispense'", [g.services.medicine])).rows;
  assert.deepEqual(movement, [{ qty: -12, created_by: nurse, override_approved_by: g.actor, override_reason: 'Synthetic shortage' }]);
  assert.equal((await f.pool.query('SELECT failed_attempts FROM approval_pin_attempts WHERE account_id=$1', [g.actor])).rows[0].failed_attempts, 0);
  // The PIN is never stored in the replay record.
  assert.equal((await f.pool.query("SELECT count(*)::int n FROM inpatient_requests WHERE payload::text LIKE '%482613%'")).rows[0].n, 0);
  // Task 022: five wrong PINs lock the approver on every device until a manager clears it.
  for (let i = 0; i < 5; i++) await post(`/${id}/services`, { ...short, key: key(), override: { reason: 'Synthetic shortage', approverId: g.actor, pin: '000001' } }, 403);
  await post(`/${id}/services`, { ...short, key: key(), override: { reason: 'Synthetic shortage', approverId: g.actor, pin: '482613' } }, 403);
  const elsewhere = await onDevice(f, nurse);
  const r = await elsewhere.request(`/api/clinics/${g.clinic}/inpatient/${id}/services`, { ...short, key: key(), quantity: 1, override: { reason: 'Synthetic shortage', approverId: g.actor, pin: '482613' } });
  assert.equal(r.status, 403, 'another device is locked too');
  // Without a shared-PC session there is no PIN approval.
  const phone = f.client(); await phone.login();
  const p = await phone.request(`/api/clinics/${g.clinic}/inpatient/${id}/services`, { ...short, key: key(), override: { reason: 'Synthetic shortage', approverId: g.actor, pin: '482613' } });
  assert.equal(p.status, 403);
});

test('P3: a dispense retry after the visit closed returns the recorded result, not NOT_FOUND', async t => {
  const { f, g, api } = await setup(t);
  const input = { idempotencyKey: key(), visitId: g.visit, serviceId: g.services.medicine, qty: 1 };
  const first = await api('pharmacy/dispense', input, 201);
  await f.pool.query("UPDATE visits SET status='closed',closed_at=now() WHERE id=$1", [g.visit]);
  assert.deepEqual(await api('pharmacy/dispense', input, 201), first);
  assert.equal((await f.pool.query("SELECT count(*)::int n FROM stock_movements WHERE service_id=$1 AND reason='dispense'", [g.services.medicine])).rows[0].n, 1);
  // A new key on the closed visit is still refused.
  await api('pharmacy/dispense', { ...input, idempotencyKey: key() }, 404);
});
