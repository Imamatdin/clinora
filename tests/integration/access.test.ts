import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { httpFixture, TEST_BOT } from './fixture.js';
import { signInitData } from '../../src/modules/telegram/init-data.js';
import { passwordHash } from '../../src/server/security.js';
import { ApiError } from '../../src/contracts/index.js';

// Task 004 acceptance: Telegram Mini App sign-in, invite linking, webhook, shared devices and PINs.
type Fixture = Awaited<ReturnType<typeof httpFixture>>;
const code = async (r: Response) => ApiError.parse(await r.json()).error.code;
const now = () => Math.floor(Date.now() / 1000);

/** Cookie-jar client: keeps the session and device cookies separately, like a browser. */
function browser(f: Fixture) {
  const cookies = new Map<string, string>(); let csrf = '';
  const self = {
    cookies,
    async request(path: string, body?: unknown, extra: Record<string, string> = {}) {
      const r = await fetch(f.config.origin + path, { method: body === undefined ? 'GET' : 'POST',
        headers: { Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: f.config.origin, 'X-CSRF-Token': csrf }), ...extra },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      for (const header of r.headers.getSetCookie()) {
        const pair = header.split(';')[0]!, i = pair.indexOf('='), name = pair.slice(0, i), value = pair.slice(i + 1);
        if (!value || /Max-Age=0/.test(header)) cookies.delete(name); else cookies.set(name, value);
      }
      return r;
    },
    async me() { const r = await self.request('/api/auth/me'); if (r.status !== 200) return null; const v = await r.json(); csrf = v.csrf; return v; },
    async login(identifier: string, password: string) { const r = await self.request('/api/auth/login', { identifier, password }); assert.equal(r.status, 200, `login ${identifier}`); return self.me(); }
  };
  return self;
}

/** A staff account managed by clinic A with a known password (already changed) and roles. */
async function staff(f: Fixture, login: string, roles: string[], opts: { clinicId?: string; pin?: string; managed?: boolean } = {}) {
  const id = randomUUID(), password = 'Synthetic-' + randomUUID(), clinicId = opts.clinicId ?? f.owner.clinicId;
  await f.pool.query('INSERT INTO accounts(id,login,display_name,password_hash,managed_by_clinic_id) VALUES($1,$2,$3,$4,$5)',
    [id, login, 'Синтетик ' + login, await passwordHash(password), opts.managed === false ? null : clinicId]);
  await f.pool.query("INSERT INTO memberships(id,clinic_id,user_id,status,granted_by) VALUES($1,$2,$3,'active',$4)", [randomUUID(), clinicId, id, f.owner.userId]);
  for (const role of roles) await f.pool.query('INSERT INTO membership_roles(clinic_id,user_id,role,granted_by) VALUES($1,$2,$3,$4)', [clinicId, id, role, f.owner.userId]);
  if (opts.pin) await f.pool.query('INSERT INTO account_pins(account_id,pin_hash) VALUES($1,$2)', [id, await passwordHash(opts.pin)]);
  return { id, login, password };
}

let updateId = 5000;
const hook = (f: Fixture, body: unknown, secret: string | null = TEST_BOT.webhookSecret) => fetch(f.config.origin + '/api/telegram/webhook', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(secret === null ? {} : { 'X-Telegram-Bot-Api-Secret-Token': secret }) }, body: JSON.stringify(body) });
const startUpdate = (tg: number, text: string) => ({ update_id: ++updateId, message: { message_id: 1, date: now(), text, from: { id: tg, is_bot: false, first_name: 'S' }, chat: { id: tg, type: 'private' } } });
const pressUpdate = (tg: number, data: string) => ({ update_id: ++updateId, callback_query: { id: 'cb' + updateId, data, from: { id: tg, is_bot: false, first_name: 'S' }, message: { message_id: 2, date: now(), chat: { id: tg, type: 'private' } } } });
const initData = (tg: number, opts: { authDate?: number; token?: string; query?: string } = {}) => signInitData({
  auth_date: String(opts.authDate ?? now()), query_id: opts.query ?? 'AAH' + randomUUID().slice(0, 8),
  user: JSON.stringify({ id: tg, first_name: 'Синтетик', language_code: 'uz' }) }, opts.token ?? TEST_BOT.botToken);
const lastText = (f: Fixture) => [...f.telegramApi.calls].reverse().find(c => c.method === 'sendMessage')?.payload as { text: string; reply_markup?: { inline_keyboard: { callback_data?: string; web_app?: { url: string } }[][] } };

async function invite(f: Fixture, manager: ReturnType<typeof browser>, userId: string) {
  const r = await manager.request(`/api/clinics/${f.owner.clinicId}/staff/${userId}/telegram-invite`, {});
  assert.equal(r.status, 201);
  const body = await r.json() as { link: string; expiresAt: string };
  assert.match(body.link, /^https:\/\/t\.me\/clinora_test_bot\?start=[A-Za-z0-9_-]{43}$/);
  return { ...body, token: body.link.split('start=')[1]! };
}
async function link(f: Fixture, tg: number, token: string) {
  assert.equal((await hook(f, startUpdate(tg, `/start ${token}`))).status, 200);
  const question = lastText(f);
  const data = question.reply_markup?.inline_keyboard[0]?.[0]?.callback_data;
  assert.ok(data?.startsWith('link:'), 'confirmation offered');
  assert.equal((await hook(f, pressUpdate(tg, data!))).status, 200);
  return lastText(f).text;
}

test('webhook without or with a wrong secret header returns 401 and does nothing', async t => {
  const f = await httpFixture(); t.after(() => f.close());
  for (const secret of [null, '', 'wrong-secret-0123456789abcdef0123456789', TEST_BOT.webhookSecret + 'x']) {
    const r = await hook(f, startUpdate(777, '/start'), secret);
    assert.equal(r.status, 401); assert.equal(await code(r), 'UNAUTHENTICATED');
  }
  assert.equal(f.telegramApi.calls.length, 0, 'no message sent');
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM telegram_updates')).rows[0].n, 0, 'no update recorded');
  // A correct secret works; a repeated delivery of the same update is processed once.
  const update = startUpdate(777, '/start');
  assert.equal((await hook(f, update)).status, 200);
  assert.equal((await hook(f, update)).status, 200);
  assert.equal(f.telegramApi.calls.length, 1);
  assert.match(lastText(f).text, /боғланмаган/);
});

test('invite links a Telegram user once; reused, expired, revoked and foreign invites are rejected', async t => {
  const f = await httpFixture(); t.after(() => f.close());
  const owner = browser(f); await owner.login('owner@example.test', f.password);
  const doctor = await staff(f, 'doctor.tg', ['doctor']);
  const first = await invite(f, owner, doctor.id);
  assert.ok(Date.parse(first.expiresAt) - Date.now() > 71 * 3600e3 && Date.parse(first.expiresAt) - Date.now() <= 72 * 3600e3);
  // The confirmation names the staff member and clinic so they can recognise their own account.
  await hook(f, startUpdate(4242, `/start ${first.token}`));
  assert.match(lastText(f).text, /Синтетик doctor\.tg/);
  assert.match(lastText(f).text, /Synthetic North Clinic/);
  assert.match(await link(f, 4242, first.token), /Тайёр/);
  assert.equal(lastText(f).reply_markup?.inline_keyboard[0]?.[0]?.web_app?.url, f.config.origin + '/');
  assert.equal((await f.pool.query('SELECT telegram_user_id::text t FROM telegram_links WHERE account_id=$1', [doctor.id])).rows[0].t, '4242');
  // Reuse: the same invite can never link again (pressing the old button, or another Telegram user trying it).
  await hook(f, pressUpdate(9999, `link:${first.token}`));
  assert.match(lastText(f).text, /яроқсиз/);
  await hook(f, startUpdate(9999, `/start ${first.token}`));
  assert.match(lastText(f).text, /яроқсиз/);
  assert.equal((await f.pool.query('SELECT telegram_user_id::text t FROM telegram_links WHERE account_id=$1', [doctor.id])).rows[0].t, '4242');
  // Relinking to a new phone requires a new invite; issuing one revokes the previous open invite.
  const second = await invite(f, owner, doctor.id), third = await invite(f, owner, doctor.id);
  await hook(f, pressUpdate(5151, `link:${second.token}`));
  assert.match(lastText(f).text, /яроқсиз/, 'revoked by the newer invite');
  assert.match(await link(f, 5151, third.token), /Тайёр/);
  assert.equal((await f.pool.query('SELECT telegram_user_id::text t FROM telegram_links WHERE account_id=$1', [doctor.id])).rows[0].t, '5151');
  // Expired.
  const old = await invite(f, owner, doctor.id);
  await f.pool.query("UPDATE telegram_invites SET created_at=now()-interval '73 hours', expires_at=now()-interval '1 hour' WHERE account_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL", [doctor.id]);
  await hook(f, pressUpdate(6161, `link:${old.token}`));
  assert.match(lastText(f).text, /яроқсиз/);
  // A Telegram user already linked to someone else is refused, not silently moved.
  const nurse = await staff(f, 'nurse.tg', ['inpatient']);
  const fresh = await invite(f, owner, nurse.id);
  assert.match(await link(f, 5151, fresh.token), /бошқа ходимга/);
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM telegram_links WHERE account_id=$1', [nurse.id])).rows[0].n, 0);
  // Invite tokens are stored only as hashes.
  const stored = (await f.pool.query('SELECT token_hash FROM telegram_invites')).rows.map(r => r.token_hash);
  assert.ok(stored.every(h => /^[a-f0-9]{64}$/.test(h)) && !stored.includes(first.token));
});

test('invite rules: managers only, managed accounts only, CEO only by CEO, other clinic not found', async t => {
  const f = await httpFixture(); t.after(() => f.close());
  const admin = await staff(f, 'admin.only', ['administrator']);
  const cashier = await staff(f, 'cashier.x', ['cashier']);
  const ceo = await staff(f, 'ceo.two', ['ceo']);
  const outsider = await staff(f, 'visiting.doc', ['doctor'], { managed: false });
  const adminClient = browser(f); await adminClient.login('admin.only', admin.password);
  const cashierClient = browser(f); await cashierClient.login('cashier.x', cashier.password);
  const other = browser(f); await other.login('other@example.test', f.password);
  const A = f.owner.clinicId;
  assert.equal((await cashierClient.request(`/api/clinics/${A}/staff/${admin.id}/telegram-invite`, {})).status, 403);
  assert.equal((await adminClient.request(`/api/clinics/${A}/staff/${ceo.id}/telegram-invite`, {})).status, 403, 'CEO account needs a CEO');
  assert.equal((await adminClient.request(`/api/clinics/${A}/staff/${outsider.id}/telegram-invite`, {})).status, 403, 'account not managed by this clinic');
  assert.equal((await adminClient.request(`/api/clinics/${A}/staff/${admin.id}/telegram-invite`, {})).status, 403, 'not for oneself here');
  assert.equal((await other.request(`/api/clinics/${A}/staff/${cashier.id}/telegram-invite`, {})).status, 404);
  assert.equal((await adminClient.request(`/api/clinics/${A}/staff/${cashier.id}/telegram-invite`, {})).status, 201);
  // Anyone with a role may link their own Telegram (the provisioned owner, the visiting doctor).
  assert.equal((await cashierClient.request(`/api/clinics/${A}/access/me/telegram-invite`, {})).status, 201);
  for (const path of ['/staff/access', '/devices']) assert.equal((await cashierClient.request(`/api/clinics/${A}${path}`)).status, 403, path);
  assert.equal((await fetch(f.config.origin + `/api/clinics/${A}/staff/${cashier.id}/telegram-invite`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: f.config.origin }, body: '{}' })).status, 401);
});

test('Mini App init data: forged, expired, replayed and wrong-bot rejected; unlinked and blocked users rejected', async t => {
  const f = await httpFixture(); t.after(() => f.close());
  const owner = browser(f); await owner.login('owner@example.test', f.password);
  const doctor = await staff(f, 'doctor.mini', ['doctor']);
  await link(f, 3131, (await invite(f, owner, doctor.id)).token);
  const signIn = async (data: string) => { const c = browser(f); const r = await c.request('/api/telegram/session', { initData: data }); return { c, r }; };

  const valid = initData(3131);
  const forged = valid.replace(/(%22id%22%3A)3131/, '$13132');
  assert.notEqual(forged, valid);
  const cases: [string, string, number][] = [
    ['forged user id', forged, 401],
    ['tampered hash', valid.replace(/hash=[a-f0-9]/, m => m.slice(0, -1) + (m.endsWith('0') ? '1' : '0')), 401],
    ['missing hash', valid.replace(/&?hash=[a-f0-9]+/, ''), 401],
    ['expired (61 minutes)', initData(3131, { authDate: now() - 3660 }), 401],
    ['signed by another bot', initData(3131, { token: '987654321:OTHER_synthetic_bot_token_not_real_000' }), 401],
    ['duplicated field', valid + '&auth_date=' + now(), 401],
    ['valid but unlinked Telegram user', initData(8888), 403]
  ];
  for (const [label, data, status] of cases) assert.equal((await signIn(data)).r.status, status, label);
  assert.equal((await f.pool.query("SELECT count(*)::int n FROM sessions WHERE via='telegram'")).rows[0].n, 0);

  const ok = await signIn(valid);
  assert.equal(ok.r.status, 200);
  const me = await ok.c.me();
  assert.equal(me.id, doctor.id); assert.equal(me.session.via, 'telegram');
  assert.equal((await ok.c.request(`/api/clinics/${f.owner.clinicId}/business-days/current`)).status, 200, 'normal session, roles checked per route');
  assert.equal((await ok.c.request(`/api/clinics/${f.owner.clinicId}/staff`)).status, 403, 'a Telegram id grants no extra role');
  assert.equal((await signIn(valid)).r.status, 401, 'replayed init data');
  // Blocking ends the Mini App session on the next request and refuses new Mini App sign-ins.
  assert.equal((await owner.request(`/api/clinics/${f.owner.clinicId}/staff/${doctor.id}/status`, { status: 'blocked' })).status, 200);
  assert.equal((await ok.c.request('/api/auth/me')).status, 401);
  assert.equal((await signIn(initData(3131))).r.status, 403);
  // An account still active but with no active membership anywhere is refused too.
  await owner.request(`/api/clinics/${f.owner.clinicId}/staff/${doctor.id}/status`, { status: 'active' });
  assert.equal((await signIn(initData(3131))).r.status, 200);
  await f.pool.query("UPDATE memberships SET status='revoked' WHERE user_id=$1", [doctor.id]);
  assert.equal((await signIn(initData(3131))).r.status, 403);
  // Unlinking ends Telegram sessions immediately.
  await f.pool.query("UPDATE memberships SET status='active' WHERE user_id=$1", [doctor.id]);
  const again = await signIn(initData(3131)); assert.equal(again.r.status, 200);
  assert.equal((await owner.request(`/api/clinics/${f.owner.clinicId}/staff/${doctor.id}/telegram-unlink`, {})).status, 200);
  assert.equal((await again.c.request('/api/auth/me')).status, 401);
  assert.equal((await signIn(initData(3131))).r.status, 403);
});

test('linking through Telegram retires an unchanged temporary password', async t => {
  const f = await httpFixture(); t.after(() => f.close());
  const owner = browser(f); await owner.login('owner@example.test', f.password);
  const created = await (await owner.request(`/api/clinics/${f.owner.clinicId}/staff`, { fullName: 'Синтетик Ҳамшира', login: 'temp.nurse', phone: null, roles: ['inpatient'] })).json();
  await link(f, 7171, (await invite(f, owner, created.staff.userId)).token);
  assert.equal((await browser(f).request('/api/auth/login', { identifier: 'temp.nurse', password: created.temporaryPassword })).status, 401);
  const c = browser(f); assert.equal((await c.request('/api/telegram/session', { initData: initData(7171) })).status, 200);
  assert.equal((await c.me()).mustChangePassword, false);
});

test('enrolled PC: PIN switching, device clinic scope, idle lock, revocation and blocking', async t => {
  const f = await httpFixture(); t.after(() => f.close());
  const A = f.owner.clinicId;
  const anna = await staff(f, 'anna.admin', ['administrator'], { pin: '2580' });
  const bek = await staff(f, 'bek.cashier', ['cashier'], { pin: '1397' });
  await staff(f, 'no.pin', ['registrar']);
  const pc = browser(f);
  await pc.login('owner@example.test', f.password);
  const enrolled = await pc.request(`/api/clinics/${A}/devices/enroll`, { label: 'Регистратура 1' });
  assert.equal(enrolled.status, 201);
  assert.ok(pc.cookies.has('clinora_device') && !pc.cookies.has('clinora_session'), 'manager signed out, device cookie kept');
  assert.equal((await pc.request('/api/auth/me')).status, 401);
  const device = await (await pc.request('/api/device')).json();
  assert.equal(device.enrolled, true); assert.equal(device.clinicName, 'Synthetic North Clinic');
  assert.deepEqual(device.staff.map((s: { name: string }) => s.name).sort(), ['Синтетик anna.admin', 'Синтетик bek.cashier'], 'only people with a PIN');
  assert.deepEqual(await (await browser(f).request('/api/device')).json(), { enrolled: false }, 'no device cookie, no staff list');
  assert.equal((await browser(f).request('/api/device/unlock', { userId: anna.id, pin: '2580' })).status, 403, 'PIN alone without a device');

  assert.equal((await pc.request('/api/device/unlock', { userId: anna.id, pin: '0000' })).status, 401);
  assert.equal((await pc.request('/api/device/unlock', { userId: anna.id, pin: '2580' })).status, 200);
  const annaMe = await pc.me();
  assert.equal(annaMe.id, anna.id); assert.equal(annaMe.session.via, 'device'); assert.equal(annaMe.session.idleMinutes, 10);
  assert.equal((await pc.request(`/api/clinics/${A}/business-days/open`, {})).status, 201);
  assert.equal((await pc.request('/api/auth/pin', { pin: '4826' })).status, 403, 'no PIN changes from a shared PC');
  assert.equal((await pc.request('/api/auth/logout', {})).status, 200, 'switch user');
  assert.equal((await pc.request('/api/device/unlock', { userId: bek.id, pin: '1397' })).status, 200);
  assert.equal((await pc.me()).id, bek.id);
  const day = (await f.pool.query('SELECT opened_by FROM business_days WHERE clinic_id=$1', [A])).rows[0];
  assert.equal(day.opened_by, anna.id, 'action attributed to the person who unlocked');
  assert.equal((await pc.request(`/api/clinics/${A}/business-days/${randomUUID()}/close`, {})).status, 403, 'roles of the current person apply');

  // A device session reaches only the device's clinic, even for someone who works in two clinics.
  await f.pool.query("INSERT INTO memberships(id,clinic_id,user_id,status,granted_by) VALUES($1,$2,$3,'active',$4)", [randomUUID(), f.other.clinicId, bek.id, f.other.userId]);
  await f.pool.query("INSERT INTO membership_roles(clinic_id,user_id,role,granted_by) VALUES($1,$2,'cashier',$3)", [f.other.clinicId, bek.id, f.other.userId]);
  assert.equal((await pc.request(`/api/clinics/${f.other.clinicId}/business-days/current`)).status, 404);
  assert.deepEqual((await pc.me()).clinics.map((c: { id: string }) => c.id), [A]);
  // The session cookie is useless without the device cookie it was issued with.
  const stolen = browser(f); stolen.cookies.set('clinora_session', pc.cookies.get('clinora_session')!);
  assert.equal((await stolen.request('/api/auth/me')).status, 401);
  // Idle for more than 10 minutes: locked on the server, not just in the interface.
  await f.pool.query("UPDATE sessions SET last_seen_at=now()-interval '11 minutes' WHERE via='device'");
  assert.equal((await pc.request('/api/auth/me')).status, 401);

  // Password sign-in on an enrolled PC becomes a device session and is limited to that clinic's members.
  assert.equal((await pc.request('/api/auth/login', { identifier: 'other@example.test', password: f.password })).status, 401);
  await pc.login('bek.cashier', bek.password);
  assert.equal((await pc.me()).session.via, 'device');

  // Blocking ends PC access on the next request and removes the person from the picker.
  const owner = browser(f); await owner.login('owner@example.test', f.password);
  await pc.request('/api/auth/logout', {}); await pc.request('/api/device/unlock', { userId: anna.id, pin: '2580' });
  assert.equal((await owner.request(`/api/clinics/${A}/staff/${anna.id}/status`, { status: 'blocked' })).status, 200);
  assert.equal((await pc.request('/api/auth/me')).status, 401);
  assert.equal((await pc.request('/api/device/unlock', { userId: anna.id, pin: '2580' })).status, 401);
  assert.ok(!(await (await pc.request('/api/device')).json()).staff.some((s: { userId: string }) => s.userId === anna.id));

  // Revoked device: active session ends and no one can sign in on it.
  assert.equal((await pc.request('/api/device/unlock', { userId: bek.id, pin: '1397' })).status, 200);
  const deviceId = (await (await owner.request(`/api/clinics/${A}/devices`)).json())[0].id;
  assert.equal((await owner.request(`/api/clinics/${A}/devices/${deviceId}/revoke`, {})).status, 200);
  assert.equal((await pc.request('/api/auth/me')).status, 401);
  assert.equal((await pc.request('/api/device/unlock', { userId: bek.id, pin: '1397' })).status, 403);
  assert.deepEqual(await (await pc.request('/api/device')).json(), { enrolled: false });
  assert.equal((await owner.request(`/api/clinics/${A}/devices/${deviceId}/revoke`, {})).status, 409);
  assert.ok((await f.pool.query('SELECT token_hash FROM devices')).rows.every(r => /^[a-f0-9]{64}$/.test(r.token_hash)));
});

test('PIN lockout is per account: 20 staff behind one IP are never locked out by one person', async t => {
  const f = await httpFixture(); t.after(() => f.close());
  const A = f.owner.clinicId;
  const owner = browser(f); await owner.login('owner@example.test', f.password);
  const people = [];
  for (let i = 0; i < 20; i++) people.push(await staff(f, `staff.${i}`, ['registrar'], { pin: String(204060 + i * 7) }));
  await owner.request(`/api/clinics/${A}/devices/enroll`, { label: 'Касса' });
  const pc = owner; // Same browser, same loopback IP for every request below.
  const victim = people[0]!;
  for (let i = 1; i <= 5; i++) {
    const r = await pc.request('/api/device/unlock', { userId: victim.id, pin: '9999' });
    assert.equal(r.status, i < 5 ? 401 : 429, `wrong try ${i}`);
  }
  assert.equal((await pc.request('/api/device/unlock', { userId: victim.id, pin: '204060' })).status, 429, 'correct PIN refused while locked');
  // Everyone else, on the same device and IP, still signs in; including after many failures by others.
  for (const person of people.slice(1)) {
    assert.equal((await pc.request('/api/device/unlock', { userId: person.id, pin: '1111' })).status, 401);
    const r = await pc.request('/api/device/unlock', { userId: person.id, pin: String(204060 + people.indexOf(person) * 7) });
    assert.equal(r.status, 200, person.login);
    await pc.request('/api/auth/logout', {});
  }
  // The manager unlocks; the person signs in again. The failure count was committed despite the errors.
  const audit = (await f.pool.query("SELECT count(*)::int n FROM audit_events WHERE actor_id=$1 AND action IN ('pin.failed','pin.locked')", [victim.id])).rows[0].n;
  assert.equal(audit, 5);
  const manager = browser(f); await manager.login('owner@example.test', f.password);
  const access = await (await manager.request(`/api/clinics/${A}/staff/access`)).json();
  assert.equal(access.find((a: { userId: string }) => a.userId === victim.id).pinLocked, true);
  assert.equal((await manager.request(`/api/clinics/${A}/staff/${victim.id}/pin-unlock`, {})).status, 200);
  assert.equal((await pc.request('/api/device/unlock', { userId: victim.id, pin: '204060' })).status, 200);
});

test('own PIN: format and weak PINs rejected, setting a PIN clears a lockout', async t => {
  const f = await httpFixture(); t.after(() => f.close());
  const doc = await staff(f, 'doc.pin', ['doctor']);
  const c = browser(f); await c.login('doc.pin', doc.password);
  for (const pin of ['123', '1234567', '12a4', '1111', '1234', '9876', '0123']) assert.equal((await c.request('/api/auth/pin', { pin })).status, 422, pin);
  assert.equal((await c.request('/api/auth/pin', { pin: '2580' })).status, 200);
  await f.pool.query('UPDATE account_pins SET failed_attempts=5, locked_at=now() WHERE account_id=$1', [doc.id]);
  assert.equal((await c.request('/api/auth/pin', { pin: '3691' })).status, 200);
  const row = (await f.pool.query('SELECT failed_attempts, locked_at, pin_hash FROM account_pins WHERE account_id=$1', [doc.id])).rows[0];
  assert.equal(row.failed_attempts, 0); assert.equal(row.locked_at, null); assert.ok(!row.pin_hash.includes('3691'));
  const mine = await (await c.request(`/api/clinics/${f.owner.clinicId}/access/me`)).json();
  assert.deepEqual(mine, { telegramLinked: false, pinSet: true, pinLocked: false });
});
