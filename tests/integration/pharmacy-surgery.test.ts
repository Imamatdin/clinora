import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { httpFixture } from './fixture.js';
import { transaction } from '../../src/server/database.js';
import { requireRole } from '../../src/server/roles.js';
import { dispense } from '../../src/modules/pharmacy/actions.js';
import { passwordHash } from '../../src/server/security.js';

let f:Awaited<ReturnType<typeof httpFixture>>,client:ReturnType<typeof f.client>;
const ids={day:randomUUID(),patient:randomUUID(),visit:randomUUID(),medicine:randomUUID(),operation:randomUUID(),pharmacist:randomUUID()};
const key=()=>randomUUID();
const url=(p:string)=>`/api/clinics/${f.owner.clinicId}/${p}`;
test.before(async()=>{
  f=await httpFixture();client=f.client();await client.login();
  const c=f.owner.clinicId,u=f.owner.userId;
  await f.pool.query("INSERT INTO business_days(id,clinic_id,business_date,status,opened_by) VALUES($1,$2,'2026-11-12','open',$3)",[ids.day,c,u]);
  await f.pool.query(`INSERT INTO patients(id,clinic_id,display_name,provenance) VALUES($1,$2,'Synthetic Pharmacy','{}')`,[ids.patient,c]);
  await f.pool.query("INSERT INTO visits(id,clinic_id,patient_id,business_day_id,type,created_by,created_at) VALUES($1,$2,$3,$4,'outpatient',$5,now()-interval '1 hour')",[ids.visit,c,ids.patient,ids.day,u]);
  await f.pool.query("INSERT INTO services(id,clinic_id,kind,name_uz_cyrl,track_stock) VALUES($1,$2,'medicine','Синтетик дори',true),($3,$2,'surgery','Синтетик операция',false)",[ids.medicine,c,ids.operation]);
  for(const s of [ids.medicine,ids.operation]) await f.pool.query("INSERT INTO service_prices(id,clinic_id,service_id,price_uzs,effective_from,set_by) VALUES($1,$2,$3,15000,'2026-01-01',$4)",[key(),c,s,u]);
  await f.pool.query('INSERT INTO doctor_profiles(clinic_id,user_id) VALUES($1,$2)',[c,u]);
  await f.pool.query("INSERT INTO accounts(id,login,display_name,password_hash) VALUES($1,'pharmacist.test','Synthetic pharmacist','disabled')",[ids.pharmacist]);
  await f.pool.query("INSERT INTO memberships(id,clinic_id,user_id,status,granted_by) VALUES($1,$2,$3,'active',$4)",[key(),c,ids.pharmacist,u]);
  await f.pool.query("INSERT INTO membership_roles(clinic_id,user_id,role,granted_by) VALUES($1,$2,'pharmacy',$3)",[c,ids.pharmacist,u]);
});
test.after(async()=>{await f?.close();});
test('every new route rejects unauthenticated, wrong-role and cross-clinic calls before parsing the body',async()=>{
  const user=key(),c=f.owner.clinicId,u=f.owner.userId;
  await f.pool.query("INSERT INTO accounts(id,email,display_name,password_hash) VALUES($1,'cashier.task012@example.test','Synthetic Cashier',$2)",[user,await passwordHash(f.password)]);
  await f.pool.query("INSERT INTO memberships(id,clinic_id,user_id,status,granted_by) VALUES($1,$2,$3,'active',$4)",[key(),c,user,u]);
  await f.pool.query("INSERT INTO membership_roles(clinic_id,user_id,role,granted_by) VALUES($1,$2,'cashier',$3)",[c,user,u]);
  const wrong=f.client(),foreign=f.client(),anonymous=f.client();await wrong.login('cashier.task012@example.test');await foreign.login('other@example.test');
  for(const [path,body] of [ ['pharmacy/stock',undefined],['pharmacy/visits',undefined],[`pharmacy/stock/${ids.medicine}/history`,undefined],['surgery/options',undefined],
    ['pharmacy/receipts',{}],['pharmacy/dispense',{}],['pharmacy/adjustments',{}],['pharmacy/threshold',{}],['surgery',{}] ] as const){
    assert.equal((await anonymous.request(url(path),body)).status,401,path);
    assert.equal((await wrong.request(url(path),body)).status,403,path);
    assert.equal((await foreign.request(url(path),body)).status,404,path);
  }
});
test('receipt replay, last-unit concurrency, price snapshot, atomic dispense and payload conflicts',async()=>{
  const receipt={serviceId:ids.medicine,qty:1,unitCostUzs:'9007199254740993',supplier:'Synthetic',idempotencyKey:key()};
  assert.equal((await client.request(url('pharmacy/receipts'),receipt)).status,201);
  assert.equal((await client.request(url('pharmacy/receipts'),receipt)).status,201);
  const post=()=>client.request(url('pharmacy/dispense'),{visitId:ids.visit,serviceId:ids.medicine,qty:1,idempotencyKey:key()});
  const results=await Promise.all([post(),post()]);assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
  const movements=(await f.pool.query('SELECT qty,unit_cost_uzs FROM stock_movements WHERE service_id=$1 ORDER BY qty',[ids.medicine])).rows;
  assert.equal(movements.length,2);assert.equal(movements[0].qty,-1);assert.equal(movements[1].unit_cost_uzs,'9007199254740993');
  const input={visitId:ids.visit,serviceId:ids.medicine,qty:1,overrideReason:'Synthetic approved shortage',idempotencyKey:key()};
  const first=await client.request(url('pharmacy/dispense'),input);assert.equal(first.status,201);const result=await first.json();
  assert.deepEqual(await (await client.request(url('pharmacy/dispense'),input)).json(),result);
  assert.equal((await client.request(url('pharmacy/dispense'),{...input,qty:2})).status,409);
  const row=(await f.pool.query('SELECT * FROM charge_lines WHERE id=$1',[result.chargeLineId])).rows[0];assert.equal(row.unit_price_uzs,'15000');assert.equal(row.status,'completed');
  await f.pool.query("INSERT INTO service_prices(id,clinic_id,service_id,price_uzs,effective_from,set_by) VALUES($1,$2,$3,27000,now(),$4)",[key(),f.owner.clinicId,ids.medicine,f.owner.userId]);
  assert.equal((await f.pool.query('SELECT unit_price_uzs FROM charge_lines WHERE id=$1',[result.chargeLineId])).rows[0].unit_price_uzs,'15000');
  const audit=(await f.pool.query("SELECT detail FROM audit_events WHERE action='pharmacy.dispensed' AND resource_id=$1",[result.id])).rows[0];assert.equal(audit.detail.approver,f.owner.userId);
  const stock=await (await client.request(url('pharmacy/stock'))).json();assert.equal(stock[0].on_hand,'-1');
});
test('pharmacist cannot authorize negative stock or forge a manager; direct calls recheck roles',async()=>{
  const input={visitId:ids.visit,serviceId:ids.medicine,qty:1,overrideReason:'Synthetic reason',idempotencyKey:key()};
  await assert.rejects(transaction(f.pool,async tx=>dispense(await requireRole(tx,ids.pharmacist,f.owner.clinicId,['pharmacy']),input)),{code:'FORBIDDEN'});
  await f.pool.query("DELETE FROM membership_roles WHERE clinic_id=$1 AND user_id=$2",[f.owner.clinicId,ids.pharmacist]);
  await assert.rejects(transaction(f.pool,tx=>dispense({tx,actorId:ids.pharmacist,clinicId:f.owner.clinicId,roles:['administrator']},input)),{code:'FORBIDDEN'});
});
test('adjustment reasons, threshold and movement history persist; foreign clinics cannot read stock',async()=>{
  assert.equal((await client.request(url('pharmacy/adjustments'),{serviceId:ids.medicine,qty:2,reason:'',idempotencyKey:key()})).status,422);
  assert.equal((await client.request(url('pharmacy/adjustments'),{serviceId:ids.medicine,qty:2,reason:'Synthetic recount',idempotencyKey:key()})).status,201);
  assert.equal((await client.request(url('pharmacy/threshold'),{serviceId:ids.medicine,threshold:5,idempotencyKey:key()})).status,200);
  const rows=await (await client.request(url('pharmacy/stock'))).json();assert.equal(rows[0].on_hand,'1');assert.equal(rows[0].threshold,5);
  assert.equal((await (await client.request(url(`pharmacy/stock/${ids.medicine}/history`))).json()).length,4);
  const other=f.client();await other.login('other@example.test');assert.equal((await other.request(url('pharmacy/stock'))).status,404);
  const before=(await f.pool.query('SELECT count(*) FROM charge_lines')).rows[0].count;
  assert.equal((await other.request(`/api/clinics/${f.other.clinicId}/pharmacy/dispense`,{visitId:ids.visit,serviceId:ids.medicine,qty:1,idempotencyKey:key()})).status,404);
  assert.equal((await f.pool.query('SELECT count(*) FROM charge_lines')).rows[0].count,before);
});
test('a service without a price cannot consume stock or create an orphan charge',async()=>{
  const service=key(),c=f.owner.clinicId,u=f.owner.userId;
  await f.pool.query("INSERT INTO services(id,clinic_id,kind,name_uz_cyrl,track_stock) VALUES($1,$2,'good','Синтетик товар',true)",[service,c]);
  assert.equal((await client.request(url('pharmacy/receipts'),{serviceId:service,qty:1,unitCostUzs:'1000',supplier:'Synthetic',idempotencyKey:key()})).status,201);
  assert.equal((await client.request(url('pharmacy/dispense'),{serviceId:service,visitId:ids.visit,qty:1,idempotencyKey:key()})).status,409);
  assert.equal((await f.pool.query('SELECT sum(qty)::text n FROM stock_movements WHERE service_id=$1',[service])).rows[0].n,'1');
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM charge_lines WHERE service_id=$1',[service])).rows[0].n,0);
});
test('doctor dispersion is assigned-patient only and cached responses do not bypass revoked assignments',async()=>{
  const actor=key(),c=f.owner.clinicId,u=f.owner.userId;
  await f.pool.query("INSERT INTO accounts(id,email,display_name,password_hash) VALUES($1,'doctor.task012@example.test','Synthetic doctor',$2)",[actor,await passwordHash(f.password)]);
  await f.pool.query("INSERT INTO memberships(id,clinic_id,user_id,status,granted_by) VALUES($1,$2,$3,'active',$4)",[key(),c,actor,u]);
  await f.pool.query("INSERT INTO membership_roles(clinic_id,user_id,role,granted_by) VALUES($1,$2,'doctor',$3)",[c,actor,u]);
  const doctor=f.client();await doctor.login('doctor.task012@example.test');
  const input={serviceId:ids.medicine,visitId:ids.visit,qty:1,idempotencyKey:key()};
  assert.equal((await doctor.request(url('pharmacy/dispense'),input)).status,403);
  await f.pool.query('INSERT INTO patient_assignments(clinic_id,patient_id,user_id) VALUES($1,$2,$3)',[c,ids.patient,actor]);
  assert.equal((await doctor.request(url('pharmacy/dispense'),input)).status,201);
  await f.pool.query('DELETE FROM patient_assignments WHERE clinic_id=$1 AND patient_id=$2 AND user_id=$3',[c,ids.patient,actor]);
  assert.equal((await doctor.request(url('pharmacy/dispense'),input)).status,403);
});
test('surgery charges join the patient bill, replay once, reject foreign notes and mismatched admission',async()=>{
  const input={visitId:ids.visit,serviceId:ids.operation,surgeonId:f.owner.userId,performedAt:new Date().toISOString(),idempotencyKey:key()};
  const r=await client.request(url('surgery'),input);assert.equal(r.status,201);const result=await r.json();
  assert.deepEqual(await (await client.request(url('surgery'),input)).json(),result);
  const bill=(await f.pool.query(`SELECT c.* FROM charge_lines c JOIN visits v ON v.clinic_id=c.clinic_id AND v.id=c.visit_id WHERE v.patient_id=$1 AND c.source='surgery'`,[ids.patient])).rows;
  assert.equal(bill.length,1);assert.equal(bill[0].id,result.chargeLineId);assert.equal(bill[0].unit_price_uzs,'15000');
  assert.equal((await client.request(url('surgery'),{...input,documentId:key(),idempotencyKey:key()})).status,404);
  assert.equal((await client.request(url('surgery'),{...input,admissionId:key(),idempotencyKey:key()})).status,404);
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM surgeries')).rows[0].n,1);
});
test('closed business day rejects new dispense and surgery without creating either record',async()=>{
  await f.pool.query("UPDATE business_days SET status='closed',closed_by=$2,closed_at=now(),close_snapshot='{}' WHERE id=$1",[ids.day,f.owner.userId]);
  const input={visitId:ids.visit,serviceId:ids.medicine,qty:1,idempotencyKey:key()};
  assert.equal((await client.request(url('pharmacy/dispense'),input)).status,404);
  assert.equal((await client.request(url('surgery'),{visitId:ids.visit,serviceId:ids.operation,surgeonId:f.owner.userId,performedAt:new Date().toISOString(),idempotencyKey:key()})).status,404);
});
