import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { calculateInvoice, uzs, type Discount, type Invoice } from '../billing/index.js';
import { DomainError } from '../identity/access.js';
import { requireRole, type ClinicContext } from '../../server/roles.js';
import { withAudit } from '../../server/repo/audit.js';
import { nextReceiptNo } from '../../server/repo/counters.js';
import { digest, passwordMatches } from '../../server/security.js';

const id = z.string().uuid(), money = z.string().regex(/^(0|[1-9]\d{0,17})$/);
const positive = money.refine(v => BigInt(v)>0n), reason = z.string().trim().min(1).max(1000);
export const Open = z.object({ deskId:id, opening:money }).strict();
export const Close = z.object({ counted:money }).strict();
export const Search = z.object({ query:z.string().trim().min(1).max(100) }).strict();
export const Payment = z.object({ shiftId:id, amount:positive, method:z.enum(['cash','card','transfer']), key:z.string().min(8).max(200) }).strict();
export const Reduction = z.object({ kind:z.enum(['percent','fixed']), amount:positive, lineId:id.optional(), reason }).strict();
export const Refund = z.object({ shiftId:id, paymentId:id, amount:positive, reason, key:z.string().min(8).max(200) }).strict();
export const Void = z.object({ discountId:id, reason }).strict();
export const Out = z.object({ expenseId:id, amount:positive, note:reason }).strict();
export const Approved = z.object({ approvalId:id.optional() });
export const Approval = z.object({ approverId:id, pin:z.string().regex(/^\d{4,6}$/), visitId:id,
 operation:z.enum(['discount','refund','void']), payload:z.unknown() }).strict();
const fail = (code:'NOT_FOUND'|'FORBIDDEN'|'INVALID_INPUT'|'INVALID_TRANSITION'):never=>{throw new DomainError(code);};
export const json = <T>(value:T): any => JSON.parse(JSON.stringify(value,(_k,v)=>typeof v==='bigint'?v.toString():v));
const audited = (c:ClinicContext,action:string,id:string)=>withAudit(c.tx,c,`cashier.${action}`,id);
export async function guard(c:ClinicContext) { await requireRole(c.tx,c.actorId,c.clinicId,['cashier','ceo','administrator']); }
async function visit(c:ClinicContext,visitId:string) {
 const r=(await c.tx.query('SELECT * FROM visits WHERE clinic_id=$1 AND id=$2 FOR UPDATE',[c.clinicId,visitId])).rows[0];
 if(!r)return fail('NOT_FOUND'); if(r.status==='cancelled')return fail('INVALID_TRANSITION');return r;
}
async function shift(c:ClinicContext,shiftId:string) {
 const r=(await c.tx.query(`SELECT s.* FROM cash_shifts s JOIN business_days d ON d.id=s.business_day_id AND d.clinic_id=s.clinic_id
 WHERE s.clinic_id=$1 AND s.id=$2 AND s.status='open' AND d.status='open' FOR UPDATE OF s FOR SHARE OF d`,[c.clinicId,shiftId])).rows[0];
 if(!r)return fail('INVALID_TRANSITION');
 if(r.cashier_user_id!==c.actorId&&!c.roles.some(r=>r==='ceo'||r==='administrator'))return fail('FORBIDDEN'); return r;
}
export async function lookup(c:ClinicContext,input:z.infer<typeof Search>) {
 await guard(c); const q=input.query;
 return (await c.tx.query(`SELECT DISTINCT v.id, p.full_name, p.patient_no FROM visits v JOIN patients p ON p.id=v.patient_id AND p.clinic_id=v.clinic_id
 LEFT JOIN queue_tickets t ON t.visit_id=v.id AND t.clinic_id=v.clinic_id
 WHERE v.clinic_id=$1 AND (p.patient_no::text=$2 OR (length($3)>=4 AND regexp_replace(coalesce(p.phone,''),'[^0-9]','','g') LIKE '%'||$3||'%')
 OR t.number::text=$2) ORDER BY p.patient_no LIMIT 50`,[c.clinicId,q,q.replace(/\D/g,'')])).rows;
}
export async function overview(c:ClinicContext) {
 await guard(c);
 const desks=(await c.tx.query('SELECT * FROM cash_desks WHERE clinic_id=$1 AND is_active ORDER BY name',[c.clinicId])).rows;
 const expenses=(await c.tx.query('SELECT id,name_uz_cyrl FROM expense_types WHERE clinic_id=$1 AND is_active ORDER BY name_uz_cyrl',[c.clinicId])).rows;
 const shifts=(await c.tx.query(`SELECT * FROM cash_shifts WHERE clinic_id=$1 AND (cashier_user_id=$2 OR $3) ORDER BY opened_at DESC LIMIT 30`,[c.clinicId,c.actorId,c.roles.some(r=>r==='ceo'||r==='administrator')])).rows;
 const approvers=(await c.tx.query(`SELECT DISTINCT a.id,a.display_name FROM accounts a JOIN memberships m ON m.user_id=a.id JOIN membership_roles r ON r.user_id=m.user_id AND r.clinic_id=m.clinic_id WHERE m.clinic_id=$1 AND m.status='active' AND a.status='active' AND r.role IN ('ceo','administrator')`,[c.clinicId])).rows;
 return {desks,expenses,shifts,approvers};
}
export async function open(c:ClinicContext,input:z.infer<typeof Open>) {
 await guard(c);
 const day=(await c.tx.query("SELECT id FROM business_days WHERE clinic_id=$1 AND status='open' FOR SHARE",[c.clinicId])).rows[0];
 if(!day)return fail('INVALID_TRANSITION');
 const desk=(await c.tx.query('SELECT id FROM cash_desks WHERE clinic_id=$1 AND id=$2 AND is_active FOR SHARE',[c.clinicId,input.deskId])).rows[0];
 if(!desk)return fail('NOT_FOUND');
 const row=(await c.tx.query(`INSERT INTO cash_shifts(id,clinic_id,cash_desk_id,business_day_id,cashier_user_id,opening_cash_uzs)
 VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING *`,[randomUUID(),c.clinicId,desk.id,day.id,c.actorId,input.opening])).rows[0];
 if(!row)return fail('INVALID_TRANSITION'); await audited(c,'shift_opened',row.id); return row;
}
export async function bill(c:ClinicContext,visitId:string) {
 await guard(c); await visit(c,visitId);
 const lines=(await c.tx.query(`SELECT l.*,s.kind category,s.name_uz_cyrl name,d.name_uz_cyrl department,a.display_name doctor FROM charge_lines l
 JOIN services s ON s.id=l.service_id AND s.clinic_id=l.clinic_id LEFT JOIN departments d ON d.id=s.department_id AND d.clinic_id=s.clinic_id
 LEFT JOIN accounts a ON a.id=l.performer_user_id WHERE l.clinic_id=$1 AND l.visit_id=$2 ORDER BY l.created_at,l.id`,[c.clinicId,visitId])).rows;
 const discounts=(await c.tx.query('SELECT * FROM discounts WHERE clinic_id=$1 AND visit_id=$2 AND voided_at IS NULL ORDER BY created_at,id',[c.clinicId,visitId])).rows;
 const payments=(await c.tx.query('SELECT * FROM payments WHERE clinic_id=$1 AND visit_id=$2 ORDER BY created_at,id',[c.clinicId,visitId])).rows;
 const net=payments.reduce((sum,r)=>sum+(r.kind==='payment'?1n:-1n)*BigInt(r.amount_uzs),0n);
 let invoice:Invoice;
 try { invoice=calculateInvoice(lines.map(r=>({id:r.id,unitPrice:uzs(r.unit_price_uzs),quantity:r.quantity,status:r.status,category:r.category,...(r.performer_user_id?{doctorId:r.performer_user_id}:{})})),
 discounts.map((r):Discount=>({reason:r.reason,approverId:r.approved_by,...(r.charge_line_id?{lineId:r.charge_line_id}:{}),...(r.kind==='fixed'?{kind:'fixed',amount:uzs(r.amount_uzs)}:{kind:'percent',basisPoints:r.percent_bp})})),net>0n?[{id:'net',kind:'payment',amount:uzs(net)}]:[]); }
 catch{return fail('INVALID_TRANSITION');}
 const allocations=(await c.tx.query(`SELECT a.charge_line_id, sum(CASE WHEN p.kind='payment' THEN a.amount_uzs ELSE -a.amount_uzs END)::text amount
 FROM payment_allocations a JOIN payments p ON p.id=a.payment_id AND p.clinic_id=a.clinic_id WHERE p.clinic_id=$1 AND p.visit_id=$2 GROUP BY a.charge_line_id`,[c.clinicId,visitId])).rows;
 const amounts=new Map(allocations.map(r=>[r.charge_line_id,BigInt(r.amount)]));
 for(const line of invoice.lines) if((amounts.get(line.id)??0n)>line.payable)return fail('INVALID_TRANSITION');
 const gross=payments.filter(p=>p.kind==='payment').reduce((s,p)=>s+BigInt(p.amount_uzs),0n);
 const refunds=payments.filter(p=>p.kind==='refund').reduce((s,p)=>s+BigInt(p.amount_uzs),0n);
 invoice={...invoice,payments:uzs(gross),refunds:uzs(refunds),status:refunds>0n&&net===0n?'refunded':invoice.status,
 transactions:payments.map(p=>({id:p.id,kind:p.kind,amount:uzs(p.amount_uzs)})),lines:invoice.lines.map(l=>({...l,allocatedPaid:uzs(amounts.get(l.id)??0n)}))};
 const patient=(await c.tx.query('SELECT p.full_name,p.patient_no FROM patients p JOIN visits v ON v.patient_id=p.id AND v.clinic_id=p.clinic_id WHERE v.clinic_id=$1 AND v.id=$2',[c.clinicId,visitId])).rows[0];
 const receipts=(await c.tx.query('SELECT id,receipt_no FROM receipts WHERE clinic_id=$1 AND visit_id=$2 ORDER BY issued_at,id',[c.clinicId,visitId])).rows;
 return {invoice,lines,discounts,payments,patient,receipts};
}
function payload(operation:string,visitId:string,input:unknown) {return digest(JSON.stringify({operation,visitId,input}));}
export async function approve(c:ClinicContext,input:z.infer<typeof Approval>) {
 await guard(c); await requireRole(c.tx,input.approverId,c.clinicId,['ceo','administrator']);
 const schema=input.operation==='refund'?Refund:input.operation==='discount'?Reduction:Void;
 const parsed=schema.safeParse(input.payload); if(!parsed.success)return fail('INVALID_INPUT');
 const p=(await c.tx.query(`SELECT p.* FROM account_pins p JOIN accounts a ON a.id=p.account_id WHERE p.account_id=$1 AND a.status='active' AND NOT a.must_change_password FOR UPDATE OF p`,[input.approverId])).rows[0];
 if(!p||p.locked_at)return {status:403,body:{error:{code:'FORBIDDEN'}}};
 if(!await passwordMatches(input.pin,p.pin_hash)) {
 await c.tx.query('UPDATE account_pins SET failed_attempts=failed_attempts+1,locked_at=CASE WHEN failed_attempts+1>=5 THEN now() ELSE NULL END WHERE account_id=$1',[input.approverId]);
 await audited(c,'approval_failed',input.approverId);
 return {status:403,body:{error:{code:'FORBIDDEN'}}};
 }
 await c.tx.query('UPDATE account_pins SET failed_attempts=0 WHERE account_id=$1',[input.approverId]);
 const approvalId=randomUUID(); await c.tx.query('INSERT INTO cashier_approvals(id,clinic_id,requested_by,approved_by,payload_hash) VALUES($1,$2,$3,$4,$5)',[approvalId,c.clinicId,c.actorId,input.approverId,payload(input.operation,input.visitId,parsed.data)]);
 await audited(c,'approved',approvalId); return {body:{approvalId}};
}
async function authorization(c:ClinicContext,operation:string,visitId:string,input:unknown,approvalId?:string) {
 if(c.roles.some(r=>r==='ceo'||r==='administrator'))return c.actorId;
 if(!approvalId)return fail('FORBIDDEN');
 const row=(await c.tx.query(`UPDATE cashier_approvals SET used_at=now() WHERE id=$1 AND clinic_id=$2 AND requested_by=$3 AND payload_hash=$4 AND used_at IS NULL AND expires_at>now() RETURNING approved_by`,[approvalId,c.clinicId,c.actorId,payload(operation,visitId,input)])).rows[0];
 if(!row)return fail('FORBIDDEN');
 await requireRole(c.tx,row.approved_by,c.clinicId,['ceo','administrator']);
 if(!(await c.tx.query("SELECT 1 FROM accounts WHERE id=$1 AND status='active'",[row.approved_by])).rowCount)return fail('FORBIDDEN'); return row.approved_by as string;
}
export async function discount(c:ClinicContext,visitId:string,input:z.infer<typeof Reduction>,approvalId?:string) {
 await guard(c); await visit(c,visitId); const approver=await authorization(c,'discount',visitId,input,approvalId);
 if(input.kind==='percent'&&BigInt(input.amount)>10000n)return fail('INVALID_INPUT');
 if(input.lineId&&!(await c.tx.query('SELECT 1 FROM charge_lines WHERE clinic_id=$1 AND visit_id=$2 AND id=$3',[c.clinicId,visitId,input.lineId])).rowCount)return fail('NOT_FOUND');
 const id=randomUUID(); await c.tx.query(`INSERT INTO discounts(id,clinic_id,visit_id,charge_line_id,kind,percent_bp,amount_uzs,reason,approved_by,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[id,c.clinicId,visitId,input.lineId??null,input.kind,input.kind==='percent'?input.amount:null,input.kind==='fixed'?input.amount:null,input.reason,approver,c.actorId]);
 const result=await bill(c,visitId); await audited(c,'discounted',id); return json(result);
}
export async function voidDiscount(c:ClinicContext,visitId:string,input:z.infer<typeof Void>,approvalId?:string) {
 await guard(c);await visit(c,visitId);await authorization(c,'void',visitId,input,approvalId);
 const row=(await c.tx.query('UPDATE discounts SET voided_by=$4,voided_at=now(),void_reason=$5 WHERE clinic_id=$1 AND visit_id=$2 AND id=$3 AND voided_at IS NULL RETURNING id',[c.clinicId,visitId,input.discountId,c.actorId,input.reason])).rows[0];
 if(!row)return fail('NOT_FOUND');await audited(c,'discount_voided',row.id);return json(await bill(c,visitId));
}
export async function pay(c:ClinicContext,visitId:string,input:z.infer<typeof Payment>|z.infer<typeof Refund>,approvalId?:string) {
 await guard(c);
 await c.tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[c.clinicId+input.key]);
 const old=(await c.tx.query('SELECT * FROM payments WHERE clinic_id=$1 AND idempotency_key=$2',[c.clinicId,input.key])).rows[0];
 const refund='paymentId' in input;
 if(old){if(old.visit_id!==visitId||old.cash_shift_id!==input.shiftId||old.amount_uzs!==input.amount||old.kind!==(refund?'refund':'payment')||(refund?old.refund_of!==input.paymentId:old.method!==input.method))return fail('INVALID_INPUT');return (await c.tx.query('SELECT * FROM receipts WHERE clinic_id=$1 AND payment_id=$2',[c.clinicId,old.id])).rows[0];}
 if(refund)await authorization(c,'refund',visitId,input,approvalId);
 await visit(c,visitId);const s=await shift(c,input.shiftId);const before=await bill(c,visitId);const amount=uzs(input.amount);
 let method:string, allocations:{id:string;amount:bigint}[]=[];
 if(refund){
 const original=before.payments.find(p=>p.id===input.paymentId&&p.kind==='payment');if(!original)return fail('NOT_FOUND');method=original.method;
 const returned=before.payments.filter(p=>p.refund_of===original.id).reduce((sum,p)=>sum+BigInt(p.amount_uzs),0n);
 if(amount>BigInt(original.amount_uzs)-returned)return fail('INVALID_INPUT');
 const lots=(await c.tx.query(`SELECT a.charge_line_id id,a.amount_uzs-COALESCE((SELECT sum(ra.amount_uzs) FROM payment_allocations ra JOIN payments rp ON rp.id=ra.payment_id WHERE rp.clinic_id=$1 AND rp.refund_of=$2 AND ra.charge_line_id=a.charge_line_id),0) amount FROM payment_allocations a JOIN charge_lines l ON l.id=a.charge_line_id WHERE a.clinic_id=$1 AND a.payment_id=$2 ORDER BY l.created_at DESC,l.id DESC`,[c.clinicId,input.paymentId])).rows;
 let remaining:bigint=amount;for(const lot of lots){const available=BigInt(lot.amount);const n=remaining<available?remaining:available;if(n>0n)allocations.push({id:lot.id,amount:n});remaining-=n;}if(remaining!==0n)return fail('INVALID_TRANSITION');
 }else{method=input.method;if(amount>before.invoice.due)return fail('INVALID_INPUT');
 // Allocate through billing against outstanding line balances, preserving earlier allocations.
 const outstanding=calculateInvoice(before.invoice.lines.map(l=>({...l,unitPrice:uzs(l.payable-l.allocatedPaid),quantity:1})),[],[{id:'new',kind:'payment',amount}]);
 allocations=outstanding.lines.filter(l=>l.allocatedPaid>0n).map(l=>({id:l.id,amount:l.allocatedPaid}));}
 const id=randomUUID();await c.tx.query(`INSERT INTO payments(id,clinic_id,visit_id,cash_shift_id,business_day_id,kind,method,amount_uzs,refund_of,idempotency_key,received_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[id,c.clinicId,visitId,s.id,s.business_day_id,refund?'refund':'payment',method,input.amount,refund?input.paymentId:null,input.key,c.actorId]);
 for(const a of allocations)await c.tx.query('INSERT INTO payment_allocations(clinic_id,payment_id,charge_line_id,amount_uzs) VALUES($1,$2,$3,$4)',[c.clinicId,id,a.id,a.amount.toString()]);
 const after=await bill(c,visitId);const receiptId=randomUUID(),no=await nextReceiptNo(c.tx,c.clinicId);
 const settings=(await c.tx.query('SELECT receipt_header FROM clinic_settings WHERE clinic_id=$1',[c.clinicId])).rows[0];
 const snapshot=json({receiptNo:no,kind:refund?'refund':'payment',amount,method,reason:refund?input.reason:null,patient:after.patient,invoice:after.invoice,lines:after.lines,header:settings?.receipt_header??{},issuedAt:new Date().toISOString()});
 const receipt=(await c.tx.query('INSERT INTO receipts(id,clinic_id,receipt_no,visit_id,payment_id,kind,snapshot,issued_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[receiptId,c.clinicId,no.toString(),visitId,id,refund?'refund':'payment',snapshot,c.actorId])).rows[0];
 await audited(c,refund?'refunded':'paid',id);return receipt;
}
export async function cashOut(c:ClinicContext,shiftId:string,input:z.infer<typeof Out>) {
 await guard(c);const s=await shift(c,shiftId);
 if(!(await c.tx.query('SELECT 1 FROM expense_types WHERE clinic_id=$1 AND id=$2 AND is_active',[c.clinicId,input.expenseId])).rowCount)return fail('NOT_FOUND');
 const r=(await c.tx.query('INSERT INTO cash_outs(id,clinic_id,cash_shift_id,business_day_id,expense_type_id,amount_uzs,note,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[randomUUID(),c.clinicId,s.id,s.business_day_id,input.expenseId,input.amount,input.note,c.actorId])).rows[0];await audited(c,'cash_out',r.id);return r;
}
export async function close(c:ClinicContext,shiftId:string,input:z.infer<typeof Close>) {
 await guard(c);const s=await shift(c,shiftId);
 const r=(await c.tx.query(`SELECT COALESCE(sum(amount_uzs) FILTER(WHERE kind='payment'),0)::text payments,COALESCE(sum(amount_uzs) FILTER(WHERE kind='refund'),0)::text refunds FROM payments WHERE clinic_id=$1 AND cash_shift_id=$2 AND method='cash'`,[c.clinicId,s.id])).rows[0]!;
 const outs=(await c.tx.query('SELECT COALESCE(sum(amount_uzs),0)::text amount FROM cash_outs WHERE clinic_id=$1 AND cash_shift_id=$2',[c.clinicId,s.id])).rows[0]!.amount;
 const expected=BigInt(s.opening_cash_uzs)+BigInt(r.payments)-BigInt(r.refunds)-BigInt(outs);
 const report=json({opening:s.opening_cash_uzs,cashPayments:r.payments,cashRefunds:r.refunds,cashOuts:outs,expected,counted:input.counted,difference:BigInt(input.counted)-expected,closedAt:new Date().toISOString()});
 await c.tx.query("UPDATE cash_shifts SET status='closed',closed_at=now(),counted_cash_uzs=$3,close_report=$4 WHERE clinic_id=$1 AND id=$2",[c.clinicId,s.id,input.counted,report]);await audited(c,'shift_closed',s.id);return report;
}
export async function receipt(c:ClinicContext,id:string){await guard(c);const row=(await c.tx.query('UPDATE receipts SET print_count=print_count+1 WHERE clinic_id=$1 AND id=$2 RETURNING *',[c.clinicId,id])).rows[0];if(!row)return fail('NOT_FOUND');return row;}
