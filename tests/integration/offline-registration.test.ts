import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { httpFixture } from './fixture.js';
import { seedRegistration, openDay, closeDay } from './registration-fixture.js';
import { digest, token } from '../../src/server/security.js';
import { createSession } from '../../src/server/access.js';

test('enrolled-device replay is atomic, day-bound, idempotent and checks current access', async () => {
  const f = await httpFixture();
  try {
    const c = f.owner.clinicId, g = await seedRegistration(f.pool, c, f.owner.userId, f.password, 'o016');
    const day = await openDay(f.pool, c, f.owner.userId);
    const deviceId = randomUUID(), raw = token();
    await f.pool.query("INSERT INTO devices(id,clinic_id,label,token_hash,created_by) VALUES($1,$2,'Synthetic R1',$3,$4)", [deviceId, c, digest(raw), f.owner.userId]);
    const session = await createSession(f.pool, g.registrar, 'device', deviceId);
    const cookie = `clinora_device=${raw}; clinora_session=${session}`;
    const req = (path: string, body?: unknown) => fetch(f.config.origin + path, {
      method: body ? 'POST' : 'GET', headers: { Cookie: cookie, ...(body ? { Origin: f.config.origin, 'Content-Type': 'application/json', 'X-CSRF-Token': digest('csrf:' + session) } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const path = `/api/clinics/${c}/registration/offline`;
    const person = (name: string) => ({ fullName: name, birthDate: '1990-01-01', gender: 'female', phone: null, districtId: null, mahallaId: null, address: null, source: 'walk_in' });
    const input = (name: string) => ({ patient: person(name), businessDayId: day, points: [{ queuePointId: g.pointA, serviceIds: [g.consultA] }], idempotencyKey: randomUUID() });
    const a = { ...input('Synthetic Offline One'), provisionalCode: 'R0123ABCD-01' };
    const [one, two] = await Promise.all([req(path, a), req(path, a)]);
    assert.equal(one.status, 201); assert.equal(two.status, 201);
    const result = await one.json(); assert.deepEqual(await two.json(), result);
    assert.equal(result.code, a.provisionalCode);
    const history = await (await req(path + '/history')).json();
    assert.deepEqual(history, [{ code: result.code, visitId: result.visitId, tickets: result.tickets }]);
    assert.equal('patientNo' in history[0]!, false);
    assert.equal((await f.pool.query('SELECT count(*)::int n FROM patients')).rows[0].n, 1);
    assert.equal((await f.pool.query('SELECT count(*)::int n FROM visits')).rows[0].n, 1);
    assert.equal((await req(path, { ...a, patient: person('Changed payload') })).status, 409);
    assert.equal((await req(path, { ...input('Synthetic Duplicate'), patient: a.patient })).status, 409);

    await f.pool.query('UPDATE services SET is_active=false WHERE id=$1', [g.consultA]);
    assert.equal((await req(path, input('Synthetic Inactive'))).status, 404);
    assert.equal((await f.pool.query('SELECT count(*)::int n FROM patients')).rows[0].n, 1, 'route failure rolls back patient registration');
    await f.pool.query('UPDATE services SET is_active=true WHERE id=$1', [g.consultA]);

    // Also recover a response lost on the original online route, using exactly the original key.
    const online = { ...person('Synthetic Online Lost'), idempotencyKey: randomUUID() };
    const p = await (await req(`/api/clinics/${c}/registration/patients`, online)).json();
    const v = { patientId: p.id, points: a.points, idempotencyKey: randomUUID() };
    const original = await (await req(`/api/clinics/${c}/registration/visits`, v)).json();
    await closeDay(f.pool, day, f.owner.userId);
    assert.deepEqual(await (await req(path, { ...v, businessDayId: day })).json(), original, 'online committed visit recovered after day close');
    assert.deepEqual(await (await req(path, a)).json(), result, 'offline committed visit recovered after day close');
    const stale = input('Synthetic Closed');
    assert.equal((await req(path, stale)).status, 409);
    await openDay(f.pool, c, f.owner.userId, 1);
    assert.equal((await req(path, stale)).status, 409, 'never silently moves to a different business day');
    assert.equal((await f.pool.query('SELECT count(*)::int n FROM patients')).rows[0].n, 2);

    const passwordClient = f.client(); await passwordClient.login(g.email('registrar'));
    assert.equal((await passwordClient.request(path, a)).status, 403, 'unenrolled session denied even for a registrar');
    assert.equal((await passwordClient.request(path + '/history')).status, 403);
    assert.equal((await req(`/api/clinics/${f.other.clinicId}/registration/offline`, a)).status, 404);
    await f.pool.query("UPDATE memberships SET status='revoked' WHERE clinic_id=$1 AND user_id=$2", [c, g.registrar]);
    assert.equal((await req(path, a)).status, 404, 'cached replay checks membership');
    await f.pool.query("UPDATE memberships SET status='active' WHERE clinic_id=$1 AND user_id=$2", [c, g.registrar]);
    await f.pool.query('UPDATE devices SET revoked_at=now(),revoked_by=$2 WHERE id=$1', [deviceId, f.owner.userId]);
    assert.equal((await req(path, a)).status, 401, 'cached replay checks device revocation');
  } finally { await f.close(); }
});
