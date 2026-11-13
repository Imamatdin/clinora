import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { unzipSync,strFromU8 } from 'fflate';
import { httpFixture } from './fixture.js';
import { dispatchReports } from '../../src/modules/reports/notify.js';
import { seedCashier } from './cashier-fixture.js';

test('C8: day close reconciles ledger, rejects open shifts, snapshots and sends only financial totals',async()=>{
  const f=await httpFixture();try{
    const g=await seedCashier(f.pool,f.owner.clinicId,f.owner.userId),client=f.client();await client.login();
    const base=`/api/clinics/${f.owner.clinicId}`;
    const call=async(path:string,input?:unknown,status=200)=>{const r=await client.request(base+path,input),v=await r.json();assert.equal(r.status,status,JSON.stringify(v));return v;};
    await f.pool.query('INSERT INTO telegram_links(account_id,telegram_user_id,clinic_id) VALUES($1,123456789,$2)',[f.owner.userId,f.owner.clinicId]);
    const shift=await call('/cashier/shifts',{deskId:g.desk,opening:'10000'},201);
    await call(`/business-days/${g.day}/close`,{},409);
    await call(`/cashier/visits/${g.visit}/payments`,{shiftId:shift.id,amount:'400000',method:'cash',key:randomUUID()},201);
    await call(`/cashier/visits/${g.visit}/payments`,{shiftId:shift.id,amount:'100000',method:'card',key:randomUUID()},201);
    await call(`/cashier/visits/${g.visit}/discount`,{kind:'fixed',amount:'100000',reason:'Synthetic waiver'});
    const invoice=await call(`/cashier/visits/${g.visit}`),pay=invoice.payments.find((p:any)=>p.method==='cash');
    await call(`/cashier/visits/${g.visit}/refund`,{shiftId:shift.id,paymentId:pay.id,amount:'50000',reason:'Synthetic refund',key:randomUUID()});
    await call(`/cashier/shifts/${shift.id}/cash-out`,{expenseId:g.expense,amount:'20000',note:'Synthetic supplies',key:randomUUID()},201);
    const date=(await f.pool.query('SELECT business_date FROM business_days WHERE id=$1',[g.day])).rows[0].business_date;
    const report=await call('/reports/dashboard',{from:date,to:date});
    const direct=(await f.pool.query(`SELECT coalesce(sum(amount_uzs) FILTER(WHERE kind='payment'),0)::text collected,coalesce(sum(amount_uzs) FILTER(WHERE kind='refund'),0)::text refunds FROM payments WHERE clinic_id=$1 AND business_day_id=$2`,[f.owner.clinicId,g.day])).rows[0];
    assert.equal(report.totals.collected,direct.collected);assert.equal(report.totals.refunds,direct.refunds);
    assert.equal(report.totals.collected,'500000');assert.equal(report.totals.refunds,'50000');assert.equal(report.totals.cashOuts,'20000');assert.equal(report.totals.outstanding,'450000');assert.equal(report.totals.discounts,'100000');
    for(const [k,lines]of Object.entries(report.details))assert.equal((lines as any[]).reduce((s,l)=>s+BigInt(l.amount),0n).toString(),report.totals[k]);
    await call(`/cashier/shifts/${shift.id}/close`,{counted:'340000'});
    await call(`/business-days/${g.day}/close`,{});
    const saved=await call(`/reports/days/${g.day}`);assert.equal(saved.snapshot,true);assert.deepEqual(saved.totals,report.totals);
    assert.equal(saved.cashShifts[0].expected,'340000');assert.equal(saved.cashShifts[0].counted,'340000');assert.equal(saved.cashShifts[0].difference,'0');
    await call(`/business-days/${g.day}/close`,{},409);
    await dispatchReports(f.config,f.owner.clinicId);
    const messages=f.telegramApi.calls.filter(c=>c.method==='sendMessage');assert.equal(messages.length,1);
    const text=JSON.stringify(messages[0]);assert.match(text,/500000/);assert.doesNotMatch(text,/Synthetic Aliyev|patient|diagnosis|phone/i);
    assert.match(text,new RegExp(g.day));
    await f.restart();await client.login();assert.deepEqual((await call(`/reports/days/${g.day}`)).totals,report.totals);
    await assert.rejects(f.pool.query('UPDATE business_days SET close_snapshot=$2 WHERE id=$1',[g.day,{}]),/immutable/);
    // The DB protects the boundary even if a future module forgets its own open-day check.
    await assert.rejects(f.pool.query(`INSERT INTO cash_shifts(id,clinic_id,cash_desk_id,business_day_id,cashier_user_id,opening_cash_uzs) VALUES($1,$2,$3,$4,$5,0)`,[randomUUID(),f.owner.clinicId,g.desk,g.day,f.owner.userId]),/closed/);
    // A stay/visit may accrue services after its arrival day closes. Preserve the original snapshot.
    await f.pool.query(`INSERT INTO business_days(id,clinic_id,business_date,status,opened_by) VALUES($1,$2,$3::date+1,'open',$4)`,[randomUUID(),f.owner.clinicId,date,f.owner.userId]);
    await f.pool.query(`INSERT INTO charge_lines(id,clinic_id,visit_id,service_id,quantity,unit_price_uzs,source,created_by,created_at) VALUES($1,$2,$3,$4,1,200000,'inpatient',$5,now()+interval '1 day')`,[randomUUID(),f.owner.clinicId,g.visit,g.service,f.owner.userId]);
    assert.deepEqual((await call(`/reports/days/${g.day}`)).totals,saved.totals);
  }finally{await f.close();}
});

test('C8: CEO-only exports are valid PDF/XLSX/CSV ZIP, exact UZS, audited and clinic scoped',async()=>{
  const f=await httpFixture();try{
    const g=await seedCashier(f.pool,f.owner.clinicId,f.owner.userId),client=f.client();await client.login();
    const base=`/api/clinics/${f.owner.clinicId}`,date=(await f.pool.query('SELECT business_date FROM business_days WHERE id=$1',[g.day])).rows[0].business_date,period={from:date,to:date};
    // Larger than JS's safe integer: JSON SQL aggregation must preserve this exact value.
    const exact='9007199254740993';
    await f.pool.query(`INSERT INTO charge_lines(id,clinic_id,visit_id,service_id,quantity,unit_price_uzs,source,created_by) VALUES($1,$2,$3,$4,1,$5,'registration',$6)`,[randomUUID(),f.owner.clinicId,g.visit,g.service,exact,f.owner.userId]);
    const r=await client.request(base+'/reports/dashboard',period),report=await r.json();assert.equal(r.status,200);assert.equal(report.totals.value,(BigInt(exact)+1000000n).toString());
    for(const format of ['pdf','xlsx']){
      const res=await client.request(base+'/reports/export',{...period,format});assert.equal(res.status,200);const out=await res.json(),buffer=Buffer.from(out.base64,'base64');
      if(format==='pdf')assert.equal(buffer.subarray(0,4).toString(),'%PDF');
      else{const files=unzipSync(buffer);assert.match(strFromU8(files['xl/worksheets/sheet1.xml']!),new RegExp(exact));assert.ok(files['[Content_Types].xml']);}
    }
    const archive=await client.request(base+'/reports/full-export',{});assert.equal(archive.status,200);const files=unzipSync(Buffer.from((await archive.json()).base64,'base64'));
    assert.match(strFromU8(files['charge_lines.csv']!),new RegExp(exact));assert.ok(files['document_versions.csv']);assert.ok(files['payroll_lines.csv']);
    assert.doesNotMatch(Object.keys(files).join(','),/sessions|idempotency|invitation|telegram_links|devices/);
    assert.doesNotMatch(strFromU8(files['staff.csv']!),/password_hash|token_hash/);
    assert.equal((await f.pool.query("SELECT count(*) FROM audit_events WHERE clinic_id=$1 AND action='reports.full_export'",[f.owner.clinicId])).rows[0].count,'1');
    assert.equal((await client.request(`/api/clinics/${f.other.clinicId}/reports/dashboard`,period)).status,404);
    for(const role of ['doctor','administrator','cashier','registrar','laboratory','inpatient','pharmacy']){
      await f.pool.query('DELETE FROM membership_roles WHERE clinic_id=$1 AND user_id=$2',[f.owner.clinicId,f.owner.userId]);await f.pool.query('INSERT INTO membership_roles(clinic_id,user_id,role,granted_by) VALUES($1,$2,$3,$2)',[f.owner.clinicId,f.owner.userId,role]);
      for(const path of ['/reports/export','/reports/full-export','/payroll/export'])assert.equal((await client.request(base+path,{})).status,403,`${role} ${path}`);
      assert.equal((await client.request(base+'/reports/dashboard',period)).status,403,role);
    }
  }finally{await f.close();}
});

test('C8: dated split, private doctor earnings, concurrent finalization, immutable snapshot and subperiods',async()=>{
  const f=await httpFixture();try{
    const g=await seedCashier(f.pool,f.owner.clinicId,f.owner.userId),client=f.client();await client.login();
    const base=`/api/clinics/${f.owner.clinicId}`,date=(await f.pool.query('SELECT business_date FROM business_days WHERE id=$1',[g.day])).rows[0].business_date;
    await f.pool.query(`UPDATE charge_lines SET performer_user_id=$2,status='completed',completed_by=$2,completed_at=now() WHERE id=$1`,[g.line,f.owner.userId]);
    const call=async(path:string,input?:unknown,status=200)=>{const r=await client.request(base+path,input),v=await r.json();assert.equal(r.status,status,JSON.stringify(v));return v;};
    const rule={userId:f.owner.userId,shareBp:5000,basis:'billed',discountBearer:'proportional',categories:['consultation'],effectiveFrom:date};
    await call('/payroll/rules',rule,201);
    await f.pool.query("INSERT INTO memberships(id,clinic_id,user_id,status,granted_by) VALUES($1,$2,$3,'active',$4)",[randomUUID(),f.owner.clinicId,f.other.userId,f.owner.userId]);
    await f.pool.query("INSERT INTO membership_roles(clinic_id,user_id,role,granted_by) VALUES($1,$2,'doctor',$3)",[f.owner.clinicId,f.other.userId,f.owner.userId]);
    await call('/payroll/rules',{...rule,userId:f.other.userId,shareBp:4000},201);
    await f.pool.query(`INSERT INTO charge_lines(id,clinic_id,visit_id,service_id,performer_user_id,quantity,unit_price_uzs,source,created_by,status,completed_by,completed_at) VALUES($1,$2,$3,$4,$5,1,200000,'registration',$6,'completed',$6,now())`,[randomUUID(),f.owner.clinicId,g.visit,g.service,f.other.userId,f.owner.userId]);
    const period={from:date,to:date},before=await call('/payroll/earnings',period);assert.equal(before.lines.find((l:any)=>l.user_id===f.owner.userId).entitlement_uzs,'500000');
    const tomorrow=new Date(Date.parse(date)+86400000).toISOString().slice(0,10);
    await call('/payroll/rules',{...rule,shareBp:8000,effectiveFrom:tomorrow},201);
    assert.equal((await call('/payroll/earnings',period)).lines.find((l:any)=>l.user_id===f.owner.userId).entitlement_uzs,'500000');
    await call('/payroll/finalize',period,409); // Still open.
    await call(`/business-days/${g.day}/close`,{});
    const results=await Promise.all([call('/payroll/finalize',period),call('/payroll/finalize',period)]);
    assert.equal(results[0].period.id,results[1].period.id);assert.equal(results[0].lines.length,2);
    assert.equal((await f.pool.query('SELECT count(*) FROM payroll_lines WHERE clinic_id=$1',[f.owner.clinicId])).rows[0].count,'2');
    const finalId=results[0].period.id;
    await assert.rejects(f.pool.query('UPDATE payroll_lines SET entitlement_uzs=0 WHERE period_id=$1',[finalId]),/append.only/i);
    await assert.rejects(f.pool.query('UPDATE payroll_periods SET daily_snapshot=\'[]\' WHERE id=$1',[finalId]),/immutable/);
    // An arbitrary date range includes frozen daily accruals, without recalculating final pay.
    const range={from:new Date(Date.parse(date)-86400000).toISOString().slice(0,10),to:tomorrow};
    assert.equal((await call('/payroll/earnings',range)).lines.find((l:any)=>l.user_id===f.owner.userId).entitlement_uzs,'500000');
    await f.pool.query('DELETE FROM membership_roles WHERE clinic_id=$1 AND user_id=$2 AND role<>\'doctor\'',[f.owner.clinicId,f.owner.userId]);
    const ownRules=await call('/payroll/rules');assert.ok(ownRules.history.every((r:any)=>r.user_id===f.owner.userId));assert.ok(!('daily_snapshot' in (await call('/payroll/earnings',period)).period));
    const own=await call('/payroll/earnings',period);assert.equal(own.lines.length,1);assert.ok(own.lines.every((l:any)=>l.user_id===f.owner.userId));
    const ownRange=await call('/payroll/earnings',range);assert.equal(ownRange.lines.length,1);assert.ok(ownRange.lines.every((l:any)=>l.user_id===f.owner.userId));
    await call('/payroll/earnings',{...period,userId:f.other.userId},422);
    await call('/payroll/rules',rule,403);await call('/payroll/finalize',period,403);
    await f.pool.query("UPDATE memberships SET status='blocked' WHERE clinic_id=$1 AND user_id=$2",[f.owner.clinicId,f.owner.userId]);await call('/payroll/earnings',period,404);
  }finally{await f.close();}
});
