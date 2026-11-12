import { DomainError } from '../identity/access.js';
import { requireRole, type ClinicContext } from '../../server/roles.js';
import { records, invoiceAt, serviceDate, inRange, localDate, sum, indexRecords, type Period, type Records, type Row } from './records.js';

export type Detail = { id: string; date: string; label: string; amount: string; patientId?:string; doctorId?: string; doctor?: string; departmentId?: string; department?: string; kind?: string; source?: string };
export type Report = { from: string; to: string; clinic: string; generatedAt: string; snapshot?: boolean; totals: Record<string,string>;
  needsReview?: {id:string;label:string}[]; details: Record<string,Detail[]>; doctors: Group[]; departments: Group[]; sources: Group[];cashShifts?:{id:string;cashier:string;date:string;opening:string;expected:string;counted:string|null;difference:string|null}[] };
export type Group = { id: string; name: string; amount: string; lines: Detail[]; patientLines?:Detail[];valueLines?:Detail[];discountLines?:Detail[];outstandingLines?:Detail[] };
const group = (lines: Detail[], key: 'doctor'|'department'|'source'): Group[] => {
  const map = new Map<string,Group>();
  for (const l of lines) {
    const id = key === 'source' ? l.source ?? '—' : l[key === 'doctor' ? 'doctorId' : 'departmentId'] ?? '—';
    const row = map.get(id) ?? { id, name: l[key] ?? '—', amount: '0', lines: [] };
    row.amount = (BigInt(row.amount) + BigInt(l.amount)).toString(); row.lines.push(l); map.set(id,row);
  }
  return [...map.values()].sort((a,b) => BigInt(a.amount) > BigInt(b.amount) ? -1 : 1);
};
export function computeReport(data: Records, p: Period): Report {
  const index=indexRecords(data);
  const details: Record<string,Detail[]> = Object.fromEntries(['patients','new','returning','outpatient','inpatient','value','discounts','outstanding','collected','cash','card','transfer','refunds','cashOuts','net','lab','ward'].map(k=>[k,[]]));
  const add = (k: string, d: Detail) => details[k]!.push(d);
  const needsReview: {id:string;label:string}[]=[];
  const visits = data.visits.filter(v => inRange(v.date,p) && v.status !== 'cancelled');
  const seen = new Set<string>();
  for (const v of visits) {
    // Unique patients in the period; outpatient/inpatient cohorts may overlap.
    const l = { id: v.id, date: v.date, label: `${v.patient_no} · ${v.full_name}`, amount: '1', source: v.acquisition_source ?? '—' };
    for (const k of ['patients', v.first_date >= p.from ? 'new' : 'returning',v.type]) {
      const identity = `${k}:${v.patient_id}`; if (!seen.has(identity)) { add(k,l); seen.add(identity); }
    }
  }
  for (const v of data.visits.filter(v=>v.status!=='cancelled')) {
    let lines;
    try { lines=invoiceAt(data,v,p.to); } catch(error) {
      if(!(error instanceof DomainError || error instanceof RangeError || error instanceof TypeError))throw error;
      needsReview.push({id:v.id,label:`${v.patient_no} · ${v.full_name}`});continue;
    }
    for (const line of lines) {
      const raw = index.charges.get(line.id)!;
      const d: Detail = { id: line.id,date: serviceDate(raw,data),label: `${v.patient_no} · ${raw.service}`,amount: line.value.toString(),patientId:v.patient_id,
        doctorId: raw.performer_user_id,doctor: raw.doctor,departmentId:raw.department_id,department:raw.department,kind:raw.kind };
      if(inRange(d.date,p)){add('value',d);add('discounts',{...d,amount:line.discount.toString()});}
      if(line.payable!==line.allocatedPaid)add('outstanding',{...d,amount:(line.payable-line.allocatedPaid).toString()});
    }
  }
  // Receipt provenance is preserved, including refunds for visits from earlier business days.
  const selectedPayments = data.payments.filter(r=>inRange(r.date,p));
  const selectedById=new Map(selectedPayments.map(p=>[p.id,p])),allPayments=new Map(data.payments.map(p=>[p.id,p]));
  for (const r of selectedPayments) {
    const v = index.visits.get(r.visit_id)!;
    const d: Detail = {id:r.id,date:r.date,label:`${v.patient_no} · ${v.full_name}`,amount:r.amount_uzs};
    if (r.kind === 'payment') { add('collected',d); add(r.method,d); }
    else add('refunds',d);
    add('net',{...d,amount:(BigInt(d.amount)*(r.kind==='payment'?1n:-1n)).toString()});
  }
  for (const r of data.cashOuts.filter(r=>inRange(r.date,p))) add('cashOuts',{id:r.id,date:r.date,label:r.note??'—',amount:r.amount_uzs});
  const revenue: Detail[] = [];
  for (const a of data.allocations) {
    const payment = selectedById.get(a.payment_id); if (!payment) continue;
    const l = index.charges.get(a.charge_line_id)!;
    revenue.push({id:`${payment.id}:${l.id}`,date:payment.date,label:l.service,amount:(BigInt(a.amount_uzs)*(payment.kind==='payment'?1n:-1n)).toString(),doctorId:l.performer_user_id,doctor:l.doctor,departmentId:l.department_id,department:l.department,kind:l.kind});
  }
  for (const a of data.adjustments) {
    const payment=allPayments.get(a.payment_id), date=localDate(a.created_at,data.clinic.timezone);
    if (!payment || !inRange(date,p)) continue;
    const l=index.charges.get(a.charge_line_id)!;
    revenue.push({id:a.id,date,label:l.service,amount:a.delta_uzs,doctorId:l.performer_user_id,doctor:l.doctor,departmentId:l.department_id,department:l.department,kind:l.kind});
  }
  details.lab = revenue.filter(l=>l.kind==='lab'); details.ward = revenue.filter(l=>['bed','caretaker'].includes(l.kind!));
  const performance=(key:'doctor'|'department')=>{
    const revenueGroups=new Map(group(revenue,key).map(g=>[g.id,g])),values=new Map(group(details.value!,key).map(g=>[g.id,g]));
    const discounts=new Map(group(details.discounts!,key).map(g=>[g.id,g])),outstanding=new Map(group(details.outstanding!,key).map(g=>[g.id,g]));
    return [...new Set([...values.keys(),...revenueGroups.keys()])].map(id=>{
      const r=revenueGroups.get(id)??{id,name:values.get(id)!.name,amount:'0',lines:[]};
      const patients=new Map<string,Detail>();
      for(const l of values.get(id)?.lines??[])if(index.charges.get(l.id)?.status!=='cancelled' && l.patientId){const v=index.visits.get(index.charges.get(l.id)!.visit_id)!;patients.set(l.patientId,{...l,id:v.id,label:`${v.patient_no} · ${v.full_name}`,amount:'1'});}
      return {...r,patientLines:[...patients.values()],valueLines:values.get(id)?.lines??[],discountLines:discounts.get(id)?.lines??[],outstandingLines:outstanding.get(id)?.lines??[]};
    });
  };
  return { ...p,clinic:data.clinic.name,generatedAt:new Date().toISOString(),details,needsReview,
    totals:Object.fromEntries(Object.entries(details).map(([k,v])=>[k,sum(v,'amount').toString()])),
    doctors:performance('doctor'),departments:performance('department'),sources:group(details.patients!,'source'),cashShifts:data.shifts.filter(s=>inRange(s.date,p)).map(s=>{
      const cash=data.payments.filter(r=>r.cash_shift_id===s.id&&r.method==='cash'),outs=data.cashOuts.filter(r=>r.cash_shift_id===s.id);
      const expected=BigInt(s.opening_cash_uzs)+cash.reduce((n,r)=>n+BigInt(r.amount_uzs)*(r.kind==='payment'?1n:-1n),0n)-sum(outs,'amount_uzs');
      return {id:s.id,cashier:s.cashier,date:s.date,opening:s.opening_cash_uzs,expected:expected.toString(),counted:s.counted_cash_uzs,difference:s.counted_cash_uzs===null?null:(BigInt(s.counted_cash_uzs)-expected).toString()};
    }) };
}
export async function dashboard(c: ClinicContext,p: Period) {
  await requireRole(c.tx,c.actorId,c.clinicId,['ceo']);
  return computeReport(await records(c,p,{outstanding:true}),p);
}
export async function dayReport(c: ClinicContext,id: string) {
  const ctx=await requireRole(c.tx,c.actorId,c.clinicId,['ceo','administrator','cashier']);
  const day=(await c.tx.query('SELECT * FROM business_days WHERE clinic_id=$1 AND id=$2',[c.clinicId,id])).rows[0];
  if (!day) throw new DomainError('NOT_FOUND');
  const p={from:day.business_date,to:day.business_date};
  if(!ctx.roles.some(r=>r==='ceo'||r==='administrator')) {
    // Never deserialize the clinic snapshot or patient/revenue detail for a cashier.
    const shifts=(await c.tx.query(`SELECT s.*,a.display_name cashier FROM cash_shifts s JOIN accounts a ON a.id=s.cashier_user_id WHERE s.clinic_id=$1 AND s.business_day_id=$2 AND s.cashier_user_id=$3`,[c.clinicId,id,c.actorId])).rows;
    const cashShifts=[];
    for(const s of shifts){
      const sums=(await c.tx.query(`SELECT coalesce(sum(CASE WHEN kind='payment' THEN amount_uzs ELSE -amount_uzs END),0)::text cash FROM payments WHERE clinic_id=$1 AND cash_shift_id=$2 AND method='cash'`,[c.clinicId,s.id])).rows[0];
      const outs=(await c.tx.query('SELECT coalesce(sum(amount_uzs),0)::text amount FROM cash_outs WHERE clinic_id=$1 AND cash_shift_id=$2',[c.clinicId,s.id])).rows[0];
      const expected=BigInt(s.opening_cash_uzs)+BigInt(sums.cash)-BigInt(outs.amount);
      cashShifts.push({id:s.id,cashier:s.cashier,date:day.business_date,opening:s.opening_cash_uzs,expected:expected.toString(),counted:s.counted_cash_uzs?.toString()??null,difference:s.counted_cash_uzs===null?null:(BigInt(s.counted_cash_uzs)-expected).toString()});
    }
    const total=(await c.tx.query(`SELECT coalesce(sum(amount_uzs) FILTER(WHERE kind='payment'),0)::text total FROM payments WHERE clinic_id=$1 AND business_day_id=$2`,[c.clinicId,id])).rows[0].total;
    return {...p,clinic:(await c.tx.query('SELECT name FROM clinics WHERE id=$1',[c.clinicId])).rows[0].name,generatedAt:new Date().toISOString(),snapshot:day.status==='closed',totals:{collected:total},details:{},doctors:[],departments:[],sources:[],cashShifts} as Report;
  }
  if (day.status==='closed' && day.close_snapshot?.totals) return {...day.close_snapshot,snapshot:true} as Report;
  return computeReport(await records(c,p,{outstanding:true}),p);
}
