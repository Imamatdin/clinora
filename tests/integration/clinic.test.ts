import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { httpFixture } from './fixture.js';
import { makePool } from '../../src/server/database.js';
import { ApiError } from '../../src/contracts/index.js';

type Fixture = Awaited<ReturnType<typeof httpFixture>>;
type Client = ReturnType<Fixture['client']>;
const code = async (r: Response) => ApiError.parse(await r.json()).error.code;

/** Signs in with any identifier; changes a temporary password when the server demands it. */
async function signIn(f: Fixture, identifier: string, password: string): Promise<{ client: Client; password: string }> {
  const client = f.client();
  const r = await client.request('/api/auth/login', { identifier, password });
  assert.equal(r.status, 200, `sign-in as ${identifier}`);
  const me = await (await client.request('/api/auth/me')).json();
  // The fixture client only learns the CSRF token in its email login(); send it explicitly here.
  const wrapped: Client = Object.assign(Object.create(client), {
    request: (path: string, body?: unknown, extra: Record<string, string> = {}) => client.request(path, body, { 'X-CSRF-Token': me.csrf, ...extra })
  });
  if (me.mustChangePassword) {
    const next = 'Changed-' + randomUUID();
    const changed = await wrapped.request('/api/auth/password', { currentPassword: password, newPassword: next });
    assert.equal(changed.status, 200);
    return { client: wrapped, password: next };
  }
  return { client: wrapped, password };
}
async function createStaff(owner: Client, clinicId: string, input: Record<string, unknown>) {
  const r = await owner.request(`/api/clinics/${clinicId}/staff`, input);
  assert.equal(r.status, 201, JSON.stringify(input));
  return r.json() as Promise<{ staff: { userId: string }; temporaryPassword: string }>;
}

test('every new clinic route: unauthenticated 401, wrong role 403, other clinic 404', async t => {
  const f = await httpFixture(); t.after(() => f.close());
  const owner = await signIn(f, 'owner@example.test', f.password);
  const otherOwner = await signIn(f, 'other@example.test', f.password);
  const A = f.owner.clinicId, B = f.other.clinicId;
  const cashierStaff = await createStaff(owner.client, A, { fullName: 'Синтетик Кассир', login: 'cashier.one', phone: null, roles: ['cashier'] });
  const cashier = await signIn(f, 'cashier.one', cashierStaff.temporaryPassword);
  const bare = await createStaff(owner.client, A, { fullName: 'Синтетик Ролсиз', login: 'no.roles', phone: null, roles: ['registrar'] });
  const noRoles = await signIn(f, 'no.roles', bare.temporaryPassword);
  await f.pool.query('DELETE FROM membership_roles WHERE user_id=$1', [bare.staff.userId]);
  const target = cashierStaff.staff.userId, day = randomUUID();
  const routes: { method: 'GET' | 'POST'; path: (clinic: string) => string; body?: unknown; wrong: Client }[] = [
    { method: 'GET', path: c => `/api/clinics/${c}/business-days/current`, wrong: noRoles.client },
    { method: 'POST', path: c => `/api/clinics/${c}/business-days/open`, body: {}, wrong: cashier.client },
    { method: 'POST', path: c => `/api/clinics/${c}/business-days/${day}/close`, body: {}, wrong: cashier.client },
    { method: 'GET', path: c => `/api/clinics/${c}/staff`, wrong: cashier.client },
    { method: 'POST', path: c => `/api/clinics/${c}/staff`, body: { fullName: 'X', login: 'x.user', phone: null, roles: ['cashier'] }, wrong: cashier.client },
    { method: 'POST', path: c => `/api/clinics/${c}/staff/${target}/roles`, body: { roles: ['cashier'] }, wrong: cashier.client },
    { method: 'POST', path: c => `/api/clinics/${c}/staff/${target}/status`, body: { status: 'blocked' }, wrong: cashier.client },
    { method: 'POST', path: c => `/api/clinics/${c}/staff/${target}/password-reset`, body: {}, wrong: cashier.client }
  ];
  const anonymous = f.client();
  for (const route of routes) {
    const label = `${route.method} ${route.path(':clinic')}`;
    const anon = await anonymous.request(route.path(A), route.body);
    // A mutation without session also fails CSRF-origin first; both must be refusals that reveal nothing.
    if (route.method === 'GET') assert.equal(anon.status, 401, label);
    else assert.ok([401, 403].includes(anon.status), label);
    const noCookie = await fetch(f.config.origin + route.path(A), route.method === 'GET' ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: f.config.origin }, body: JSON.stringify(route.body) });
    assert.equal(noCookie.status, 401, label + ' (no session)');
    const wrong = await route.wrong.request(route.path(A), route.body);
    assert.equal(wrong.status, 403, label + ' (wrong role)'); assert.equal(await code(wrong), 'FORBIDDEN');
    const foreign = await otherOwner.client.request(route.path(A), route.body);
    assert.equal(foreign.status, 404, label + ' (other clinic)');
    const missing = await owner.client.request(route.path(randomUUID()), route.body);
    assert.equal(missing.status, 404, label + ' (nonexistent clinic)');
  }
  // Nothing in clinic B was created or changed by clinic A's actors, and vice versa.
  assert.equal((await f.pool.query('SELECT count(*) FROM business_days WHERE clinic_id=$1', [B])).rows[0].count, '0');
  assert.equal((await f.pool.query("SELECT status FROM memberships WHERE user_id=$1", [target])).rows[0].status, 'active');
});

test('removing a role takes effect on the next request without signing out; staff changes are audited', async t => {
  const f = await httpFixture(); t.after(() => f.close());
  const owner = await signIn(f, 'owner@example.test', f.password), A = f.owner.clinicId;
  const created = await createStaff(owner.client, A, { fullName: 'Синтетик Ходим', login: 'staff.two', phone: '+998 90 111-22-33', roles: ['cashier', 'administrator'] });
  const staff = await signIn(f, 'staff.two', created.temporaryPassword);
  assert.equal((await staff.client.request(`/api/clinics/${A}/staff`)).status, 200);
  const changed = await owner.client.request(`/api/clinics/${A}/staff/${created.staff.userId}/roles`, { roles: ['cashier'] });
  assert.equal(changed.status, 200);
  const denied = await staff.client.request(`/api/clinics/${A}/staff`);
  assert.equal(denied.status, 403, 'same session, role removed');
  assert.equal((await staff.client.request(`/api/clinics/${A}/business-days/current`)).status, 200, 'remaining role still works');
  const me = await (await staff.client.request('/api/auth/me')).json();
  assert.deepEqual(me.clinics[0].roles, ['cashier']);
  const audit = (await f.pool.query("SELECT action,detail FROM audit_events WHERE resource_id=$1 ORDER BY created_at", [created.staff.userId])).rows;
  assert.deepEqual(audit.map(a => a.action), ['staff.created', 'account.password_changed', 'staff.roles_changed']);
  assert.deepEqual(audit[2].detail, { before: ['administrator', 'cashier'], after: ['cashier'] });
  // Doctor role drives the notebook's clinical access flag in the same transaction.
  await owner.client.request(`/api/clinics/${A}/staff/${created.staff.userId}/roles`, { roles: ['doctor'] });
  assert.equal((await staff.client.request(`/api/clinics/${A}/patients`)).status, 200);
  await owner.client.request(`/api/clinics/${A}/staff/${created.staff.userId}/roles`, { roles: ['cashier'] });
  assert.equal((await staff.client.request(`/api/clinics/${A}/patients`)).status, 403);
});

test('one open business day per clinic, including two concurrent open requests; closed days are immutable', async t => {
  const f = await httpFixture(); t.after(() => f.close());
  const owner = await signIn(f, 'owner@example.test', f.password), A = f.owner.clinicId;
  const base = `/api/clinics/${A}/business-days`;
  const empty = await (await owner.client.request(base + '/current')).json();
  assert.equal(empty.day, null); assert.match(empty.today, /^\d{4}-\d{2}-\d{2}$/); assert.equal(empty.timezone, 'Asia/Tashkent');
  const results = await Promise.all([owner.client.request(base + '/open', {}), owner.client.request(base + '/open', {})]);
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
  assert.equal((await f.pool.query("SELECT count(*) FROM business_days WHERE clinic_id=$1 AND status='open'", [A])).rows[0].count, '1');
  const opened = await (await owner.client.request(base + '/current')).json();
  assert.equal(opened.day.status, 'open'); assert.equal(opened.openDay.id, opened.day.id); assert.equal(opened.day.businessDate, empty.today);
  // The database itself rejects a second open day, even for a different date.
  await assert.rejects(f.pool.query("INSERT INTO business_days(id,clinic_id,business_date,status,opened_by) VALUES($1,$2,'2000-01-01','open',$3)", [randomUUID(), A, f.owner.userId]),
    (e: { code?: string }) => e.code === '23505');
  // Other clinic keeps its own independent day.
  const other = await signIn(f, 'other@example.test', f.password);
  assert.equal((await other.client.request(`/api/clinics/${f.other.clinicId}/business-days/open`, {})).status, 201);
  const close = await owner.client.request(`${base}/${opened.day.id}/close`, {});
  assert.equal(close.status, 200);
  const closed = await close.json(); assert.equal(closed.status, 'closed'); assert.ok(closed.closedAt);
  const snapshot=(await f.pool.query('SELECT close_snapshot FROM business_days WHERE id=$1', [opened.day.id])).rows[0].close_snapshot;
  assert.equal(snapshot.totals.collected,'0'); assert.equal(snapshot.from,empty.today);
  assert.equal((await owner.client.request(`${base}/${opened.day.id}/close`, {})).status, 409, 'closing twice');
  assert.equal((await owner.client.request(base + '/open', {})).status, 409, 'reopening a date that has a closed day');
  assert.equal((await other.client.request(`/api/clinics/${f.other.clinicId}/business-days/${opened.day.id}/close`, {})).status, 404, 'other clinic day id');
  await assert.rejects(f.pool.query("UPDATE business_days SET close_snapshot='{\"x\":1}' WHERE id=$1", [opened.day.id]), /immutable/);
  await assert.rejects(f.pool.query('DELETE FROM business_days WHERE id=$1', [opened.day.id]), /never deleted/);
  const actions = (await f.pool.query("SELECT action FROM audit_events WHERE resource_id=$1 ORDER BY created_at", [opened.day.id])).rows.map(r => r.action);
  assert.deepEqual(actions, ['business_day.opened', 'business_day.closed']);
});

test('sign-in by login and by phone; temporary password must be changed; blocked account cannot sign in', async t => {
  const f = await httpFixture(); t.after(() => f.close());
  const owner = await signIn(f, 'owner@example.test', f.password), A = f.owner.clinicId;
  const created = await createStaff(owner.client, A, { fullName: 'Синтетик Регистратор', login: 'Reg.One', phone: '90 123-45-67', roles: ['registrar'] });
  assert.match(created.temporaryPassword, /^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/);
  const row = (await f.pool.query('SELECT login,phone,email,password_hash,must_change_password FROM accounts WHERE id=$1', [created.staff.userId])).rows[0];
  assert.deepEqual([row.login, row.phone, row.email, row.must_change_password], ['reg.one', '+998901234567', null, true]);
  assert.ok(!row.password_hash.includes(created.temporaryPassword));
  assert.equal((await f.pool.query('SELECT count(*) FROM idempotency_records')).rows[0].count, '0', 'temporary password never cached');
  // Before the change, only me/logout/password are reachable.
  const temp = f.client();
  assert.equal((await temp.request('/api/auth/login', { identifier: 'reg.one', password: created.temporaryPassword })).status, 200);
  const tempMe = await (await temp.request('/api/auth/me')).json(); assert.equal(tempMe.mustChangePassword, true);
  const blocked = await temp.request(`/api/clinics/${A}/business-days/current`);
  assert.equal(blocked.status, 403); assert.equal(await code(blocked), 'PASSWORD_CHANGE_REQUIRED');
  assert.equal((await temp.request(`/api/clinics/${A}/patients`)).status, 403);
  const wrongCurrent = await temp.request('/api/auth/password', { currentPassword: 'not-it', newPassword: 'Synthetic-new-password-1' }, { 'X-CSRF-Token': tempMe.csrf });
  assert.equal(wrongCurrent.status, 403);
  const changed = await temp.request('/api/auth/password', { currentPassword: created.temporaryPassword, newPassword: 'Synthetic-new-password-1' }, { 'X-CSRF-Token': tempMe.csrf });
  assert.equal(changed.status, 200);
  assert.equal((await temp.request(`/api/clinics/${A}/business-days/current`)).status, 200);
  for (const identifier of ['reg.one', 'REG.ONE', '+998901234567', '+998 (90) 123-45-67', '901234567']) {
    const c = f.client();
    assert.equal((await c.request('/api/auth/login', { identifier, password: 'Synthetic-new-password-1' })).status, 200, identifier);
  }
  assert.equal((await f.client().request('/api/auth/login', { identifier: 'reg.one', password: created.temporaryPassword })).status, 401, 'old temporary password');
  const block = await owner.client.request(`/api/clinics/${A}/staff/${created.staff.userId}/status`, { status: 'blocked' });
  assert.equal(block.status, 200);
  assert.equal((await temp.request('/api/auth/me')).status, 401, 'existing session ends');
  assert.equal((await f.client().request('/api/auth/login', { identifier: 'reg.one', password: 'Synthetic-new-password-1' })).status, 401, 'blocked by login');
  assert.equal((await f.client().request('/api/auth/login', { identifier: '901234567', password: 'Synthetic-new-password-1' })).status, 401, 'blocked by phone');
  assert.equal((await owner.client.request(`/api/clinics/${A}/staff/${created.staff.userId}/status`, { status: 'active' })).status, 200);
  assert.equal((await f.client().request('/api/auth/login', { identifier: 'reg.one', password: 'Synthetic-new-password-1' })).status, 200, 'unblocked');
  // Reset issues a new temporary password and ends sessions.
  const reset = await (await owner.client.request(`/api/clinics/${A}/staff/${created.staff.userId}/password-reset`, {})).json();
  assert.equal((await temp.request('/api/auth/me')).status, 401);
  assert.equal((await f.client().request('/api/auth/login', { identifier: 'reg.one', password: reset.temporaryPassword })).status, 200);
  const actions = (await f.pool.query('SELECT action FROM audit_events WHERE resource_id=$1 ORDER BY created_at', [created.staff.userId])).rows.map(r => r.action);
  assert.deepEqual(actions, ['staff.created', 'account.password_changed', 'staff.blocked', 'staff.unblocked', 'staff.password_reset']);
  // Duplicate login or phone is reported as such.
  const dupe = await owner.client.request(`/api/clinics/${A}/staff`, { fullName: 'Дубликат', login: 'reg.one', phone: null, roles: ['cashier'] });
  assert.equal(dupe.status, 409); assert.equal(await code(dupe), 'ALREADY_EXISTS');
  assert.equal((await owner.client.request(`/api/clinics/${A}/staff`, { fullName: 'Дубликат', login: 'reg.two', phone: '+998901234567', roles: ['cashier'] })).status, 409);
  for (const bad of [{ login: '12345' }, { login: 'ab' }, { roles: [] }, { roles: ['owner'] }, { roles: ['cashier', 'cashier'] }, { phone: '12' }, { extra: true }]) {
    const r = await owner.client.request(`/api/clinics/${A}/staff`, { fullName: 'Нотўғри', login: 'valid.login', phone: null, roles: ['cashier'], ...bad });
    assert.equal(r.status, 422, JSON.stringify(bad));
  }
});

test('administrators cannot escalate to CEO, change themselves, or take over accounts they do not manage', async t => {
  const f = await httpFixture(); t.after(() => f.close());
  const owner = await signIn(f, 'owner@example.test', f.password), A = f.owner.clinicId;
  const adminStaff = await createStaff(owner.client, A, { fullName: 'Синтетик Админ', login: 'admin.only', phone: null, roles: ['administrator'] });
  const admin = await signIn(f, 'admin.only', adminStaff.temporaryPassword);
  const staffBase = `/api/clinics/${A}/staff`;
  assert.equal((await admin.client.request(staffBase, { fullName: 'Янги CEO', login: 'new.ceo', phone: null, roles: ['ceo'] })).status, 403, 'grant ceo on create');
  assert.equal((await admin.client.request(`${staffBase}/${adminStaff.staff.userId}/roles`, { roles: ['administrator', 'ceo'] })).status, 403, 'self');
  assert.equal((await admin.client.request(`${staffBase}/${f.owner.userId}/roles`, { roles: ['cashier'] })).status, 403, 'demote ceo');
  assert.equal((await admin.client.request(`${staffBase}/${f.owner.userId}/status`, { status: 'blocked' })).status, 403, 'block ceo');
  assert.equal((await admin.client.request(`${staffBase}/${f.owner.userId}/password-reset`, {})).status, 403, 'reset ceo');
  assert.equal((await admin.client.request(`${staffBase}/${adminStaff.staff.userId}/status`, { status: 'blocked' })).status, 403, 'block self');
  const cashier = await createStaff(admin.client, A, { fullName: 'Синтетик Кассир', login: 'cashier.two', phone: null, roles: ['cashier'] });
  assert.equal((await admin.client.request(`${staffBase}/${cashier.staff.userId}/roles`, { roles: ['cashier', 'ceo'] })).status, 403, 'grant ceo to other');
  assert.equal((await admin.client.request(`${staffBase}/${cashier.staff.userId}/roles`, { roles: ['cashier', 'laboratory'] })).status, 200);
  // A self-registered account joined by invitation is not managed by this clinic.
  const c = f.client(); await c.request('/api/auth/register', { email: 'invited@example.test', displayName: 'Synthetic Invitee', password: f.password });
  const me = await c.login('invited@example.test');
  await f.pool.query("INSERT INTO memberships(id,clinic_id,user_id,role,clinical_access,status,granted_by) VALUES($1,$2,$3,'clinician',true,'active',$4)", [randomUUID(), A, me.id, f.owner.userId]);
  await f.pool.query("INSERT INTO membership_roles(clinic_id,user_id,role,granted_by) VALUES($1,$2,'doctor',$3)", [A, me.id, f.owner.userId]);
  assert.equal((await admin.client.request(`${staffBase}/${me.id}/password-reset`, {})).status, 403, 'unmanaged account');
  assert.equal((await admin.client.request(`${staffBase}/${me.id}/status`, { status: 'blocked' })).status, 200, 'membership block allowed');
  assert.equal((await f.pool.query('SELECT status FROM accounts WHERE id=$1', [me.id])).rows[0].status, 'active', 'account itself untouched');
  assert.equal((await c.request(`/api/clinics/${A}/patients`)).status, 403);
  // Clinic A cannot touch clinic B's members even by id.
  assert.equal((await owner.client.request(`${staffBase}/${f.other.userId}/roles`, { roles: ['cashier'] })).status, 404);
  const list = await (await admin.client.request(staffBase)).json();
  assert.ok(list.some((s: { login: string }) => s.login === 'cashier.two'));
  assert.ok(!list.some((s: { userId: string }) => s.userId === f.other.userId));
  assert.ok(list.every((s: Record<string, unknown>) => !('password_hash' in s) && !('passwordHash' in s)));
});

test('migration 002 maps existing memberships to roles', async t => {
  const url = process.env.TEST_DATABASE_URL; if (!url) throw new Error('TEST_DATABASE_URL required');
  const schema = 'clinora_test_' + randomUUID().replaceAll('-', '');
  const admin = makePool(url); await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = makePool(url, schema);
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); });
  await pool.query(await readFile('db/migrations/001_notebook.sql', 'utf8'));
  const [owner, adminUser, clinician, clinic] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  for (const [id, email] of [[owner, 'o@example.test'], [adminUser, 'a@example.test'], [clinician, 'c@example.test']])
    await pool.query("INSERT INTO accounts(id,email,display_name,password_hash) VALUES($1,$2,'Synthetic','x')", [id, email]);
  await pool.query("INSERT INTO clinics(id,name) VALUES($1,'Synthetic')", [clinic]);
  for (const [user, role, ownerFlag] of [[owner, 'administrator', true], [adminUser, 'administrator', false], [clinician, 'clinician', false]])
    await pool.query("INSERT INTO memberships(id,clinic_id,user_id,role,is_owner,status,granted_by) VALUES($1,$2,$3,$4,$5,'active',$6)", [randomUUID(), clinic, user, role, ownerFlag, owner]);
  await pool.query(await readFile('db/migrations/002_clinic_roles.sql', 'utf8'));
  const roles = Object.fromEntries((await pool.query('SELECT user_id, array_agg(role ORDER BY role) roles FROM membership_roles GROUP BY user_id')).rows.map(r => [r.user_id, r.roles]));
  assert.deepEqual(roles[owner], ['administrator', 'ceo']);
  assert.deepEqual(roles[adminUser], ['administrator']);
  assert.deepEqual(roles[clinician], ['doctor']);
  await assert.rejects(pool.query("INSERT INTO accounts(id,display_name,password_hash) VALUES($1,'No identifier','x')", [randomUUID()]), /account_has_identifier/);
});
