import { DomainError } from '../identity/access.js';
import { requireRole, type ClinicContext } from '../../server/roles.js';
import { records, invoiceAt, serviceDate, inRange, localDate, sum, indexRecords, type Period, type Records, type Row } from './records.js';

/** `rest` marks a remainder row: the count and sum of the rows not listed (see capReport). */
export type Detail = { id: string; date: string; label: string; amount: string; rest?: number; patientId?:string; doctorId?: string; doctor?: string; departmentId?: string; department?: string; kind?: string; source?: string };
export type Report = { from: string; to: string; clinic: string; generatedAt: string; snapshot?: boolean; totals: Record<string,string>;
  needsReview?: {id:string;label:string}[]; details: Record<string,Detail[]>; doctors: Group[]; departments: Group[]; sources: Group[];cashShifts?:{id:string;cashier:string;date:string;opening:string;expected:string;counted:string|null;difference:string|null}[] };
export type Group = { id: string; name: string; amount: string; lines: Detail[]; patientLines?:Detail[];valueLines?:Detail[];discountLines?:Detail[];outstandingLines?:Detail[] };
const group = (lines: Detail[], key: 'doctor'|'department'|'source'): Group[] => {
  const map = new Map<string,Group & {total:bigint}>();
  for (const l of lines) {
    const id = key === 'source' ? l.source ?? '—' : l[key === 'doctor' ? 'doctorId' : 'departmentId'] ?? '—';
    let row = map.get(id);
    if (!row) { row = { id, name: l[key] ?? '—', amount: '0', lines: [], total: 0n }; map.set(id,row); }
    row.total += BigInt(l.amount); row.lines.push(l);
  }
  return [...map.values()].sort((a,b) => a.total > b.total ? -1 : 1).map(({total,...row}) => ({...row,amount:total.toString()}));
};
export function computeReport(data: Records, p: Period): Report {
  const index=indexRecords(data);
  // Task 023: the per-doctor breakdown names only performers who hold the doctor role; others group under "—".
  const doctors=data.doctorIds?new Set(data.doctorIds):null;
  const doctorOf=(l:Row)=>!l.performer_user_id||(doctors&&!doctors.has(l.performer_user_id))?{}:{doctorId:l.performer_user_id as string,doctor:l.doctor as string};
  const details: Record<string,Detail[]> = Object.fromEntries(['patients','new','returning','outpatient','inpatient','value','discounts','outstanding','collected','cash','card','transfer','refunds','cashOuts','net','lab','ward'].map(k=>[k,[]]));
  const add = (k: string, d: Detail) => details[k]!.push(d);
  const needsReview: {id:string;label:string}[]=[];
  const invalid=new Set<string>(),invoices=new Map<string,ReturnType<typeof invoiceAt>>();
  for(const v of data.visits.filter(v=>v.status!=='cancelled')){
    try{invoices.set(v.id,invoiceAt(data,v,p.to));}catch(error){
      if(!(error instanceof DomainError || error instanceof RangeError || error instanceof TypeError))throw error;
      invalid.add(v.id);needsReview.push({id:v.id,label:`${v.patient_no} · ${v.full_name}`});
    }
  }
  const visits = data.visits.filter(v => inRange(v.date,p) && v.status !== 'cancelled' && !invalid.has(v.id));
  const seen = new Set<string>();
  for (const v of visits) {
    // Unique patients in the period; outpatient/inpatient cohorts may overlap.
    const l = { id: v.id, date: v.date, label: `${v.patient_no} · ${v.full_name}`, amount: '1', source: v.acquisition_source ?? '—' };
    for (const k of ['patients', v.first_date >= p.from ? 'new' : 'returning',v.type]) {
      const identity = `${k}:${v.patient_id}`; if (!seen.has(identity)) { add(k,l); seen.add(identity); }
    }
  }
  for (const v of data.visits.filter(v=>invoices.has(v.id))) {
    const lines=invoices.get(v.id)!;
    for (const line of lines) {
      const raw = index.charges.get(line.id)!;
      const d: Detail = { id: line.id,date: serviceDate(raw,data),label: `${v.patient_no} · ${raw.service}`,amount: line.value.toString(),patientId:v.patient_id,
        ...doctorOf(raw),departmentId:raw.department_id,department:raw.department,kind:raw.kind };
      // Zero discounts are not listed (they add nothing and were most of a month's rows).
      if(inRange(d.date,p)){add('value',d);if(line.discount!==0n)add('discounts',{...d,amount:line.discount.toString()});}
      // Without SQL open balances (pure unit tests), derive them from the loaded ledgers.
      if(!data.open && line.payable!==line.allocatedPaid)add('outstanding',{...d,amount:(line.payable-line.allocatedPaid).toString()});
    }
  }
  if(data.open){
    details.outstanding=data.open.visits.lines as Detail[];
    for(const v of data.open.review)if(!needsReview.some(r=>r.id===v.id))needsReview.push(v);
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
    if(invalid.has(l.visit_id))continue;
    revenue.push({id:`${payment.id}:${l.id}`,date:payment.date,label:l.service,amount:(BigInt(a.amount_uzs)*(payment.kind==='payment'?1n:-1n)).toString(),...doctorOf(l),departmentId:l.department_id,department:l.department,kind:l.kind});
  }
  for (const a of data.adjustments) {
    const payment=allPayments.get(a.payment_id), date=localDate(a.created_at,data.clinic.timezone);
    if (!payment || !inRange(date,p)) continue;
    const l=index.charges.get(a.charge_line_id)!;
    if(invalid.has(l.visit_id))continue;
    revenue.push({id:a.id,date,label:l.service,amount:a.delta_uzs,...doctorOf(l),departmentId:l.department_id,department:l.department,kind:l.kind});
  }
  details.lab = revenue.filter(l=>l.kind==='lab'); details.ward = revenue.filter(l=>['bed','caretaker'].includes(l.kind!));
  const performance=(key:'doctor'|'department')=>{
    const revenueGroups=new Map(group(revenue,key).map(g=>[g.id,g])),values=new Map(group(details.value!,key).map(g=>[g.id,g]));
    const discounts=new Map(group(details.discounts!,key).map(g=>[g.id,g]));
    const outstanding=new Map<string,Group>(data.open?data.open[key==='doctor'?'doctors':'departments'].map(g=>[g.id,{...g,lines:g.lines as Detail[]}]):group(details.outstanding!,key).map(g=>[g.id,g]));
    return [...new Set([...values.keys(),...revenueGroups.keys(),...outstanding.keys()])].map(id=>{
      const r=revenueGroups.get(id)??{id,name:(values.get(id)??outstanding.get(id))!.name,amount:'0',lines:[]};
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
/**
 * Bound what the dashboard sends to a browser or phone: each drill-down list keeps its largest rows
 * and folds the others into one remainder row, so every list still sums to its total. A month at
 * 170 visits a day otherwise sent each line up to seven times (36 MB measured, task 024). Exports and
 * the stored day-close snapshot use the full report.
 */
export function capReport(report: Report, top = 100, groupTop = 20): Report {
  const cap = (lines: Detail[] | undefined, n: number): Detail[] | undefined => {
    if (!lines || lines.length <= n) return lines;
    const sorted = [...lines].sort((a,b) => { const x=BigInt(a.amount), y=BigInt(b.amount), ax=x<0n?-x:x, ay=y<0n?-y:y; return ax===ay?0:ax>ay?-1:1; });
    const rest = sorted.slice(n);
    return [...sorted.slice(0,n), { id:'rest', date:report.to, label:'', amount:sum(rest,'amount').toString(), rest:rest.reduce((k,l)=>k+(l.rest??1),0) }];
  };
  const groups = (list: Group[]) => list.map(g => ({ ...g, lines: cap(g.lines,groupTop)!,
    ...(g.patientLines ? { patientLines: cap(g.patientLines,groupTop)!, valueLines: cap(g.valueLines,groupTop)!, discountLines: cap(g.discountLines,groupTop)!, outstandingLines: cap(g.outstandingLines,groupTop)! } : {}) }));
  return { ...report, details: Object.fromEntries(Object.entries(report.details).map(([k,v]) => [k,cap(v,top)!])),
    doctors: groups(report.doctors), departments: groups(report.departments), sources: groups(report.sources) };
}
export async function dashboard(c: ClinicContext,p: Period) {
  await requireRole(c.tx,c.actorId,c.clinicId,['ceo']);
  return computeReport(await records(c,p,{outstanding:true}),p);
}
export async function dayReport(c: ClinicContext,id: string) {
  const ctx=await requireRole(c.tx,c.actorId,c.clinicId,['ceo','administrator','cashier']);
  const day=(await c.tx.query('SELECT id,business_date,status FROM business_days WHERE clinic_id=$1 AND id=$2',[c.clinicId,id])).rows[0];
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
    // Task 023: a cashier sees only their own shifts' totals, never the clinic's day total.
    const total=(await c.tx.query(`SELECT coalesce(sum(p.amount_uzs) FILTER(WHERE p.kind='payment'),0)::text total FROM payments p JOIN cash_shifts s ON s.clinic_id=p.clinic_id AND s.id=p.cash_shift_id
      WHERE p.clinic_id=$1 AND p.business_day_id=$2 AND s.cashier_user_id=$3`,[c.clinicId,id,c.actorId])).rows[0].total;
    return {...p,clinic:(await c.tx.query('SELECT name FROM clinics WHERE id=$1',[c.clinicId])).rows[0].name,generatedAt:new Date().toISOString(),snapshot:day.status==='closed',totals:{collected:total},details:{},doctors:[],departments:[],sources:[],cashShifts} as Report;
  }
  if(day.status==='closed'){
    const snapshot=(await c.tx.query('SELECT close_snapshot FROM business_days WHERE clinic_id=$1 AND id=$2',[c.clinicId,id])).rows[0]?.close_snapshot;
    if(snapshot?.totals)return {...snapshot,snapshot:true} as Report;
  }
  return computeReport(await records(c,p,{outstanding:true}),p);
}
