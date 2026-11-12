import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { httpFixture } from './fixture.js';

const path = '/api/auth/login';
type Fixture = Awaited<ReturnType<typeof httpFixture>>;
async function person(f: Fixture, login: string) {
  const id = randomUUID();
  await f.pool.query(`INSERT INTO accounts(id,login,phone,email,display_name,password_hash,managed_by_clinic_id)
    SELECT $1,$2,'+998901234567','staff@example.test','Synthetic Staff',password_hash,$3 FROM accounts WHERE id=$4`,
    [id, login, f.owner.clinicId, f.owner.userId]);
  await f.pool.query(`INSERT INTO memberships(id,clinic_id,user_id,status,granted_by) VALUES($1,$2,$3,'active',$4)`, [randomUUID(),f.owner.clinicId,id,f.owner.userId]);
  await f.pool.query(`INSERT INTO membership_roles(clinic_id,user_id,role,granted_by) VALUES($1,$2,'doctor',$3)`, [f.owner.clinicId,id,f.owner.userId]);
  return id;
}
const sign = (f: Fixture, identifier: string, password = f.password) => f.client().request(path, { identifier, password });

test('shift start: 20 staff and repeated successes share one IP without using a failure budget', async t => {
  const f = await httpFixture(); t.after(()=>f.close());
  for (let i=0;i<20;i++) {
    await f.pool.query(`INSERT INTO accounts(id,login,display_name,password_hash) SELECT $1,$2,'Synthetic',password_hash FROM accounts WHERE id=$3`, [randomUUID(),`shift.${i}`,f.owner.userId]);
  }
  for (let i=0;i<20;i++) assert.equal((await sign(f,`shift.${i}`)).status,200);
  for (let i=0;i<25;i++) assert.equal((await sign(f,'owner@example.test')).status,200);
});

test('ten consecutive failures lock only one account, across normalized identifiers and aliases; unknown responses match', async t => {
  const f = await httpFixture(); t.after(()=>f.close()); await person(f,'staff.one');
  for (let i=1;i<=10;i++) {
    const known=await sign(f,i%2 ? ' STAFF.ONE ' : '90 123-45-67','wrong');
    const unknown=await sign(f,' ABSENT.ONE ','wrong');
    assert.equal(known.status,i===10 ? 429 : 401); assert.equal(unknown.status,known.status);
    const a=await known.json(),b=await unknown.json();
    assert.equal(a.error.code,b.error.code); assert.equal(a.error.message,b.error.message);
    if(i===10) { assert.ok(Date.parse(a.error.unlockAt)>Date.now()); assert.ok(Date.parse(b.error.unlockAt)>Date.now()); }
  }
  assert.equal((await sign(f,'STAFF@EXAMPLE.TEST')).status,429,'aliases cannot bypass lock');
  assert.equal((await sign(f,'other@example.test')).status,200);
  await f.restart(); assert.equal((await sign(f,'staff.one')).status,429,'persistent across restart');
});

test('success resets failures; expiry restores access; concurrent failures cannot lose increments or extend a lock', async t => {
  const f=await httpFixture(); t.after(()=>f.close()); await person(f,'staff.one');
  for(let i=0;i<9;i++) assert.equal((await sign(f,'staff.one','wrong')).status,401);
  assert.equal((await sign(f,'staff.one')).status,200);
  assert.equal((await sign(f,'staff.one','wrong')).status,401);
  const responses=await Promise.all(Array.from({length:9},()=>sign(f,'staff.one','wrong')));
  assert.equal(responses.filter(r=>r.status===429).length,1);
  const locked=await (await sign(f,'staff.one')).json();
  const retry=await (await sign(f,'staff.one','wrong')).json(); assert.equal(retry.error.unlockAt,locked.error.unlockAt);
  await f.pool.query(`UPDATE password_login_limits SET locked_until=now()-interval '1 second' WHERE locked_until IS NOT NULL`);
  assert.equal((await sign(f,'staff.one')).status,200);
});

test('manager unlock is clinic scoped, role checked, CSRF protected and audited', async t => {
  const f=await httpFixture(); t.after(()=>f.close()); const id=await person(f,'staff.one');
  const staff=f.client(); const login=await staff.request(path,{identifier:'staff.one',password:f.password}); assert.equal(login.status,200);
  const me=await (await staff.request('/api/auth/me')).json();
  const admin=f.client(); await admin.login();
  const route=`/api/clinics/${f.owner.clinicId}/staff/${id}/login-unlock`;
  for(let i=0;i<10;i++) await sign(f,'staff.one','wrong');
  assert.equal((await staff.request(route,{}, {'X-CSRF-Token':me.csrf})).status,403);
  assert.equal((await admin.request(route,{}, {'X-CSRF-Token':'wrong'})).status,403);
  const other=f.client(); await other.login('other@example.test'); assert.equal((await other.request(route,{})).status,404);
  assert.equal((await sign(f,'staff.one')).status,429);
  assert.equal((await admin.request(route,{})).status,200);
  assert.equal((await sign(f,'staff.one')).status,200);
  const rows=(await f.pool.query(`SELECT actor_id,clinic_id,resource_id FROM audit_events WHERE action='login.unlocked'`)).rows;
  assert.deepEqual(rows,[{actor_id:f.owner.userId,clinic_id:f.owner.clinicId,resource_id:id}]);
});
