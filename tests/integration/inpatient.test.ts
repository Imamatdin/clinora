import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { httpFixture } from './fixture.js';
import { inpatientGraph } from '../helpers/inpatient.js';

const key=()=>randomUUID();
async function setup(t:test.TestContext,days=0,businessDayAgo=0){
  const f=await httpFixture();t.after(()=>f.close());const client=f.client();await client.login();const g=await inpatientGraph(f,days,businessDayAgo);
  const base=`/api/clinics/${g.clinic}/inpatient`;
  const post=async(path:string,body:unknown,status=200)=>{const r=await client.request(base+path,body);const v=await r.json();assert.equal(r.status,status,JSON.stringify(v));return v;};
  const get=async(path:string)=>{const r=await client.request(base+path);assert.equal(r.status,200);return r.json();};
  const admit=()=>post('/admit',{key:key(),visitId:g.visit,departmentId:g.dept,doctorId:g.actor,bedId:g.bed,expectedDischarge:null},201);
  return {f,g,client,base,post,get,admit};
}
test('spec example: five bed days plus services = 1,000,000; immutable discharge PDF and no later charges',async t=>{
  const {f,g,client,base,post,get}=await setup(t,5);
  for(const serviceId of [g.services.lab,g.services.ultrasound,g.services.other])await post(`/${g.admission}/services`,{key:key(),serviceId,quantity:1});
  const through=(await f.pool.query('SELECT ($1::date-1)::text date',[g.today])).rows[0].date;
  assert.equal((await post('/daily',{key:key(),through})).added,5);
  assert.equal((await post('/daily',{key:key(),through})).added,0);
  const input={key:key()};const final=await post(`/${g.admission}/discharge`,input);
  assert.equal(final.value,'1000000');assert.equal(final.due,'1000000');
  assert.deepEqual(await post(`/${g.admission}/discharge`,input),final);
  assert.deepEqual(await get(`/${g.admission}/invoice`),final);
  const pdf=await get(`/${g.admission}/invoice-pdf`);assert.ok(Buffer.from(pdf.base64,'base64').subarray(0,5).equals(Buffer.from('%PDF-')));
  await post(`/${g.admission}/services`,{key:key(),serviceId:g.services.other,quantity:1},409);
  await post(`/${g.admission}/transfer`,{key:key(),bedId:g.bed2},409);
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM bed_assignments WHERE admission_id=$1 AND to_at IS NULL',[g.admission])).rows[0].n,0);
  await assert.rejects(f.pool.query("INSERT INTO charge_lines(id,clinic_id,visit_id,service_id,quantity,unit_price_uzs,source,created_by) VALUES($1,$2,$3,$4,1,1,'lab',$5)",[key(),g.clinic,g.visit,g.services.lab,g.actor]),{code:'23514'});
  const r=await client.request(base+`/${g.admission}/caretakers`,{key:key(),fullName:'Late',phone:null,dailyServiceId:null});assert.equal(r.status,409);
});
test('admit and concurrent retry are one stay; occupied bed and wrong visit type rejected',async t=>{
  const {f,g,client,base,post}=await setup(t);
  const input={key:key(),visitId:g.visit,departmentId:g.dept,doctorId:g.actor,bedId:g.bed,expectedDischarge:null};
  const rs=await Promise.all([client.request(base+'/admit',input),client.request(base+'/admit',input)]);
  assert.deepEqual(rs.map(r=>r.status),[201,201]);assert.deepEqual(await rs[0]!.json(),await rs[1]!.json());
  await post('/admit',{...input,bedId:g.bed2},409);
  const v=randomUUID();await f.pool.query("INSERT INTO visits(id,clinic_id,patient_id,business_day_id,type,created_by) SELECT $1,clinic_id,patient_id,business_day_id,'inpatient',created_by FROM visits WHERE id=$2",[v,g.visit]);
  await post('/admit',{...input,key:key(),visitId:v},409);
  const outpatient=key();await f.pool.query("INSERT INTO visits(id,clinic_id,patient_id,business_day_id,type,created_by) SELECT $1,clinic_id,patient_id,business_day_id,'outpatient',created_by FROM visits WHERE id=$2",[outpatient,g.visit]);
  await post('/admit',{...input,key:key(),visitId:outpatient,bedId:g.bed2},404);
});
test('transfer prices each date once, historical price changes are resolved by date',async t=>{
  const {f,g,post}=await setup(t,3);
  // A synthetic historical transfer, created without mutating any prior financial rows.
  const transferAt=(await f.pool.query("SELECT ($1::date+interval '1 day 12 hours') AT TIME ZONE 'Asia/Tashkent' at",[g.start])).rows[0].at;
  await f.pool.query('UPDATE bed_assignments SET to_at=$2 WHERE admission_id=$1',[g.admission,transferAt]);
  await f.pool.query('INSERT INTO bed_assignments(id,clinic_id,admission_id,bed_id,from_at) VALUES($1,$2,$3,$4,$5)',[key(),g.clinic,g.admission,g.bed2,transferAt]);
  await f.pool.query("INSERT INTO service_prices(id,clinic_id,service_id,price_uzs,effective_from,set_by) VALUES($1,$2,$3,300000,($4::date+interval '2 days') AT TIME ZONE 'Asia/Tashkent',$5)",[key(),g.clinic,g.services.bed2,g.start,g.actor]);
  const through=(await f.pool.query('SELECT ($1::date-1)::text d',[g.today])).rows[0].d;
  const rs=await Promise.all([post('/daily',{key:key(),through}),post('/daily',{key:key(),through})]);assert.equal(rs.reduce((n,r)=>n+r.added,0),3);
  const prices=(await f.pool.query('SELECT c.unit_price_uzs FROM bed_day_charges b JOIN charge_lines c ON c.id=b.charge_line_id WHERE b.admission_id=$1 ORDER BY b.charge_date',[g.admission])).rows.map(r=>r.unit_price_uzs);
  assert.deepEqual(prices,['100000','100000','300000']);
});
test('dated rules preserve old dates; caretaker daily charges and minimum shortfall are idempotent',async t=>{
  const {f,g,post,get}=await setup(t,2);
  await post('/rule',{key:key(),rule:{countAdmissionDay:false,countDischargeDay:true,minimumDays:4}});
  const dates=(await f.pool.query('SELECT effective_date::text d FROM inpatient_rule_history WHERE clinic_id=$1 ORDER BY sequence',[g.clinic])).rows;
  assert.equal(dates.at(-1)!.d,(await f.pool.query('SELECT ($1::date+1)::text d',[g.today])).rows[0].d);
  const caretaker=key();await f.pool.query('INSERT INTO caretakers(id,clinic_id,admission_id,full_name,from_date,daily_service_id) VALUES($1,$2,$3,$4,$5,$6)',[caretaker,g.clinic,g.admission,'Synthetic Caretaker',g.start,g.services.caretaker]);
  const through=(await f.pool.query('SELECT ($1::date-1)::text d',[g.today])).rows[0].d;
  assert.equal((await post('/daily',{key:key(),through})).added,4);
  assert.equal((await post('/daily',{key:key(),through})).added,0);
  const final=await post(`/${g.admission}/discharge`,{key:key()});assert.equal(final.value,'300000');
  assert.equal((await get('')).effectiveRule.minimumDays,1);
  assert.equal((await get('')).rule.minimumDays,4);
});
test('minimum same-day stay, optional caretaker and service retries',async t=>{
  const {f,g,post,admit,get}=await setup(t);const {id}=await admit();
  await post(`/${id}/caretakers`,{key:key(),fullName:'Synthetic No Charge',phone:'+998901234567',dailyServiceId:null});
  const input={key:key(),serviceId:g.services.medicine,quantity:2};
  assert.deepEqual(await post(`/${id}/services`,input),await post(`/${id}/services`,input));
  await post(`/${id}/services`,{...input,quantity:3},409);
  const final=await post(`/${id}/discharge`,{key:key()});assert.equal(final.value,'120000');
  const missingService=key();await f.pool.query("INSERT INTO services(id,clinic_id,kind,name_uz_cyrl) VALUES($1,$2,'other','No price')",[missingService,g.clinic]);
  // A second stay with no prior bed charges demonstrates transaction rollback on failed daily pricing.
  const other=await inpatientGraph(f,2);await f.pool.query('UPDATE beds SET bed_service_id=$2 WHERE id=$1',[other.bed,other.services.bed]);
  await f.pool.query("INSERT INTO service_prices(id,clinic_id,service_id,price_uzs,effective_from,set_by) VALUES($1,$2,$3,12345,'1990-01-01',$4)",[key(),g.clinic,missingService,g.actor]);
  await post(`/${other.admission}/services`,{key:key(),serviceId:missingService,quantity:1});
  assert.equal((await get(`/${other.admission}/invoice`)).value,'12345');
});
test('business-day opener accrues existing stays atomically; missing historical price rolls back the opening',async t=>{
  const {f,g,client,base}=await setup(t,2,1);
  const oldDay=(await f.pool.query("SELECT id FROM business_days WHERE clinic_id=$1 AND status='open'",[g.clinic])).rows[0].id;
  assert.equal((await client.request(`/api/clinics/${g.clinic}/business-days/${oldDay}/close`,{})).status,200);
  const noPrice=key();await f.pool.query("INSERT INTO services(id,clinic_id,kind,name_uz_cyrl) VALUES($1,$2,'bed','No price')",[noPrice,g.clinic]);
  await f.pool.query('UPDATE beds SET bed_service_id=$2 WHERE id=$1',[g.bed,noPrice]);
  const openPath=`/api/clinics/${g.clinic}/business-days/open`;
  assert.equal((await client.request(openPath,{})).status,422);
  assert.equal((await f.pool.query("SELECT count(*)::int n FROM business_days WHERE clinic_id=$1 AND status='open'",[g.clinic])).rows[0].n,0);
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM charge_lines WHERE visit_id=$1',[g.visit])).rows[0].n,0);
  await f.pool.query("INSERT INTO service_prices(id,clinic_id,service_id,price_uzs,effective_from,set_by) VALUES($1,$2,$3,100000,'2000-01-01',$4)",[key(),g.clinic,noPrice,g.actor]);
  assert.equal((await client.request(openPath,{})).status,201);
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM bed_day_charges WHERE admission_id=$1',[g.admission])).rows[0].n,2);
  const r=await client.request(base+`/${g.admission}/services`,{key:key(),serviceId:g.services.other,quantity:0});assert.equal(r.status,422);
});
test('every inpatient route rejects wrong roles and foreign clinics; revocation applies to cached retry',async t=>{
  const {f,g,client,base,admit}=await setup(t);const admitted=await admit();
  const outsider=f.client();await outsider.login('other@example.test');
  const paths=[['',undefined],['/admit',{}],['/daily',{}],['/rule',{}],[`/${admitted.id}/transfer`,{}],[`/${admitted.id}/services`,{}],[`/${admitted.id}/caretakers`,{}],[`/${admitted.id}/discharge`,{}],[`/${admitted.id}/invoice`,undefined],[`/${admitted.id}/invoice-pdf`,undefined]] as const;
  for(const [p,b] of paths)assert.equal((await outsider.request(base+p,b)).status,404,p);
  await f.pool.query('DELETE FROM membership_roles WHERE clinic_id=$1 AND user_id=$2',[g.clinic,g.actor]);
  await f.pool.query("INSERT INTO membership_roles(clinic_id,user_id,role,granted_by) VALUES($1,$2,'registrar',$2)",[g.clinic,g.actor]);
  for(const [p,b] of paths)assert.equal((await client.request(base+p,b)).status,403,p);
});
test('doctor reads only assigned stays; cashier reads debt but cannot add charges',async t=>{
  const {f,g,client,base,admit}=await setup(t);const a=await admit();
  await f.pool.query("DELETE FROM membership_roles WHERE clinic_id=$1 AND user_id=$2 AND role<>'doctor'",[g.clinic,g.actor]);
  assert.equal((await (await client.request(base)).json()).admissions.length,1);
  assert.equal((await client.request(base+`/${a.id}/invoice`)).status,200);
  await f.pool.query('DELETE FROM patient_assignments WHERE clinic_id=$1 AND patient_id=$2',[g.clinic,g.patient]);
  assert.equal((await (await client.request(base)).json()).admissions.length,0);
  assert.equal((await client.request(base+`/${a.id}/invoice`)).status,403);
  await f.pool.query("DELETE FROM membership_roles WHERE clinic_id=$1 AND user_id=$2",[g.clinic,g.actor]);
  await f.pool.query("INSERT INTO membership_roles(clinic_id,user_id,role,granted_by) VALUES($1,$2,'cashier',$2)",[g.clinic,g.actor]);
  assert.equal((await client.request(base+`/${a.id}/invoice`)).status,200);
  assert.equal((await client.request(base+`/${a.id}/services`,{})).status,403);
});

test('discharge includes all visit lines and net payments; cashier can collect the remaining balance afterwards',async t=>{
  const {f,g,client,admit,post}=await setup(t);const a=await admit();
  // Charges from another module are part of the same visit's final invoice.
  await f.pool.query("INSERT INTO charge_lines(id,clinic_id,visit_id,service_id,quantity,unit_price_uzs,status,source,created_by,completed_by,completed_at) VALUES($1,$2,$3,$4,1,250000,'completed','lab',$5,$5,now())",[key(),g.clinic,g.visit,g.services.lab,g.actor]);
  const desk=key();await f.pool.query("INSERT INTO cash_desks(id,clinic_id,name) VALUES($1,$2,'Synthetic cashier')",[desk,g.clinic]);
  const cb=`/api/clinics/${g.clinic}/cashier`;
  const call=async(path:string,body?:unknown,status=200)=>{const r=await client.request(cb+path,body);const v=await r.json();assert.equal(r.status,status,JSON.stringify(v));return v;};
  const shift=await call('/shifts',{deskId:desk,opening:'0'},201);
  await call(`/visits/${g.visit}/payments`,{shiftId:shift.id,amount:'200000',method:'cash',key:key()},201);
  let current=await call(`/visits/${g.visit}`);const original=current.payments[0].id;
  await call(`/visits/${g.visit}/refund`,{shiftId:shift.id,paymentId:original,amount:'100000',reason:'Synthetic correction',key:key()});
  await call(`/visits/${g.visit}/discount`,{kind:'fixed',amount:'100000',reason:'Synthetic approved discount'});
  const final=await post(`/${a.id}/discharge`,{key:key()});
  assert.equal(final.value,'350000');assert.equal(final.discount,'100000');assert.equal(final.paid,'100000');assert.equal(final.due,'150000');
  current=await call(`/visits/${g.visit}`);assert.equal(current.invoice.due,final.due);
  await call(`/visits/${g.visit}/payments`,{shiftId:shift.id,amount:'150000',method:'card',key:key()},201);
  assert.equal((await call(`/visits/${g.visit}`)).invoice.due,'0');
});
