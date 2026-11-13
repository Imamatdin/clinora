import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { httpFixture,patientInput,encounterInput,noteInput,key,plainAccount } from './fixture.js';

async function assignedFixture() {
  const f=await httpFixture(), c=f.client();
  const email='replay-doctor@example.test';
  await plainAccount(f.pool,{email,password:f.password,displayName:'Synthetic Assigned Clinician'});
  const me=await c.login(email);
  await f.pool.query("INSERT INTO memberships(id,clinic_id,user_id,role,clinical_access,patient_scope,status,granted_by) VALUES($1,$2,$3,'clinician',true,'assigned','active',$4)",
    [randomUUID(),f.owner.clinicId,me.id,f.owner.userId]);
  const base=`/api/clinics/${f.owner.clinicId}/patients`, createKey=key();
  const bodyA={...patientInput,displayName:'Fictional Replay A',mrn:'SYN-REPLAY-A'};
  const responseA=await c.request(base,bodyA,{'Idempotency-Key':createKey});assert.equal(responseA.status,201);
  const a=await responseA.json();
  const responseB=await c.request(base,{...patientInput,displayName:'Fictional Replay B'}, {'Idempotency-Key':key()});assert.equal(responseB.status,201);
  const b=await responseB.json();
  const encounter=await c.request(`${base}/${a.id}/encounters`,encounterInput,{'Idempotency-Key':key()});assert.equal(encounter.status,201);
  const ea=await encounter.json(), saveKey=key();
  const draftPath=(patient:string)=>`${base}/${patient}/encounters/${ea.encounter.id}/draft`;
  const savedResponse=await c.request(draftPath(a.id),noteInput,{'Idempotency-Key':saveKey});assert.equal(savedResponse.status,200);
  const saved=await savedResponse.json();
  return {...f,c,userId:me.id,base,bodyA,createKey,a,b,ea,saveKey,saved,draftPath};
}
async function counts(f:Awaited<ReturnType<typeof assignedFixture>>) {
  const result=await f.pool.query(`SELECT
    (SELECT count(*) FROM patients)::int patients,
    (SELECT count(*) FROM patient_assignments)::int assignments,
    (SELECT count(*) FROM document_versions)::int revisions,
    (SELECT count(*) FROM audit_events)::int audit,
    (SELECT count(*) FROM idempotency_records)::int replays`);
  return result.rows[0];
}
async function deniedWithoutDisclosure(response:Response,status:number,forbidden:string[]) {
  assert.equal(response.status,status,'a cached result must not bypass current resource authorization');
  const text=await response.text();
  for(const value of forbidden)assert.equal(text.includes(value),false,'denial must not contain clinical identifiers or note text');
  assert.equal(JSON.parse(text).error.code,status===404?'NOT_FOUND':status===401?'UNAUTHENTICATED':'FORBIDDEN');
}
function sensitive(f:Awaited<ReturnType<typeof assignedFixture>>) {
  return [f.a.id,f.a.displayName,f.a.dateOfBirth,f.a.mrn,f.ea.encounter.id,f.saved.version.id,f.saved.version.documentId,noteInput.note.reported];
}

test('cached and fresh draft saves reject mismatched patient/encounter while both assignments remain active',async t=>{
  const f=await assignedFixture();t.after(()=>f.close());const before=await counts(f);
  assert.equal((await f.c.request(`${f.base}/${f.a.id}`)).status,200);
  assert.equal((await f.c.request(`${f.base}/${f.b.id}`)).status,200);
  await deniedWithoutDisclosure(await f.c.request(f.draftPath(f.b.id),noteInput,{'Idempotency-Key':key()}),404,sensitive(f));
  await deniedWithoutDisclosure(await f.c.request(f.draftPath(f.b.id),noteInput,{'Idempotency-Key':f.saveKey}),404,sensitive(f));
  assert.deepEqual(await counts(f),before);
});

test('cached draft cannot be replayed through another permitted patient after original assignment revocation',async t=>{
  const f=await assignedFixture();t.after(()=>f.close());
  await f.pool.query('DELETE FROM patient_assignments WHERE clinic_id=$1 AND patient_id=$2 AND user_id=$3',[f.owner.clinicId,f.a.id,f.userId]);
  const before=await counts(f);
  await deniedWithoutDisclosure(await f.c.request(`${f.base}/${f.a.id}`),404,sensitive(f));
  assert.equal((await f.c.request(`${f.base}/${f.b.id}`)).status,200);
  await deniedWithoutDisclosure(await f.c.request(f.draftPath(f.b.id),noteInput,{'Idempotency-Key':f.saveKey}),404,sensitive(f));
  await deniedWithoutDisclosure(await f.c.request(f.draftPath(f.a.id),noteInput,{'Idempotency-Key':f.saveKey}),404,sensitive(f));
  assert.deepEqual(await counts(f),before);
});

test('patient-create replay reauthorizes stored patient and never recreates a chart or restores revoked assignment',async t=>{
  const f=await assignedFixture();t.after(()=>f.close());
  assert.deepEqual(await(await f.c.request(f.base,f.bodyA,{'Idempotency-Key':f.createKey})).json(),f.a,'authorized create replay returns its original result');
  await f.pool.query('DELETE FROM patient_assignments WHERE clinic_id=$1 AND patient_id=$2 AND user_id=$3',[f.owner.clinicId,f.a.id,f.userId]);
  const before=await counts(f);
  const search=await f.c.request(f.base+'?q='+encodeURIComponent(f.a.displayName));assert.equal(search.status,200);assert.deepEqual(await search.json(),[]);
  await deniedWithoutDisclosure(await f.c.request(`${f.base}/${f.a.id}`),404,sensitive(f));
  await deniedWithoutDisclosure(await f.c.request(f.base,f.bodyA,{'Idempotency-Key':f.createKey}),404,sensitive(f));
  assert.deepEqual(await counts(f),before);
});

test('authorized stale-version replays stay exact; cached routes still deny revoked membership and session',async t=>{
  const f=await assignedFixture();t.after(()=>f.close());
  const second=await f.c.request(f.draftPath(f.a.id),{...noteInput,expectedRevision:1,note:{...noteInput.note,reported:'A newer synthetic revision'}},{'Idempotency-Key':key()});assert.equal(second.status,200);
  const before=await counts(f);
  const original=await f.c.request(f.draftPath(f.a.id),noteInput,{'Idempotency-Key':f.saveKey});assert.equal(original.status,200);assert.deepEqual(await original.json(),f.saved);
  const changed=await f.c.request(f.draftPath(f.a.id),{...noteInput,note:{...noteInput.note,reported:'Changed retry payload'}},{'Idempotency-Key':f.saveKey});assert.equal(changed.status,409);assert.equal((await changed.json()).error.code,'IDEMPOTENCY_CONFLICT');
  await f.pool.query("UPDATE memberships SET status='revoked' WHERE clinic_id=$1 AND user_id=$2",[f.owner.clinicId,f.userId]);
  await deniedWithoutDisclosure(await f.c.request(f.base,f.bodyA,{'Idempotency-Key':f.createKey}),403,sensitive(f));
  await deniedWithoutDisclosure(await f.c.request(f.draftPath(f.a.id),noteInput,{'Idempotency-Key':f.saveKey}),403,sensitive(f));
  await f.pool.query("UPDATE memberships SET status='active' WHERE clinic_id=$1 AND user_id=$2",[f.owner.clinicId,f.userId]);
  await f.pool.query('DELETE FROM sessions WHERE user_id=$1',[f.userId]);
  await deniedWithoutDisclosure(await f.c.request(f.base,f.bodyA,{'Idempotency-Key':f.createKey}),401,sensitive(f));
  await deniedWithoutDisclosure(await f.c.request(f.draftPath(f.a.id),noteInput,{'Idempotency-Key':f.saveKey}),401,sensitive(f));
  assert.deepEqual(await counts(f),before);
});

test('simultaneous assigned-clinician patient-create retries return the same newly authorized patient',async t=>{
  const f=await assignedFixture();t.after(()=>f.close());const before=await counts(f), k=key();
  const input={...patientInput,displayName:'Fictional Concurrent Replay Patient'};
  const responses=await Promise.all(Array.from({length:4},()=>f.c.request(f.base,input,{'Idempotency-Key':k})));
  assert.ok(responses.every(r=>r.status===201),'waiters must observe the creator assignment committed by the first request');
  const results=await Promise.all(responses.map(r=>r.json()));
  assert.ok(results.every(result=>result.id===results[0].id));
  assert.equal((await f.c.request(`${f.base}/${results[0].id}`)).status,200);
  assert.deepEqual(await counts(f),{...before,patients:before.patients+1,assignments:before.assignments+1,audit:before.audit+1,replays:before.replays+1});
});
