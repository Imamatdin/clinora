import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID as id } from 'node:crypto';
import { httpFixture } from './fixture.js';
import { seedCashier } from './cashier-fixture.js';
import { transaction } from '../../src/server/database.js';
import { requireRole } from '../../src/server/roles.js';
import { setOwnPin } from '../../src/modules/devices/actions.js';

test('cashier HTTP workflow: concurrent idempotency, approval, targeted refunds, cash close, persistence and guards',async()=>{
 const f=await httpFixture();try{
 const g=await seedCashier(f.pool,f.owner.clinicId,f.owner.userId);const c=f.client();await c.login();const base=`/api/clinics/${f.owner.clinicId}/cashier`;
 const call=async(path:string,input?:unknown,status=200)=>{const r=await c.request(base+path,input);const body=await r.json();assert.equal(r.status,status,JSON.stringify(body));return body;};
 const s=await call('/shifts',{deskId:g.desk,opening:'10000'},201);
 await call('/shifts',{deskId:g.desk,opening:'0'},409);
 const payment={shiftId:s.id,amount:'200000',method:'cash',key:id()};
 const receipts=await Promise.all([call(`/visits/${g.visit}/payments`,payment,201),call(`/visits/${g.visit}/payments`,payment,201)]);assert.equal(receipts[0].id,receipts[1].id);
 await call(`/visits/${g.visit}/payments`,{...payment,amount:'200001'},422);
 await call(`/visits/${g.visit}/payments`,{...payment,key:id(),method:'card'},201);
 let b=await call(`/visits/${g.visit}`);assert.equal(b.invoice.paid,'400000');assert.equal(b.invoice.due,'600000');
 await call(`/visits/${g.visit}/payments`,{...payment,key:id(),amount:'600001'},422);
 await call(`/visits/${g.visit}/discount`,{kind:'fixed',amount:'100000',reason:'Approved synthetic discount'});
 b=await call(`/visits/${g.visit}`);assert.equal(b.invoice.due,'500000');
 const original=b.payments.find((p:any)=>p.method==='cash');
 const refund={shiftId:s.id,paymentId:original.id,amount:'50000',reason:'Synthetic correction',key:id()};
 await call(`/visits/${g.visit}/refund`,refund);
 await call(`/visits/${g.visit}/refund`,{...refund,key:id(),amount:'150001'},422);
 await call(`/shifts/${s.id}/cash-out`,{expenseId:g.expense,amount:'10000',note:'Synthetic supply'} ,201);
 b=await call(`/visits/${g.visit}`);assert.equal(b.invoice.paid,'350000');assert.equal(b.invoice.due,'550000');
 const report=await call(`/shifts/${s.id}/close`,{counted:'149000'});assert.equal(report.expected,'150000');assert.equal(report.difference,'-1000');
 await call(`/visits/${g.visit}/payments`,{...payment,key:id()},409);
 await call(`/shifts/${s.id}/cash-out`,{expenseId:g.expense,amount:'1',note:'Closed'},409);
 await call(`/shifts/${s.id}/close`,{counted:'0'},409);
 await f.restart();await c.login();assert.equal((await call(`/visits/${g.visit}`)).invoice.paid,'350000');
 // Wrong-role requests are rejected before parsing bodies on every registered endpoint.
 await f.pool.query('DELETE FROM membership_roles WHERE clinic_id=$1 AND user_id=$2',[f.owner.clinicId,f.owner.userId]);
 for(const role of ['doctor','laboratory']){
 await f.pool.query('INSERT INTO membership_roles(clinic_id,user_id,role) VALUES($1,$2,$3)',[f.owner.clinicId,f.owner.userId,role]);
 for(const [path,body] of [['',undefined],['/search',{}],['/shifts',{}],[`/shifts/${s.id}/close`,{}],[`/shifts/${s.id}/cash-out`,{}],[`/visits/${g.visit}`,undefined],['/approvals',{}],[`/visits/${g.visit}/payments`,{}],[`/visits/${g.visit}/refund`,{}],[`/visits/${g.visit}/discount`,{}],[`/visits/${g.visit}/void`,{}],[`/receipts/${receipts[0].id}/print`,{}]] as const)await call(path,body,403);
 await f.pool.query('DELETE FROM membership_roles WHERE clinic_id=$1 AND user_id=$2',[f.owner.clinicId,f.owner.userId]);}
 await f.pool.query("INSERT INTO membership_roles(clinic_id,user_id,role) VALUES($1,$2,'cashier')",[f.owner.clinicId,f.owner.userId]);
 await call(`/visits/${g.visit}/discount`,{kind:'fixed',amount:'1',reason:'No approval'},403);
 await call(`/visits/${g.visit}/refund`,{...refund,key:id()},403);
 assert.equal((await c.request(`/api/clinics/${f.other.clinicId}/cashier`)).status,404);
 }finally{await f.close();}
});

test('cashier approval PIN failure persists, approval binds payload, revoked approver cannot execute',async()=>{
 const f=await httpFixture();try{
 const g=await seedCashier(f.pool,f.owner.clinicId,f.owner.userId);const c=f.client();await c.login();
 // Second active account is made a manager of the first clinic for synthetic approvals.
 await f.pool.query("INSERT INTO memberships(id,clinic_id,user_id,role,status,granted_by) VALUES($1,$2,$3,'administrator','active',$4)",[id(),f.owner.clinicId,f.other.userId,f.owner.userId]);
 await f.pool.query("INSERT INTO membership_roles(clinic_id,user_id,role) VALUES($1,$2,'administrator')",[f.owner.clinicId,f.other.userId]);
 await transaction(f.pool,async tx=>setOwnPin(tx,f.other.userId,'4826'));
 await f.pool.query("DELETE FROM membership_roles WHERE clinic_id=$1 AND user_id=$2",[f.owner.clinicId,f.owner.userId]);
 await f.pool.query("INSERT INTO membership_roles(clinic_id,user_id,role) VALUES($1,$2,'cashier')",[f.owner.clinicId,f.owner.userId]);
 const base=`/api/clinics/${f.owner.clinicId}/cashier`,payload={kind:'fixed',amount:'10',reason:'Synthetic'};
 const approval={approverId:f.other.userId,pin:'4826',visitId:g.visit,operation:'discount',payload};
 assert.equal((await c.request(base+'/approvals',{...approval,pin:'1111'})).status,403);
 assert.equal((await f.pool.query('SELECT failed_attempts FROM account_pins WHERE account_id=$1',[f.other.userId])).rows[0].failed_attempts,1);
 const r=await c.request(base+'/approvals',approval);assert.equal(r.status,200);const {approvalId}=await r.json();
 assert.equal((await c.request(base+`/visits/${g.visit}/discount`,{...payload,amount:'11',approvalId})).status,403);
 assert.equal((await c.request(base+`/visits/${g.visit}/discount`,{...payload,approvalId})).status,200);
 assert.equal((await c.request(base+`/visits/${g.visit}/discount`,{...payload,approvalId})).status,403);
 const a=await (await c.request(base+'/approvals',{...approval,payload:{...payload,lineId:g.line}})).json();
 await f.pool.query("DELETE FROM membership_roles WHERE clinic_id=$1 AND user_id=$2",[f.owner.clinicId,f.other.userId]);
 assert.equal((await c.request(base+`/visits/${g.visit}/discount`,{...payload,lineId:g.line,approvalId:a.approvalId})).status,403);
 }finally{await f.close();}
});
