import { DomainError } from '../identity/access.js';
import { requireRole, type ClinicContext } from '../../server/roles.js';
import { records, invoiceAt, inRange, localDate, sum, indexRecords, type Period, type Records, type Row } from './records.js';

export type Detail = { id: string; date: string; label: string; amount: string; patientId?:string; doctorId?: string; doctor?: string; departmentId?: string; department?: string; kind?: string; source?: string };
export type Report = { from: string; to: string; clinic: string; generatedAt: string; snapshot?: boolean; totals: Record<string,string>;
  details: Record<string,Detail[]>; doctors: Group[]; departments: Group[]; sources: Group[] };
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
  const visits = data.visits.filter(v => inRange(v.date,p) && v.status !== 'cancelled');
  const seen = new Set<string>();
  for (const v of visits) {
    // Unique patients in the period; outpatient/inpatient cohorts may overlap.
    const l = { id: v.id, date: v.date, label: `${v.patient_no} · ${v.full_name}`, amount: '1', source: v.acquisition_source ?? '—' };
    for (const k of ['patients', v.first_date >= p.from ? 'new' : 'returning',v.type]) {
      const identity = `${k}:${v.patient_id}`; if (!seen.has(identity)) { add(k,l); seen.add(identity); }
    }
    for (const line of invoiceAt(data,v,p.to)) {
      const raw = index.charges.get(line.id)!;
      const d: Detail = { id: line.id,date: v.date,label: `${v.patient_no} · ${raw.service}`,amount: line.value.toString(),patientId:v.patient_id,
        doctorId: raw.performer_user_id,doctor: raw.doctor,departmentId:raw.department_id,department:raw.department,kind:raw.kind };
      add('value',d); add('discounts',{...d,amount:line.discount.toString()}); add('outstanding',{...d,amount:(line.payable-line.allocatedPaid).toString()});
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
  return { ...p,clinic:data.clinic.name,generatedAt:new Date().toISOString(),details,
    totals:Object.fromEntries(Object.entries(details).map(([k,v])=>[k,sum(v,'amount').toString()])),
    doctors:performance('doctor'),departments:performance('department'),sources:group(details.patients!,'source') };
}
export async function dashboard(c: ClinicContext,p: Period) {
  await requireRole(c.tx,c.actorId,c.clinicId,['ceo']);
  return computeReport(await records(c),p);
}
export async function dayReport(c: ClinicContext,id: string) {
  await requireRole(c.tx,c.actorId,c.clinicId,['ceo','administrator','cashier']);
  const day=(await c.tx.query('SELECT * FROM business_days WHERE clinic_id=$1 AND id=$2',[c.clinicId,id])).rows[0];
  if (!day) throw new DomainError('NOT_FOUND');
  if (day.status==='closed' && day.close_snapshot?.totals) return {...day.close_snapshot,snapshot:true} as Report;
  return computeReport(await records(c),{from:day.business_date,to:day.business_date});
}
