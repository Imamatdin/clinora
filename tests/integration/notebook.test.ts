import { readdir } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createApp } from '../../src/server/app.js';
import { makePool } from '../../src/server/database.js';
import { digest } from '../../src/server/security.js';
import { httpFixture,patientInput,encounterInput,noteInput,key } from './fixture.js';

test('fresh migration repeat, explicit ownership, invitation scope/expiry/single use and pending registration',async t=>{
  const f=await httpFixture();t.after(()=>f.close());const owner=f.client(),pending=f.client();await owner.login();
  assert.equal((await f.pool.query('SELECT count(*) FROM schema_migrations')).rows[0].count,String((await readdir('db/migrations')).filter(n=>/^\d+.*\.sql$/.test(n)).length));
  const signup={email:'pending@example.test',displayName:'Synthetic Pending',password:f.password};
  assert.equal((await pending.request('/api/auth/register',{...signup,role:'doctor'})).status,422);
  assert.equal((await pending.request('/api/auth/register',signup)).status,202);
  const me=await pending.login(signup.email);assert.deepEqual(me.clinics,[]);assert.equal(me.professionalVerification.status,'unverified');
  const base=`/api/clinics/${f.owner.clinicId}`;
  assert.equal((await pending.request(base+'/patients')).status,403);
  assert.equal((await pending.request('/api/invitations/accept',{token:'a'.repeat(64)})).status,403);
  const issued=await owner.request(base+'/invitations',{email:signup.email});assert.equal(issued.status,201);
  const link=(await issued.json()).link;const raw=new URLSearchParams(new URL(link).hash.slice(1)).get('invite')!;
  const row=(await f.pool.query('SELECT token_hash FROM invitations')).rows[0];assert.equal(row.token_hash,digest(raw));assert.notEqual(row.token_hash,raw);
  await f.pool.query("UPDATE invitations SET expires_at=now()-interval '1 second'");
  assert.equal((await pending.request('/api/invitations/accept',{token:raw})).status,403);
  const second=await (await owner.request(base+'/invitations',{email:signup.email})).json();
  const valid=new URLSearchParams(new URL(second.link).hash.slice(1)).get('invite')!;
  const accepted=await Promise.all([pending.request('/api/invitations/accept',{token:valid}),pending.request('/api/invitations/accept',{token:valid})]);
  assert.deepEqual(accepted.map(r=>r.status).sort(),[200,403]);
  assert.equal((await pending.request('/api/invitations/accept',{token:valid})).status,403);
  const own=await pending.request(base+'/patients',patientInput,{'Idempotency-Key':key()});assert.equal(own.status,201);
  const patient=await own.json();assert.equal((await pending.request(base+'/patients/'+patient.id)).status,200);
  assert.equal((await pending.request(`/api/clinics/${f.other.clinicId}/patients`)).status,403);
  await f.pool.query('UPDATE memberships SET clinical_access=false WHERE clinic_id=$1 AND user_id=$2',[f.owner.clinicId,f.owner.userId]);
  assert.equal((await owner.request(base+'/patients')).status,403,'an owner role alone must not grant clinical reads');
});

test('HTTP session hashes, CSRF, unsupported bearer, logout/expiry, blocked and revoked access',async t=>{
  const f=await httpFixture();t.after(()=>f.close());const c=f.client();await c.login();const base=`/api/clinics/${f.owner.clinicId}/patients`;
  const cookieResponse=await c.request('/api/auth/login',{email:'owner@example.test',password:f.password});
  assert.match(cookieResponse.headers.get('set-cookie')!,/HttpOnly; Path=\/; SameSite=Strict/);
  f.config.secureCookies=true;const secure=await c.request('/api/auth/login',{email:'owner@example.test',password:f.password});assert.match(secure.headers.get('set-cookie')!,/; Secure/);f.config.secureCookies=false;
  await c.login();
  const token=c.cookie.split('=')[1]!;
  assert.equal((await f.pool.query('SELECT count(*) FROM sessions WHERE token_hash=$1',[token])).rows[0].count,'0');
  assert.equal((await f.pool.query('SELECT count(*) FROM sessions WHERE token_hash=$1',[digest(token)])).rows[0].count,'1');
  assert.equal((await c.request(base,patientInput,{'Idempotency-Key':key(),'X-CSRF-Token':''})).status,403);
  assert.equal((await c.request(base,patientInput,{'Idempotency-Key':key(),Origin:'https://evil.example'})).status,403);
  assert.equal((await c.request('/api/auth/me',undefined,{Authorization:'Bearer forged'})).status,401);
  assert.equal((await c.request('/api/auth/me',undefined,{Cookie:'clinora_session='+ 'a'.repeat(64)})).status,401);
  assert.equal((await c.request('/api/auth/logout',{})).status,200);
  assert.equal((await c.request('/api/auth/me')).status,401);
  await c.login();await f.pool.query("UPDATE sessions SET expires_at=now()-interval '1 second'");assert.equal((await c.request('/api/auth/me')).status,401);
  await c.login();await f.pool.query("UPDATE memberships SET status='blocked' WHERE user_id=$1",[f.owner.userId]);assert.equal((await c.request(base)).status,403);
  await f.pool.query("UPDATE memberships SET status='active' WHERE user_id=$1",[f.owner.userId]);assert.equal((await c.request(base)).status,200);
  await f.pool.query("UPDATE memberships SET status='revoked' WHERE user_id=$1",[f.owner.userId]);assert.equal((await c.request(base)).status,403);
  await f.pool.query("UPDATE accounts SET status='blocked' WHERE id=$1",[f.owner.userId]);assert.equal((await c.request('/api/auth/me')).status,401);
  const denied=await c.request('/api/auth/login',{email:'absent@example.test',password:'not-the-password'});assert.equal(denied.status,401);
  for(let i=0;i<9;i++)await c.request('/api/auth/login',{email:'throttle@example.test',password:'not-the-password'});
  assert.equal((await c.request('/api/auth/login',{email:'throttle@example.test',password:'not-the-password'})).status,429);
});

test('patient and clinic isolation, duplicate names, unique clinic MRN and DB composite references',async t=>{
  const f=await httpFixture();t.after(()=>f.close());const a=f.client(),b=f.client();await a.login();await b.login('other@example.test');
  const ba=`/api/clinics/${f.owner.clinicId}/patients`,bb=`/api/clinics/${f.other.clinicId}/patients`;
  const p=await(await a.request(ba,{...patientInput,mrn:'SYN-1'},{'Idempotency-Key':key()})).json();
  assert.equal((await a.request(ba,{...patientInput,mrn:'SYN-1'},{'Idempotency-Key':key()})).status,422);
  assert.equal((await b.request(bb,{...patientInput,mrn:'SYN-1'},{'Idempotency-Key':key()})).status,201);
  assert.equal((await a.request(ba,patientInput,{'Idempotency-Key':key()})).status,201,'duplicate names allowed');
  assert.equal((await b.request(ba+'/'+p.id)).status,403);
  assert.equal((await b.request(bb+'/'+p.id)).status,404);
  assert.equal((await b.request(bb+'/'+p.id+'/encounters',encounterInput,{'Idempotency-Key':key()})).status,404);
  assert.equal((await b.request(bb+'?q=SYN-1')).status,200);
  const signup={email:'sameclinic@example.test',displayName:'Synthetic Assigned Doctor',password:f.password};const c=f.client();await c.request('/api/auth/register',signup);const me=await c.login(signup.email);
  await f.pool.query("INSERT INTO memberships(id,clinic_id,user_id,role,clinical_access,status,granted_by) VALUES($1,$2,$3,'clinician',true,'active',$4)",[randomUUID(),f.owner.clinicId,me.id,f.owner.userId]);
  assert.deepEqual(await(await c.request(ba+'?q=Fictional')).json(),[]);
  assert.equal((await c.request(ba+'/'+p.id)).status,404);
  assert.equal((await c.request(ba+'/'+p.id+'/encounters',encounterInput,{'Idempotency-Key':key()})).status,404);
  await assert.rejects(f.pool.query('INSERT INTO encounters(id,clinic_id,patient_id,clinician_id,data) VALUES($1,$2,$3,$4,$5)',[randomUUID(),f.other.clinicId,p.id,f.other.userId,{}]),(e:unknown)=>!!e&&typeof e==='object'&&'code'in e&&e.code==='23503');
});

test('concurrent idempotency, changed-payload conflicts, actor scope and retry after lost response',async t=>{
  const f=await httpFixture();t.after(()=>f.close());const c=f.client();await c.login();const base=`/api/clinics/${f.owner.clinicId}/patients`,k=key();
  const rs=await Promise.all(Array.from({length:4},()=>c.request(base,patientInput,{'Idempotency-Key':k})));
  assert.ok(rs.every(r=>r.status===201));const bodies=await Promise.all(rs.map(r=>r.json()));assert.ok(bodies.every(b=>b.id===bodies[0].id));
  assert.equal((await f.pool.query('SELECT count(*) FROM patients')).rows[0].count,'1');
  assert.equal((await c.request(base,{...patientInput,displayName:'Different payload'},{'Idempotency-Key':k})).status,409);
  const recovered=await(await c.request(base,patientInput,{'Idempotency-Key':k})).json();assert.equal(recovered.id,bodies[0].id);
  const b=f.client();await b.login('other@example.test');const different=await(await b.request(`/api/clinics/${f.other.clinicId}/patients`,patientInput,{'Idempotency-Key':k})).json();assert.notEqual(different.id,recovered.id);
});

test('versioned drafts persist across server restart; concurrent edits conflict and approval forgery is rejected',async t=>{
  const f=await httpFixture();t.after(()=>f.close());const c=f.client();await c.login();const base=`/api/clinics/${f.owner.clinicId}/patients`;
  const p=await(await c.request(base,patientInput,{'Idempotency-Key':key()})).json();const endpoint=base+'/'+p.id+'/encounters';
  const v=await(await c.request(endpoint,encounterInput,{'Idempotency-Key':key()})).json();const save=endpoint+'/'+v.encounter.id+'/draft';
  for(const extra of [{status:'approved'},{approvedBy:f.owner.userId},{revision:99},{versionId:randomUUID()}])assert.equal((await c.request(save,{...noteInput,...extra},{'Idempotency-Key':key()})).status,422);
  const k=key();const first=await c.request(save,noteInput,{'Idempotency-Key':k});assert.equal(first.status,200);const doc=await first.json();
  assert.equal(doc.version.fields.find((x:{key:string})=>x.key==='observed').value,null);
  assert.equal((await(await c.request(save,noteInput,{'Idempotency-Key':k})).json()).version.id,doc.version.id);
  const updated={...noteInput,expectedRevision:1};const pair=await Promise.all([c.request(save,{...updated,note:{...noteInput.note,reported:'Client A update'}},{'Idempotency-Key':key()}),c.request(save,{...updated,note:{...noteInput.note,reported:'Client B update'}},{'Idempotency-Key':key()})]);
  assert.deepEqual(pair.map(r=>r.status).sort(),[200,409]);
  const detail=await(await c.request(base+'/'+p.id)).json();await f.restart();assert.deepEqual(await(await c.request(base+'/'+p.id)).json(),detail);
  const history=await f.pool.query('SELECT count(*) FROM document_versions');assert.equal(history.rows[0].count,'2');
  await assert.rejects(f.pool.query("UPDATE document_versions SET data='{}' WHERE id=$1",[doc.version.id]));
  assert.equal((await f.pool.query("SELECT count(*) FROM audit_events WHERE action='draft.saved'")).rows[0].count,'2');
});

test('timeline preserves visit-specific dates, clinicians, location and unapproved historical assessment',async t=>{
  const f=await httpFixture();t.after(()=>f.close());const c=f.client();await c.login();const base=`/api/clinics/${f.owner.clinicId}/patients`;
  const p=await(await c.request(base,patientInput,{'Idempotency-Key':key()})).json(),end=base+'/'+p.id+'/encounters';
  const old=await(await c.request(end,encounterInput,{'Idempotency-Key':key()})).json();await c.request(end+'/'+old.encounter.id+'/draft',noteInput,{'Idempotency-Key':key()});
  await c.request(end,{occurrence:{precision:'unknown',reason:'Imported undated synthetic record'},location:'Historical clinic',specialty:'Cardiology'},{'Idempotency-Key':key()});
  await c.request(end,{occurrence:{precision:'instant',at:'2026-11-11T09:00:00+05:00',timezone:'Asia/Tashkent'},location:'Current room',specialty:'General medicine'},{'Idempotency-Key':key()});
  const detail=await(await c.request(base+'/'+p.id)).json();assert.deepEqual(detail.visits.map((v:{encounter:{occurrence:{precision:string}}})=>v.encounter.occurrence.precision),['instant','date','unknown']);
  assert.equal(detail.visits[1].encounter.occurrence.date,'2020-02-29');assert.equal(detail.visits[1].encounter.location.label,encounterInput.location);
  assert.notEqual(detail.visits[1].encounter.createdAt.slice(0,10),'2020-02-29');assert.equal(detail.visits[1].encounter.status,'draft');
  assert.equal(detail.visits[1].version.fields.find((x:{key:string})=>x.key==='assessment').status,'proposed');
});

test('transaction failure rolls back draft, current version, idempotency result and audit; unavailable DB returns 503',async t=>{
  const f=await httpFixture();t.after(()=>f.close());const c=f.client();await c.login();const base=`/api/clinics/${f.owner.clinicId}/patients`;
  const p=await(await c.request(base,patientInput,{'Idempotency-Key':key()})).json(),end=base+'/'+p.id+'/encounters';const v=await(await c.request(end,encounterInput,{'Idempotency-Key':key()})).json();
  await f.pool.query("CREATE FUNCTION reject_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='draft.saved' THEN RAISE EXCEPTION 'synthetic rollback test'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_test_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_test_audit()");
  const k=key();assert.equal((await c.request(end+'/'+v.encounter.id+'/draft',noteInput,{'Idempotency-Key':k})).status,503);
  assert.equal((await f.pool.query('SELECT count(*) FROM document_versions')).rows[0].count,'0');assert.equal((await f.pool.query('SELECT current_revision FROM documents')).rows[0].current_revision,0);
  assert.equal((await f.pool.query('SELECT count(*) FROM idempotency_records WHERE key=$1',[k])).rows[0].count,'0');
  const broken=makePool('postgresql://synthetic:unused@127.0.0.1:1/clinora_test');const server=await createApp(undefined,{pool:broken,origin:'http://127.0.0.1',secureCookies:false});
  server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');
  try {
    for(const route of ['/api/health','/api/auth/login']) {
      const response: Response = await fetch(`http://127.0.0.1:${address.port}`+route, route.endsWith('login') ? {
        method:'POST', headers:{Origin:'http://127.0.0.1','Content-Type':'application/json'},
        body:JSON.stringify({email:'synthetic@example.test',password:'synthetic-password'})
      } : {});
      assert.equal(response.status,503);
      assert.equal((await response.json()).error.code,'SERVICE_UNAVAILABLE');
    }
  }
  finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await broken.end();}
});
