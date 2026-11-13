import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { httpFixture } from './fixture.js';
import { seedCashier } from './cashier-fixture.js';
import { inpatientGraph } from '../helpers/inpatient.js';
import { transaction } from '../../src/server/database.js';
import { requireRole } from '../../src/server/roles.js';
import { closeDay } from '../../src/modules/business-days/actions.js';
import { records,invoiceAt } from '../../src/modules/reports/records.js';
import { dispatchReports } from '../../src/modules/reports/notify.js';
import { setOwnPin } from '../../src/modules/devices/actions.js';
import { digest } from '../../src/server/security.js';

const id=()=>randomUUID();
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function setup(t:test.TestContext){
  const f=await httpFixture();t.after(()=>f.close());const client=f.client();await client.login();
  const base=`/api/clinics/${f.owner.clinicId}`;
  const call=async(path:string,body?:unknown,status=200)=>{const r=await client.request(base+path,body),v=await r.json();assert.equal(r.status,status,JSON.stringify(v));return v;};
  return {f,client,base,call};
}
test('021: three inpatient days and caretaker dates reconcile even with real creation timestamps',async t=>{
  const {f,call}=await setup(t),g=await inpatientGraph(f,3);
  await f.pool.query('INSERT INTO caretakers(id,clinic_id,admission_id,full_name,from_date,daily_service_id) VALUES($1,$2,$3,$4,$5,$6)',[id(),g.clinic,g.admission,'Synthetic Caretaker',g.start,g.services.caretaker]);
  const through=new Date(Date.parse(g.today)-86400000).toISOString().slice(0,10);
  const dates=[0,1,2].map(i=>new Date(Date.parse(g.start)+i*86400000).toISOString().slice(0,10));
  const caretaker=(await f.pool.query('SELECT id FROM caretakers WHERE admission_id=$1',[g.admission])).rows[0].id;
  for(const date of dates)for(const kind of ['bed','caretaker'] as const){
    const line=id();await f.pool.query(`INSERT INTO charge_lines(id,clinic_id,visit_id,service_id,quantity,unit_price_uzs,source,created_by) VALUES($1,$2,$3,$4,1,$5,'inpatient',$6)`,[line,g.clinic,g.visit,g.services[kind],kind==='bed'?'100000':'50000',g.actor]);
    await f.pool.query(kind==='bed'?'INSERT INTO bed_day_charges(clinic_id,admission_id,charge_date,charge_line_id) VALUES($1,$2,$3,$4)':'INSERT INTO caretaker_day_charges(clinic_id,caretaker_id,charge_date,charge_line_id) VALUES($1,$2,$3,$4)',[g.clinic,kind==='bed'?g.admission:caretaker,date,line]);
  }
  const daily=[];for(const date of dates)daily.push(await call('/reports/dashboard',{from:date,to:date}));
  assert.deepEqual(daily.map(r=>r.totals.value),['150000','150000','150000']);
  const range=await call('/reports/dashboard',{from:g.start,to:through});
  assert.equal(range.totals.value,daily.reduce((n,r)=>n+BigInt(r.totals.value),0n).toString());
  assert.equal((await call('/reports/dashboard',{from:g.today,to:g.today})).totals.outstanding,'450000');
  await call(`/business-days/${(await f.pool.query("SELECT id FROM business_days WHERE clinic_id=$1 AND status='open'",[g.clinic])).rows[0].id}/close`,{});
});
test('021: bounded ledger excludes history outside the period; own doctor records exclude another doctor',async t=>{
  const {f,call}=await setup(t),g=await seedCashier(f.pool,f.owner.clinicId,f.owner.userId);
  const date=(await f.pool.query('SELECT business_date FROM business_days WHERE id=$1',[g.day])).rows[0].business_date;
  await f.pool.query('UPDATE charge_lines SET performer_user_id=$2 WHERE id=$1',[g.line,f.owner.userId]);
  const foreign=id();await f.pool.query(`INSERT INTO charge_lines(id,clinic_id,visit_id,service_id,quantity,unit_price_uzs,source,created_by) VALUES($1,$2,$3,$4,1,123,'registration',$5)`,[foreign,f.owner.clinicId,g.visit,g.service,f.owner.userId]);
  await transaction(f.pool,async tx=>{
    const c=await requireRole(tx,f.owner.userId,f.owner.clinicId,['ceo']);
    const empty=await records(c,{from:'2000-01-01',to:'2000-01-02'});assert.deepEqual(empty.visits,[]);assert.deepEqual(empty.charges,[]);
    const own=await records(c,{from:date,to:date},{doctor:f.owner.userId});
    assert.deepEqual(own.charges.map(l=>l.id),[g.line]);
  });
  await call(`/business-days/${g.day}/close`,{});
  const next=id(),tomorrow=new Date(Date.parse(date)+86400000).toISOString().slice(0,10);
  await f.pool.query("INSERT INTO business_days(id,clinic_id,business_date,status,opened_by) VALUES($1,$2,$3,'open',$4)",[next,f.owner.clinicId,tomorrow,f.owner.userId]);
  // A non-bed charge on an old visit belongs to the open business day, even if timestamps differ.
  const later=id();await f.pool.query(`INSERT INTO charge_lines(id,clinic_id,visit_id,service_id,quantity,unit_price_uzs,source,created_by,created_at) VALUES($1,$2,$3,$4,1,77,'registration',$5,now())`,[later,f.owner.clinicId,g.visit,g.service,f.owner.userId]);
  const report=await call('/reports/dashboard',{from:tomorrow,to:tomorrow});assert.equal(report.totals.value,'77');assert.equal(report.totals.outstanding,'1000200');
});
test('021: missing payroll rules are visible, finalize names doctors, future corrections are audited',async t=>{
  const {f,call}=await setup(t),g=await seedCashier(f.pool,f.owner.clinicId,f.owner.userId);
  await f.pool.query('UPDATE charge_lines SET performer_user_id=$2 WHERE id=$1',[g.line,f.owner.userId]);
  const date=(await f.pool.query('SELECT business_date FROM business_days WHERE id=$1',[g.day])).rows[0].business_date,p={from:date,to:date};
  const draft=await call('/payroll/earnings',p);assert.equal(draft.lines[0].status,'rule_missing');assert.equal(draft.lines[0].charge_line_id,g.line);
  await call(`/business-days/${g.day}/close`,{});
  const rejected=await call('/payroll/finalize',p,409);assert.deepEqual(rejected.error.doctors,['Synthetic Owner']);
  const rule={userId:f.owner.userId,shareBp:5000,basis:'billed',discountBearer:'proportional',categories:['consultation'],effectiveFrom:date};
  await call('/payroll/rules',rule,201);await call('/payroll/rules',{...rule,shareBp:9000},409);
  const tomorrow=new Date(Date.parse(date)+86400000).toISOString().slice(0,10);
  const first=await call('/payroll/rules',{...rule,effectiveFrom:tomorrow},201),second=await call('/payroll/rules',{...rule,effectiveFrom:tomorrow,shareBp:8000},201);
  assert.equal(first.id,second.id);assert.equal(second.doctor_share_bp,8000);
  const audit=(await f.pool.query("SELECT detail FROM audit_events WHERE clinic_id=$1 AND action='payroll.rule_corrected'",[f.owner.clinicId])).rows[0].detail;
  assert.equal(audit.before.doctor_share_bp,5000);assert.equal(audit.after.doctor_share_bp,8000);
  assert.equal((await call('/payroll/finalize',p)).lines[0].entitlement_uzs,'500000');
});
test('021/022: approval failures count once per approver across devices; a manager clears the lock; void records the approver',async t=>{
  const {f,client,base,call}=await setup(t),g=await seedCashier(f.pool,f.owner.clinicId,f.owner.userId);
  await f.pool.query("INSERT INTO memberships(id,clinic_id,user_id,status,granted_by) VALUES($1,$2,$3,'active',$4)",[id(),f.owner.clinicId,f.other.userId,f.owner.userId]);
  await f.pool.query("INSERT INTO membership_roles(clinic_id,user_id,role,granted_by) VALUES($1,$2,'administrator',$3)",[f.owner.clinicId,f.other.userId,f.owner.userId]);
  await transaction(f.pool,tx=>setOwnPin(tx,f.other.userId,'482613'));
  await call(`/cashier/visits/${g.visit}/discount`,{kind:'fixed',amount:'10',reason:'Synthetic waiver'});
  const discount=(await f.pool.query('SELECT id FROM discounts WHERE clinic_id=$1',[f.owner.clinicId])).rows[0].id;
  await f.pool.query("DELETE FROM membership_roles WHERE clinic_id=$1 AND user_id=$2 AND role<>'cashier'",[f.owner.clinicId,f.owner.userId]);
  await f.pool.query("INSERT INTO membership_roles(clinic_id,user_id,role,granted_by) VALUES($1,$2,'cashier',$2) ON CONFLICT DO NOTHING",[f.owner.clinicId,f.owner.userId]);
  const device1=id(),device2=id();
  for(const device of [device1,device2])await f.pool.query('INSERT INTO devices(id,clinic_id,label,token_hash,created_by) VALUES($1,$2,$3,$4,$5)',[device,f.owner.clinicId,'Synthetic device',digest(digest(device)),f.owner.userId]);
  const bind=async(cookie:string,device:string)=>f.pool.query("UPDATE sessions SET via='device',device_id=$2 WHERE token_hash=$1",[digest(decodeURIComponent(cookie.split('=')[1]!)),device]);
  await bind(client.cookie,device1);
  const firstDevice={Cookie:client.cookie+`; clinora_device=${digest(device1)}`};
  const deviceCall=async(input:unknown,status:number)=>{const r=await client.request(base+'/cashier/approvals',input,firstDevice);assert.equal(r.status,status,await r.text());};
  const input={approverId:f.other.userId,pin:'482613',visitId:g.visit,operation:'void',payload:{discountId:discount,reason:'Synthetic void'}};
  for(let n=0;n<5;n++)await deviceCall({...input,pin:'111111'},403);
  // The sign-in PIN counter is untouched; the one approver counter is locked.
  assert.deepEqual((await f.pool.query('SELECT failed_attempts,locked_at FROM account_pins WHERE account_id=$1',[f.other.userId])).rows[0],{failed_attempts:0,locked_at:null});
  assert.equal((await f.pool.query('SELECT failed_attempts FROM approval_pin_attempts WHERE account_id=$1',[f.other.userId])).rows[0].failed_attempts,5);
  await deviceCall(input,403);
  const otherClient=f.client();await otherClient.login();await bind(otherClient.cookie,device2);
  const secondDevice={Cookie:otherClient.cookie+`; clinora_device=${digest(device2)}`};
  // Task 022: the lock follows the approver to every other device and session.
  assert.equal((await otherClient.request(base+'/cashier/approvals',input,secondDevice)).status,403,'another device is locked too');
  // No time expiry: only a CEO or another administrator clears it.
  await f.pool.query("UPDATE approval_pin_attempts SET locked_at=now()-interval '30 days' WHERE account_id=$1",[f.other.userId]);
  assert.equal((await otherClient.request(base+'/cashier/approvals',input,secondDevice)).status,403,'an old lock still holds');
  await f.pool.query("INSERT INTO membership_roles(clinic_id,user_id,role,granted_by) VALUES($1,$2,'ceo',$2)",[f.owner.clinicId,f.owner.userId]);
  assert.equal((await otherClient.request(base+`/staff/${f.other.userId}/approval-unlock`,{},secondDevice)).status,200);
  assert.equal((await f.pool.query("SELECT count(*)::int n FROM audit_events WHERE action='approval.unlocked' AND resource_id=$1",[f.other.userId])).rows[0].n,1);
  await f.pool.query("DELETE FROM membership_roles WHERE clinic_id=$1 AND user_id=$2 AND role='ceo'",[f.owner.clinicId,f.owner.userId]);
  const r=await otherClient.request(base+'/cashier/approvals',input,secondDevice);assert.equal(r.status,200);const approval=await r.json();
  const result=await otherClient.request(base+`/cashier/visits/${g.visit}/void`,{...input.payload,approvalId:approval.approvalId},secondDevice);assert.equal(result.status,200);
  assert.equal((await f.pool.query('SELECT voided_by FROM discounts WHERE id=$1',[discount])).rows[0].voided_by,f.other.userId);
});
test('021: cashier day report and print expose only own shifts and clinic day total, including closed snapshots',async t=>{
  const {f,call}=await setup(t),g=await seedCashier(f.pool,f.owner.clinicId,f.owner.userId);
  const shift=await call('/cashier/shifts',{deskId:g.desk,opening:'100'},201);
  await call(`/cashier/visits/${g.visit}/payments`,{shiftId:shift.id,amount:'123',method:'cash',key:id()},201);
  await call(`/cashier/shifts/${shift.id}/close`,{counted:'223'});
  await f.pool.query("INSERT INTO memberships(id,clinic_id,user_id,status,granted_by) VALUES($1,$2,$3,'active',$4)",[id(),f.owner.clinicId,f.other.userId,f.owner.userId]);
  const other=id();await f.pool.query(`INSERT INTO cash_shifts(id,clinic_id,cash_desk_id,business_day_id,cashier_user_id,opening_cash_uzs,status,closed_at,counted_cash_uzs,close_report) VALUES($1,$2,$3,$4,$5,999,'closed',now(),999,'{}')`,[other,f.owner.clinicId,g.desk,g.day,f.other.userId]);
  await f.pool.query("DELETE FROM membership_roles WHERE clinic_id=$1 AND user_id=$2 AND role<>'cashier'",[f.owner.clinicId,f.owner.userId]);
  await f.pool.query("INSERT INTO membership_roles(clinic_id,user_id,role,granted_by) VALUES($1,$2,'cashier',$2) ON CONFLICT DO NOTHING",[f.owner.clinicId,f.owner.userId]);
  for(const closed of [false,true]){
    if(closed){await f.pool.query("INSERT INTO membership_roles(clinic_id,user_id,role,granted_by) VALUES($1,$2,'ceo',$2)",[f.owner.clinicId,f.owner.userId]);await call(`/business-days/${g.day}/close`,{});await f.pool.query("DELETE FROM membership_roles WHERE clinic_id=$1 AND user_id=$2 AND role='ceo'",[f.owner.clinicId,f.owner.userId]);}
    const report=await call(`/reports/days/${g.day}`);assert.deepEqual(report.totals,{collected:'123'});assert.deepEqual(report.details,{});assert.deepEqual(report.doctors,[]);assert.deepEqual(report.departments,[]);assert.deepEqual(report.cashShifts.map((s:any)=>s.id),[shift.id]);assert.doesNotMatch(JSON.stringify(report),/Aliyev|1000000/);
    assert.equal((await call(`/reports/days/${g.day}/print`,{format:'pdf'})).mime,'application/pdf');
  }
});
test('021: close never waits for Telegram, durable outbox retries failure and survives restart',async t=>{
  const {f,call}=await setup(t),g=await seedCashier(f.pool,f.owner.clinicId,f.owner.userId);
  await f.pool.query('INSERT INTO telegram_links(account_id,telegram_user_id,clinic_id) VALUES($1,123456789,$2)',[f.owner.userId,f.owner.clinicId]);
  let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
  const original=f.telegramApi.call.bind(f.telegramApi);let calls=0;
  f.telegramApi.call=async(method,payload)=>{calls++;await held;return original(method,payload);};
  try{
    const close=call(`/business-days/${g.day}/close`,{});
    assert.equal(await Promise.race([close.then(()=>true),pause(700).then(()=>false)]),true,'close waited for Telegram');
  }finally{release();}
  f.telegramApi.call=original;f.telegramApi.fail=true;
  await dispatchReports(f.config,f.owner.clinicId);
  let notice=(await f.pool.query('SELECT * FROM report_notices WHERE clinic_id=$1',[f.owner.clinicId])).rows[0];assert.equal(notice.failed,1);assert.equal(notice.completed_at,null);
  await f.restart();f.telegramApi.fail=false;
  await f.pool.query('UPDATE report_notices SET next_attempt_at=now() WHERE id=$1',[notice.id]);
  await Promise.all([dispatchReports(f.config,f.owner.clinicId),dispatchReports(f.config,f.owner.clinicId)]);
  notice=(await f.pool.query('SELECT * FROM report_notices WHERE id=$1',[notice.id])).rows[0];assert.ok(notice.completed_at);assert.equal(notice.sent,1);assert.equal(notice.attempts,2);
  const count=f.telegramApi.calls.length;await dispatchReports(f.config,f.owner.clinicId);assert.equal(f.telegramApi.calls.length,count);
});
test('021: vulnerable fflate dependency is upgraded before import regressions run',()=>{
  const lock=JSON.parse(readFileSync('package-lock.json','utf8'));
  assert.ok(lock.packages['node_modules/fflate'].version.localeCompare('0.8.3',undefined,{numeric:true})>=0);
});


test('021: cashier handoff is present in five lines',()=>{
  assert.equal(readFileSync('docs/HANDOFF-TASK-009','utf8').trim().split(/\r?\n/).length,5);
});

test('021: future rule replacement succeeds while current rules remain immutable',async t=>{
  const {f,call}=await setup(t);const date=(await call('/payroll/rules')).today;
  const tomorrow=new Date(Date.parse(date)+86400000).toISOString().slice(0,10);
  const rule={userId:f.owner.userId,shareBp:5000,basis:'billed',discountBearer:'proportional',categories:['consultation'],effectiveFrom:tomorrow};
  const a=await call('/payroll/rules',rule,201),b=await call('/payroll/rules',{...rule,shareBp:8000},201);
  assert.equal(a.id,b.id);assert.equal(b.doctor_share_bp,8000);
  await call('/payroll/rules',{...rule,effectiveFrom:date},201);await call('/payroll/rules',{...rule,effectiveFrom:date,shareBp:1000},409);
});
test('021: discount void stores PIN approver separately from audited requesting cashier',async t=>{
  const {f,call}=await setup(t),g=await seedCashier(f.pool,f.owner.clinicId,f.owner.userId);
  await call(`/cashier/visits/${g.visit}/discount`,{kind:'fixed',amount:'10',reason:'Synthetic'});
  const discount=(await f.pool.query('SELECT id FROM discounts WHERE clinic_id=$1',[f.owner.clinicId])).rows[0].id;
  await f.pool.query("INSERT INTO memberships(id,clinic_id,user_id,status,granted_by) VALUES($1,$2,$3,'active',$4)",[id(),f.owner.clinicId,f.other.userId,f.owner.userId]);
  await f.pool.query("INSERT INTO membership_roles(clinic_id,user_id,role,granted_by) VALUES($1,$2,'administrator',$3)",[f.owner.clinicId,f.other.userId,f.owner.userId]);
  await transaction(f.pool,tx=>setOwnPin(tx,f.other.userId,'482613'));
  await f.pool.query("DELETE FROM membership_roles WHERE clinic_id=$1 AND user_id=$2 AND role<>'cashier'",[f.owner.clinicId,f.owner.userId]);
  await f.pool.query("INSERT INTO membership_roles(clinic_id,user_id,role,granted_by) VALUES($1,$2,'cashier',$2) ON CONFLICT DO NOTHING",[f.owner.clinicId,f.owner.userId]);
  const payload={discountId:discount,reason:'Synthetic void'};
  const approval=await call('/cashier/approvals',{approverId:f.other.userId,pin:'482613',visitId:g.visit,operation:'void',payload});
  await call(`/cashier/visits/${g.visit}/void`,{...payload,approvalId:approval.approvalId});
  assert.equal((await f.pool.query('SELECT voided_by FROM discounts WHERE id=$1',[discount])).rows[0].voided_by,f.other.userId);
  assert.equal((await f.pool.query("SELECT actor_id FROM audit_events WHERE clinic_id=$1 AND action='cashier.discount_voided'",[f.owner.clinicId])).rows[0].actor_id,f.owner.userId);
});

test('021: scoped doctor discount rounding matches complete invoice, including percent and fixed remainders',async t=>{
  const {f,call}=await setup(t),g=await seedCashier(f.pool,f.owner.clinicId,f.owner.userId);
  await f.pool.query('UPDATE charge_lines SET performer_user_id=$2 WHERE id=$1',[g.line,f.owner.userId]);
  const other=id();await f.pool.query(`INSERT INTO charge_lines(id,clinic_id,visit_id,service_id,quantity,unit_price_uzs,source,created_by) VALUES($1,$2,$3,$4,1,7,'registration',$5)`,[other,f.owner.clinicId,g.visit,g.service,f.owner.userId]);
  const date=(await f.pool.query('SELECT business_date FROM business_days WHERE id=$1',[g.day])).rows[0].business_date;
  for(const [kind,amount] of [['fixed','100003'],['percent','3333']] as const){
    await call(`/cashier/visits/${g.visit}/discount`,{kind,amount,reason:'Synthetic rounding'});
    await transaction(f.pool,async tx=>{
      const c=await requireRole(tx,f.owner.userId,f.owner.clinicId,['ceo']);
      const all=await records(c,{from:date,to:date}),own=await records(c,{from:date,to:date},{doctor:f.owner.userId});
      const full=invoiceAt(all,all.visits[0]!,date).find(l=>l.id===g.line),scoped=invoiceAt(own,own.visits[0]!,date).find(l=>l.id===g.line);
      assert.deepEqual(scoped,full);assert.deepEqual(own.charges.map(l=>l.id),[g.line]);assert.deepEqual(own.discounts,[]);
    });
    const d=(await f.pool.query('SELECT id FROM discounts WHERE clinic_id=$1 AND voided_at IS NULL',[f.owner.clinicId])).rows[0].id;
    await call(`/cashier/visits/${g.visit}/void`,{discountId:d,reason:'Next rounding case'});
  }
});


test('021: close reads before locking, detects an intervening ledger write and preserves the open day',async t=>{
  const {f,call}=await setup(t),g=await seedCashier(f.pool,f.owner.clinicId,f.owner.userId);
  await assert.rejects(transaction(f.pool,async tx=>{
    const c=await requireRole(tx,f.owner.userId,f.owner.clinicId,['ceo']);
    const query=tx.query.bind(tx);let changed=false;
    tx.query=(async(...args:any[])=>{
      const result=await (query as any)(...args);
      if(!changed && typeof args[0]==='string' && args[0].includes('jsonb_agg')){
        changed=true;
        await f.pool.query(`INSERT INTO charge_lines(id,clinic_id,visit_id,service_id,quantity,unit_price_uzs,source,created_by) VALUES($1,$2,$3,$4,1,50,'registration',$5)`,[id(),f.owner.clinicId,g.visit,g.service,f.owner.userId]);
      }
      return result;
    }) as typeof tx.query;
    try{await closeDay(c,g.day);}finally{tx.query=query;}
  }),/INVALID_TRANSITION/);
  assert.equal((await f.pool.query('SELECT status FROM business_days WHERE id=$1',[g.day])).rows[0].status,'open');
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM report_notices WHERE clinic_id=$1',[f.owner.clinicId])).rows[0].n,0);
  await call(`/business-days/${g.day}/close`,{});
  assert.equal((await call(`/reports/days/${g.day}`)).totals.value,'1000050');
});
test('021: unbalanced visit is flagged in a successful immutable close snapshot',async t=>{
  const {f,call}=await setup(t),g=await seedCashier(f.pool,f.owner.clinicId,f.owner.userId);
  const shift=await call('/cashier/shifts',{deskId:g.desk,opening:'0'},201);
  await call(`/cashier/visits/${g.visit}/payments`,{shiftId:shift.id,amount:'1000000',method:'cash',key:id()},201);
  const payment=(await f.pool.query('SELECT id FROM payments WHERE clinic_id=$1',[f.owner.clinicId])).rows[0].id;
  const line=id();await f.pool.query(`INSERT INTO charge_lines(id,clinic_id,visit_id,service_id,quantity,unit_price_uzs,source,created_by) VALUES($1,$2,$3,$4,1,1,'registration',$5)`,[line,f.owner.clinicId,g.visit,g.service,f.owner.userId]);
  await f.pool.query('INSERT INTO payment_allocations(clinic_id,payment_id,charge_line_id,amount_uzs) VALUES($1,$2,$3,2)',[f.owner.clinicId,payment,line]);
  await call(`/cashier/shifts/${shift.id}/close`,{counted:'1000000'});
  await call(`/business-days/${g.day}/close`,{});
  const report=await call(`/reports/days/${g.day}`);assert.equal(report.snapshot,true);assert.deepEqual(report.needsReview.map((v:any)=>v.id),[g.visit]);assert.equal(report.totals.value,'0');assert.equal(report.totals.collected,'1000000');
});

test('021: doctor-only payroll includes later visit-discount changes without new payments or owned lines',async t=>{
  const {f,call}=await setup(t),g=await seedCashier(f.pool,f.owner.clinicId,f.owner.userId);
  await f.pool.query('UPDATE charge_lines SET performer_user_id=$2 WHERE id=$1',[g.line,f.owner.userId]);
  const date=(await f.pool.query('SELECT business_date FROM business_days WHERE id=$1',[g.day])).rows[0].business_date,next=new Date(Date.parse(date)+86400000).toISOString().slice(0,10);
  await call('/payroll/rules',{userId:f.owner.userId,shareBp:5000,basis:'billed',discountBearer:'proportional',categories:['consultation'],effectiveFrom:date},201);
  await f.pool.query(`INSERT INTO discounts(id,clinic_id,visit_id,kind,amount_uzs,reason,approved_by,created_by,created_at) VALUES($1,$2,$3,'fixed',100000,'Synthetic later waiver',$4,$4,($5::date+time '10:00') AT TIME ZONE 'Asia/Tashkent')`,[id(),f.owner.clinicId,g.visit,f.owner.userId,next]);
  const p={from:next,to:next},all=await call('/payroll/earnings',p);assert.equal(all.lines[0].entitlement_uzs,'-50000');
  await f.pool.query("DELETE FROM membership_roles WHERE clinic_id=$1 AND user_id=$2 AND role<>'doctor'",[f.owner.clinicId,f.owner.userId]);
  const own=await call('/payroll/earnings',p);assert.equal(own.lines[0].entitlement_uzs,all.lines[0].entitlement_uzs);assert.equal(own.lines[0].charge_line_id,g.line);
});
