import test from 'node:test';
import assert from 'node:assert/strict';
import { httpFixture,patientInput,encounterInput,key } from './fixture.js';

test('failed patient and encounter transactions cannot leave orphan assignments, documents or replay results',async t=>{
  const f=await httpFixture();t.after(()=>f.close());const c=f.client();await c.login();const base=`/api/clinics/${f.owner.clinicId}/patients`;
  await f.pool.query("CREATE FUNCTION fail_creation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action IN ('patient.created','encounter.created') THEN RAISE EXCEPTION 'synthetic transaction failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_creation BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_creation()");
  const pkey=key();assert.equal((await c.request(base,patientInput,{'Idempotency-Key':pkey})).status,503);
  assert.equal((await f.pool.query('SELECT count(*) FROM patients')).rows[0].count,'0');
  assert.equal((await f.pool.query('SELECT count(*) FROM patient_assignments')).rows[0].count,'0');
  assert.equal((await f.pool.query('SELECT count(*) FROM idempotency_records')).rows[0].count,'0');
  await f.pool.query('DROP TRIGGER fail_creation ON audit_events');
  const p=await(await c.request(base,patientInput,{'Idempotency-Key':pkey})).json();assert.ok(p.id);
  await f.pool.query('CREATE TRIGGER fail_creation BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_creation()');
  const ekey=key();assert.equal((await c.request(base+'/'+p.id+'/encounters',encounterInput,{'Idempotency-Key':ekey})).status,503);
  assert.equal((await f.pool.query('SELECT count(*) FROM encounters')).rows[0].count,'0');assert.equal((await f.pool.query('SELECT count(*) FROM documents')).rows[0].count,'0');
  assert.equal((await f.pool.query('SELECT count(*) FROM idempotency_records WHERE key=$1',[ekey])).rows[0].count,'0');
  await f.pool.query('DROP TRIGGER fail_creation ON audit_events');
  const duplicates=await Promise.all([c.request(base+'/'+p.id+'/encounters',encounterInput,{'Idempotency-Key':ekey}),c.request(base+'/'+p.id+'/encounters',encounterInput,{'Idempotency-Key':ekey})]);
  assert.ok(duplicates.every(r=>r.status===201));const bodies=await Promise.all(duplicates.map(r=>r.json()));assert.equal(bodies[0].encounter.id,bodies[1].encounter.id);
  assert.equal((await f.pool.query('SELECT count(*) FROM encounters')).rows[0].count,'1');assert.equal((await f.pool.query('SELECT count(*) FROM documents')).rows[0].count,'1');
});
