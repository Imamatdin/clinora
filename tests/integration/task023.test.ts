import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { httpFixture } from './fixture.js';
import { seedCashier } from './cashier-fixture.js';
import { inpatientGraph } from '../helpers/inpatient.js';
import { transaction } from '../../src/server/database.js';
import { setOwnPin } from '../../src/modules/devices/actions.js';

// Task 023 regression tests: each fails on main at 06c963f.
const id=()=>randomUUID();
const addDays=(date:string,n:number)=>new Date(Date.parse(date)+n*86400000).toISOString().slice(0,10);
async function setup(t:test.TestContext){
  const f=await httpFixture();t.after(()=>f.close());const client=f.client();await client.login();
  const base=`/api/clinics/${f.owner.clinicId}`;
  const call=async(path:string,body?:unknown,status=200,c=client)=>{const r=await c.request(base+path,body),v=await r.json();assert.equal(r.status,status,`${path}: ${JSON.stringify(v)}`);return v;};
  /** The second synthetic account joins this clinic with exactly these roles. */
  const other=async(roles:string[])=>{
    await f.pool.query("INSERT INTO memberships(id,clinic_id,user_id,status,granted_by) VALUES($1,$2,$3,'active',$4) ON CONFLICT DO NOTHING",[id(),f.owner.clinicId,f.other.userId,f.owner.userId]);
    await f.pool.query('DELETE FROM membership_roles WHERE clinic_id=$1 AND user_id=$2',[f.owner.clinicId,f.other.userId]);
    for(const role of roles)await f.pool.query('INSERT INTO membership_roles(clinic_id,user_id,role,granted_by) VALUES($1,$2,$3,$4)',[f.owner.clinicId,f.other.userId,role,f.owner.userId]);
    const c=f.client();await c.login('other@example.test');return c;
  };
  return {f,client,base,call,other};
}
const unpricedService=async(f:any,kind:string)=>{const s=id();await f.pool.query('INSERT INTO services(id,clinic_id,kind,name_uz_cyrl) VALUES($1,$2,$3,$4)',[s,f.owner.clinicId,kind,`Нархсиз ${kind}`]);return s;};

test('023-1: unpriced caretaker or bed is refused up front; an unpriced stay day is flagged at discharge instead of failing',async t=>{
  const {f,call}=await setup(t);
  // Up front: admit today, then a caretaker fee and a transfer bed without a price are refused.
  const g=await inpatientGraph(f);
  const stay=await call('/inpatient/admit',{key:id(),visitId:g.visit,departmentId:g.dept,doctorId:g.actor,bedId:g.bed,expectedDischarge:null},201);
  const fee=await unpricedService(f,'caretaker'),bedService=await unpricedService(f,'bed'),bed=id();
  await f.pool.query("INSERT INTO beds(id,clinic_id,room_id,label,bed_service_id) VALUES($1,$2,$3,'3',$4)",[bed,g.clinic,g.room,bedService]);
  await call(`/inpatient/${stay.id}/caretakers`,{key:id(),fullName:'Синтетик Қаровчи',phone:null,dailyServiceId:fee},422);
  await call(`/inpatient/${stay.id}/transfer`,{key:id(),bedId:bed},422);
  // A legacy caretaker with an unpriced fee (from before the check) no longer makes discharge fail.
  const old=await inpatientGraph(f,2);
  await f.pool.query('INSERT INTO caretakers(id,clinic_id,admission_id,full_name,from_date,daily_service_id) VALUES($1,$2,$3,$4,$5,$6)',[id(),g.clinic,old.admission,'Синтетик Қаровчи',old.start,fee]);
  const invoice=await call(`/inpatient/${old.admission}/discharge`,{key:id()});
  assert.deepEqual(invoice.needsAttention.map((a:any)=>[a.kind,a.date]),[['caretaker',old.start],['caretaker',addDays(old.start,1)]]);
  assert.equal((await call('/inpatient')).attention.length,2);
  // Nothing is charged on a discharged stay (database rule); the flag stays visible until the administrator settles it.
  await call('/catalog/prices',{serviceId:fee,priceUzs:'30000',effectiveFrom:'2000-01-01T00:00:00Z',idempotencyKey:id()},201);
  await call('/inpatient/daily',{key:id(),through:addDays(g.today,-1)});
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM caretaker_day_charges')).rows[0].n,0);
  assert.equal((await call('/inpatient')).attention.length,2);
});

test('023-2: a technician never becomes a payroll performer; migration moves lab lines to the ordering doctor or none',async t=>{
  const {f,call,other}=await setup(t),g=await seedCashier(f.pool,f.owner.clinicId,f.owner.userId);
  await other(['laboratory']);const tech=f.other.userId,c=f.owner.clinicId,u=f.owner.userId;
  const lab=id();await f.pool.query("INSERT INTO services(id,clinic_id,kind,name_uz_cyrl) VALUES($1,$2,'lab','Синтетик таҳлил')",[lab,c]);
  // Legacy shape (task 017 lab confirm): performer = the confirming technician.
  const fromDoctor=id(),fromDesk=id();
  for(const [line,source] of [[fromDoctor,'doctor'],[fromDesk,'registration']] as const)
    await f.pool.query(`INSERT INTO charge_lines(id,clinic_id,visit_id,service_id,quantity,unit_price_uzs,source,created_by,status,completed_by,completed_at,performer_user_id)
      VALUES($1,$2,$3,$4,1,40000,$5,$6,'completed',$7,now(),$7)`,[line,c,g.visit,lab,source,u,tech]);
  const date=(await f.pool.query('SELECT business_date FROM business_days WHERE id=$1',[g.day])).rows[0].business_date,p={from:date,to:date};
  assert.ok(!(await call('/payroll/earnings',p)).lines.some((l:any)=>l.user_id===tech),'technician is not listed (was rule_missing)');
  assert.ok(!(await call('/reports/dashboard',p)).doctors.some((d:any)=>d.id===tech),'technician is not a doctor in the report');
  const sql=readFileSync('db/migrations/025_money_operations.sql','utf8');
  await f.pool.query(sql.slice(sql.indexOf('-- 2.'),sql.indexOf('-- 3.')));
  const rows=Object.fromEntries((await f.pool.query('SELECT id,performer_user_id,completed_by FROM charge_lines WHERE id=ANY($1)',[[fromDoctor,fromDesk]])).rows.map(r=>[r.id,r]));
  assert.equal(rows[fromDoctor].performer_user_id,u);assert.equal(rows[fromDesk].performer_user_id,null);assert.equal(rows[fromDesk].completed_by,tech);
  // Whether the doctor earns on lab lines is their rule's categories: consultation only -> nothing on lab.
  await call(`/business-days/${g.day}/close`,{});
  await call('/payroll/rules',{userId:u,shareBp:5000,basis:'billed',discountBearer:'clinic',categories:['consultation'],effectiveFrom:date},201);
  const final=await call('/payroll/finalize',p);
  assert.deepEqual(final.lines,[]);
});

test('023-3: only performed lines earn; unpaid ordered lines can be cancelled by desk or ordering doctor; no-show at day close',async t=>{
  const {f,client,call,other}=await setup(t),g=await seedCashier(f.pool,f.owner.clinicId,f.owner.userId),c=f.owner.clinicId,u=f.owner.userId;
  const date=(await f.pool.query('SELECT business_date FROM business_days WHERE id=$1',[g.day])).rows[0].business_date,p={from:date,to:date};
  await f.pool.query('UPDATE charge_lines SET performer_user_id=$2 WHERE id=$1',[g.line,u]);
  await call('/payroll/rules',{userId:u,shareBp:5000,basis:'billed',discountBearer:'clinic',categories:['consultation'],effectiveFrom:date},201);
  assert.ok((await call('/payroll/earnings',p)).lines.every((l:any)=>l.entitlement_uzs==='0'),'an ordered line earns nothing');
  const line=async(price:number,by=u)=>{const l=id();await f.pool.query(`INSERT INTO charge_lines(id,clinic_id,visit_id,service_id,quantity,unit_price_uzs,source,created_by) VALUES($1,$2,$3,$4,1,$5,'doctor',$6)`,[l,c,g.visit,g.service,price,by]);return l;};
  // Desk: registrar cancels with a reason; the line leaves the bill and the debt.
  const desk=await other(['registrar']);
  await call(`/charges/${g.line}/cancel`,{idempotencyKey:id(),reason:''},422,desk);
  await call(`/charges/${g.line}/cancel`,{idempotencyKey:id(),reason:'Бемор кетди'},200,desk);
  let bill=await call(`/cashier/visits/${g.visit}`);
  assert.equal(bill.invoice.value,'0');assert.equal(bill.invoice.due,'0');
  assert.equal((await call('/reports/dashboard',p)).totals.outstanding,'0');
  // Receipts on a visit discount move to the remaining lines; a paid line is refused.
  const [a,b,x]=[await line(100000),await line(100000),await line(100000)];
  await call(`/cashier/visits/${g.visit}/discount`,{kind:'fixed',amount:'60000',reason:'Синтетик чегирма'});
  const shift=await call('/cashier/shifts',{deskId:g.desk,opening:'0'},201);
  await call(`/cashier/visits/${g.visit}/payments`,{shiftId:shift.id,amount:'80000',method:'cash',key:id()},201);
  await call(`/charges/${a}/cancel`,{idempotencyKey:id(),reason:'Тўланган'},409);
  await call(`/charges/${x}/cancel`,{idempotencyKey:id(),reason:'Керак эмас'});
  bill=await call(`/cashier/visits/${g.visit}`);
  assert.equal(bill.invoice.payable,'140000');assert.equal(bill.invoice.paid,'80000');
  assert.deepEqual(bill.invoice.lines.filter((l:any)=>[a,b].includes(l.id)).map((l:any)=>l.allocatedPaid),['70000','10000']);
  // Doctor: only lines they ordered (another doctor's line reads as missing).
  const doctor=await other(['doctor']);const own=await line(5000,f.other.userId);
  await call(`/charges/${b}/cancel`,{idempotencyKey:id(),reason:'Бошқа шифокор'},404,doctor);
  await call(`/charges/${own}/cancel`,{idempotencyKey:id(),reason:'Хато буюртма'},200,doctor);
  // No-show at day close: a visit with only ordered lines is listed and cancelled; one with a completed line is not.
  const visit=id(),noShowLine=id(),done=id();
  await f.pool.query("INSERT INTO visits(id,clinic_id,patient_id,business_day_id,type,created_by) VALUES($1,$2,$3,$4,'outpatient',$5)",[visit,c,g.patient,g.day,u]);
  await f.pool.query(`INSERT INTO charge_lines(id,clinic_id,visit_id,service_id,quantity,unit_price_uzs,source,created_by,performer_user_id) VALUES($1,$2,$3,$4,1,70000,'registration',$5,$5)`,[noShowLine,c,visit,g.service,u]);
  const candidates=await call(`/business-days/${g.day}/no-show`);
  assert.deepEqual(candidates.map((v:any)=>v.visitId),[visit]);
  const performed=id();await f.pool.query("INSERT INTO visits(id,clinic_id,patient_id,business_day_id,type,created_by) VALUES($1,$2,$3,$4,'outpatient',$5)",[performed,c,g.patient,g.day,u]);
  await f.pool.query(`INSERT INTO charge_lines(id,clinic_id,visit_id,service_id,quantity,unit_price_uzs,source,created_by,status,completed_by,completed_at) VALUES($1,$2,$3,$4,1,1,'registration',$5,'completed',$5,now())`,[done,c,performed,g.service,u]);
  await call(`/business-days/${g.day}/no-show`,{idempotencyKey:id(),visitIds:[performed]},409);
  assert.deepEqual(await call(`/business-days/${g.day}/no-show`,{idempotencyKey:id(),visitIds:[visit]}),{visits:1,linesCancelled:1});
  assert.equal((await f.pool.query('SELECT status FROM visits WHERE id=$1',[visit])).rows[0].status,'cancelled');
  assert.equal((await f.pool.query('SELECT status FROM charge_lines WHERE id=$1',[noShowLine])).rows[0].status,'cancelled');
  await call(`/business-days/${g.day}/no-show`,{idempotencyKey:id(),visitIds:[visit]},409);
});

test('023-4: cash-outs need manager approval above the threshold, record one row per press and appear on the shift close report',async t=>{
  const {f,call,other}=await setup(t),g=await seedCashier(f.pool,f.owner.clinicId,f.owner.userId);
  await transaction(f.pool,tx=>setOwnPin(tx,f.owner.userId,'482615'));
  const cashier=await other(['cashier']),desk=id();
  await f.pool.query("INSERT INTO cash_desks(id,clinic_id,name) VALUES($1,$2,'Synthetic Desk 2')",[desk,f.owner.clinicId]);
  const shift=await call('/cashier/shifts',{deskId:desk,opening:'500000'},201,cashier);
  const out={expenseId:g.expense,amount:'20000',note:'Синтетик харажат'};
  await call(`/cashier/shifts/${shift.id}/cash-out`,{...out},422,cashier); // No press key.
  await call(`/cashier/shifts/${shift.id}/cash-out`,{...out,key:id()},403,cashier); // Default threshold 0: approval needed.
  const approval=await call('/cashier/approvals',{approverId:f.owner.userId,pin:'482615',shiftId:shift.id,operation:'cash_out',payload:out},200,cashier);
  const press={...out,key:id(),approvalId:approval.approvalId};
  const rows=await Promise.all([1,2].map(()=>call(`/cashier/shifts/${shift.id}/cash-out`,press,201,cashier)));
  assert.equal(rows[0].id,rows[1].id);assert.equal(rows[0].approved_by,f.owner.userId);
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM cash_outs WHERE cash_shift_id=$1',[shift.id])).rows[0].n,1);
  await call(`/cashier/shifts/${shift.id}/cash-out`,{...out,key:id(),approvalId:approval.approvalId},403,cashier); // Single-use approval.
  await f.pool.query('UPDATE clinic_settings SET cash_out_approval_threshold_uzs=50000 WHERE clinic_id=$1',[f.owner.clinicId]);
  await call(`/cashier/shifts/${shift.id}/cash-out`,{...out,amount:'1000',key:id()},201,cashier);
  const report=await call(`/cashier/shifts/${shift.id}/close`,{counted:'479000'},200,cashier);
  assert.deepEqual(report.cashOutList.map((o:any)=>[o.amount,o.approvedBy]),[['20000','Synthetic Owner'],['1000',null]]);
  assert.equal(report.expected,'479000');
});

test('023-5: the CEO can reopen today\'s closed day with a reason; the old snapshot is kept and the next close writes a new one',async t=>{
  const {f,call,other}=await setup(t),g=await seedCashier(f.pool,f.owner.clinicId,f.owner.userId);
  await call(`/business-days/${g.day}/close`,{});
  const admin=await other(['administrator']);
  await call(`/business-days/${g.day}/reopen`,{reason:'Хато ёпилди'},403,admin);
  await call(`/business-days/${g.day}/reopen`,{reason:''},422);
  assert.equal((await call(`/business-days/${g.day}/reopen`,{reason:'Хато ёпилди'})).status,'open');
  const versions=(await f.pool.query('SELECT version,close_snapshot,reopen_reason FROM business_day_close_versions WHERE business_day_id=$1',[g.day])).rows;
  assert.equal(versions.length,1);assert.equal(versions[0].reopen_reason,'Хато ёпилди');assert.ok(versions[0].close_snapshot.totals);
  const shift=await call('/cashier/shifts',{deskId:g.desk,opening:'0'},201);
  await call(`/cashier/visits/${g.visit}/payments`,{shiftId:shift.id,amount:'1000',method:'cash',key:id()},201);
  await call(`/cashier/shifts/${shift.id}/close`,{counted:'1000'});
  await call(`/business-days/${g.day}/close`,{});
  const day=(await f.pool.query('SELECT status,close_snapshot FROM business_days WHERE id=$1',[g.day])).rows[0];
  assert.equal(day.status,'closed');assert.equal(day.close_snapshot.totals.collected,'1000');assert.equal(versions[0].close_snapshot.totals.collected,'0');
  assert.equal((await f.pool.query('SELECT completed_at FROM report_notices WHERE business_day_id=$1',[g.day])).rows[0].completed_at,null);
  // Without the audited path a closed day stays immutable; a later day blocks reopening.
  await assert.rejects(f.pool.query("UPDATE business_days SET status='open',closed_by=NULL,closed_at=NULL,close_snapshot=NULL WHERE id=$1",[g.day]),/immutable/);
  const date=(await f.pool.query('SELECT business_date FROM business_days WHERE id=$1',[g.day])).rows[0].business_date;
  await f.pool.query("INSERT INTO business_days(id,clinic_id,business_date,status,opened_by) VALUES($1,$2,$3,'open',$4)",[id(),f.owner.clinicId,addDays(date,1),f.owner.userId]);
  await call(`/business-days/${g.day}/reopen`,{reason:'Яна'},409);
});

test('023-6: day close charges the closing date\'s bed days before the snapshot, so the stored report matches the dashboard',async t=>{
  const {f,call}=await setup(t),g=await inpatientGraph(f,1);
  const day=(await f.pool.query("SELECT id FROM business_days WHERE clinic_id=$1 AND status='open'",[g.clinic])).rows[0].id;
  await call(`/business-days/${day}/close`,{});
  const dates=(await f.pool.query('SELECT charge_date::text d FROM bed_day_charges WHERE admission_id=$1 ORDER BY 1',[g.admission])).rows.map(r=>r.d);
  assert.deepEqual(dates,[g.start,g.today]);
  const stored=await call(`/reports/days/${day}`),live=await call('/reports/dashboard',{from:g.today,to:g.today});
  assert.equal(stored.snapshot,true);assert.equal(stored.totals.value,'100000');assert.equal(live.totals.value,stored.totals.value);
});

test('023-7: surgery outside the business day needs a CEO/administrator reason; payroll periods are contiguous; cashier day report is own shifts only',async t=>{
  const {f,call,other}=await setup(t),g=await seedCashier(f.pool,f.owner.clinicId,f.owner.userId),c=f.owner.clinicId,u=f.owner.userId;
  const op=id();await f.pool.query("INSERT INTO services(id,clinic_id,kind,name_uz_cyrl) VALUES($1,$2,'surgery','Синтетик операция')",[op,c]);
  await f.pool.query("INSERT INTO service_prices(id,clinic_id,service_id,price_uzs,effective_from,set_by) VALUES($1,$2,$3,500000,'2000-01-01',$4)",[id(),c,op,u]);
  const doctor=await other(['doctor']);
  await f.pool.query('INSERT INTO patient_assignments(clinic_id,patient_id,user_id) VALUES($1,$2,$3)',[c,g.patient,f.other.userId]);
  for(const user of [u,f.other.userId])await f.pool.query("INSERT INTO doctor_profiles(clinic_id,user_id,specialty_uz_cyrl) VALUES($1,$2,'Жарроҳ') ON CONFLICT DO NOTHING",[c,user]);
  const date=(await f.pool.query('SELECT business_date FROM business_days WHERE id=$1',[g.day])).rows[0].business_date;
  const yesterday=new Date(Date.parse(`${addDays(date,-1)}T12:00:00+05:00`)).toISOString();
  const surgery=(over:object)=>({idempotencyKey:id(),visitId:g.visit,serviceId:op,surgeonId:f.other.userId,performedAt:yesterday,...over});
  await call('/surgery',surgery({}),422,doctor);
  await call('/surgery',surgery({backdateReason:'Кечикиб киритилди'}),403,doctor);
  await call('/surgery',surgery({performedAt:new Date().toISOString()}),201,doctor);
  await call('/surgery',surgery({backdateReason:'Кечикиб киритилди'}),201);
  // Cashier day report: own shifts' totals only (another cashier's payment is not included).
  const cashier=await other(['cashier']),desk=id();
  await f.pool.query("INSERT INTO cash_desks(id,clinic_id,name) VALUES($1,$2,'Synthetic Desk 2')",[desk,c]);
  const mine=await call('/cashier/shifts',{deskId:desk,opening:'0'},201,cashier),theirs=await call('/cashier/shifts',{deskId:g.desk,opening:'0'},201);
  await call(`/cashier/visits/${g.visit}/payments`,{shiftId:mine.id,amount:'3000',method:'cash',key:id()},201,cashier);
  await call(`/cashier/visits/${g.visit}/payments`,{shiftId:theirs.id,amount:'7000',method:'cash',key:id()},201);
  assert.deepEqual((await call(`/reports/days/${g.day}`,undefined,200,cashier)).totals,{collected:'3000'});
  // Payroll: a final period must start the day after the latest final period.
  await call(`/cashier/shifts/${mine.id}/close`,{counted:'3000'},200,cashier);await call(`/cashier/shifts/${theirs.id}/close`,{counted:'7000'});
  await call(`/business-days/${g.day}/close`,{});
  await f.pool.query("INSERT INTO payroll_periods(id,clinic_id,from_date,to_date,status,finalized_by,finalized_at) VALUES($1,$2,$3,$4,'final',$5,now())",[id(),c,addDays(date,-20),addDays(date,-10),u]);
  await call('/payroll/finalize',{from:date,to:date},422);
  await call('/payroll/finalize',{from:addDays(date,-9),to:date});
});
