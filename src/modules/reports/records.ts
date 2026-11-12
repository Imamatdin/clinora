import { z } from 'zod';
import { calculateInvoice, uzs, type Discount, type LineTotal } from '../billing/index.js';
import { DomainError } from '../identity/access.js';
import type { ClinicContext } from '../../server/roles.js';

const date = z.iso.date();
export const Range = z.object({ from: date, to: date }).strict().refine(v => v.from <= v.to &&
  (Date.parse(v.to) - Date.parse(v.from)) / 86400000 <= 366);
export type Period = z.infer<typeof Range>;
export type Row = Record<string, any>;
export type Records = { clinic: Row; visits: Row[]; charges: Row[]; discounts: Row[]; payments: Row[]; allocations: Row[]; adjustments: Row[]; cashOuts: Row[]; rules: Row[]; shifts: Row[] };
type VisitLedger={charges:Row[];discounts:Row[];payments:Row[];allocations:Row[];adjustments:Row[]};
const cached=new WeakMap<Records,{visits:Map<string,Row>;charges:Map<string,Row>;ledger:Map<string,VisitLedger>}>();
export function indexRecords(data:Records){
  let index=cached.get(data);if(index)return index;
  index={visits:new Map(data.visits.map(v=>[v.id,v])),charges:new Map(data.charges.map(l=>[l.id,l])),ledger:new Map()};
  const ledger=(id:string)=>{let v=index!.ledger.get(id);if(!v){v={charges:[],discounts:[],payments:[],allocations:[],adjustments:[]};index!.ledger.set(id,v);}return v;};
  const paymentVisits=new Map(data.payments.map(p=>[p.id,p.visit_id]));
  for(const row of data.charges)ledger(row.visit_id).charges.push(row);
  for(const row of data.discounts)ledger(row.visit_id).discounts.push(row);
  for(const row of data.payments)ledger(row.visit_id).payments.push(row);
  for(const row of data.allocations)ledger(paymentVisits.get(row.payment_id)!).allocations.push(row);
  for(const row of data.adjustments)ledger(paymentVisits.get(row.payment_id)!).adjustments.push(row);
  cached.set(data,index);return index;
}
/** One SQL statement gives all ledgers the same MVCC snapshot, even during live payments. */
export async function records(c: ClinicContext): Promise<Records> {
  const r = await c.tx.query(`SELECT
    (SELECT to_jsonb(x) FROM clinics x WHERE id=$1) clinic,
    coalesce((SELECT jsonb_agg(x) FROM (SELECT v.*,d.business_date::text date,p.full_name,p.patient_no::text,p.source acquisition_source,
      (SELECT min(b.business_date)::text FROM visits w JOIN business_days b ON b.id=w.business_day_id AND b.clinic_id=w.clinic_id WHERE w.clinic_id=v.clinic_id AND w.patient_id=v.patient_id AND w.status<>'cancelled') first_date
      FROM visits v JOIN business_days d ON d.id=v.business_day_id AND d.clinic_id=v.clinic_id JOIN patients p ON p.id=v.patient_id AND p.clinic_id=v.clinic_id WHERE v.clinic_id=$1) x),'[]') visits,
    coalesce((SELECT jsonb_agg(to_jsonb(x)||jsonb_build_object('unit_price_uzs',x.unit_price_uzs::text)) FROM (SELECT l.*,s.kind,s.name_uz_cyrl service,s.department_id,d.name_uz_cyrl department,a.display_name doctor
      FROM charge_lines l JOIN services s ON s.id=l.service_id AND s.clinic_id=l.clinic_id LEFT JOIN departments d ON d.id=s.department_id AND d.clinic_id=s.clinic_id LEFT JOIN accounts a ON a.id=l.performer_user_id WHERE l.clinic_id=$1) x),'[]') charges,
    coalesce((SELECT jsonb_agg(to_jsonb(x)||jsonb_build_object('amount_uzs',x.amount_uzs::text)) FROM discounts x WHERE clinic_id=$1),'[]') discounts,
    coalesce((SELECT jsonb_agg(to_jsonb(x)||jsonb_build_object('amount_uzs',x.amount_uzs::text)) FROM (SELECT p.*,d.business_date::text date FROM payments p JOIN business_days d ON d.id=p.business_day_id AND d.clinic_id=p.clinic_id WHERE p.clinic_id=$1) x),'[]') payments,
    coalesce((SELECT jsonb_agg(to_jsonb(x)||jsonb_build_object('amount_uzs',x.amount_uzs::text)) FROM payment_allocations x WHERE clinic_id=$1),'[]') allocations,
    coalesce((SELECT jsonb_agg(to_jsonb(x)||jsonb_build_object('delta_uzs',x.delta_uzs::text)) FROM cashier_allocation_adjustments x WHERE clinic_id=$1),'[]') adjustments,
    coalesce((SELECT jsonb_agg(to_jsonb(x)||jsonb_build_object('amount_uzs',x.amount_uzs::text)) FROM (SELECT o.*,d.business_date::text date FROM cash_outs o JOIN business_days d ON d.id=o.business_day_id AND d.clinic_id=o.clinic_id WHERE o.clinic_id=$1) x),'[]') "cashOuts",
    coalesce((SELECT jsonb_agg(x ORDER BY effective_from DESC) FROM doctor_split_rules x WHERE clinic_id=$1),'[]') rules,
    coalesce((SELECT jsonb_agg(x) FROM cash_shifts x WHERE clinic_id=$1),'[]') shifts`, [c.clinicId]);
  return r.rows[0] as Records;
}
export const inRange = (date: string, p: Period) => date >= p.from && date <= p.to;
const calendars=new Map<string,Intl.DateTimeFormat>();
export const localDate = (stamp: string, timezone: string) => {let f=calendars.get(timezone);if(!f){f=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'});calendars.set(timezone,f);}return f.format(new Date(stamp));};
export const sum = (rows: Row[], field: string) => rows.reduce((n, r) => n + BigInt(r[field]), 0n);
export function invoiceAt(data: Records, visit: Row, until: string): readonly LineTotal[] {
  const dateOf = (v: string) => localDate(v, data.clinic.timezone);
  const ledger=indexRecords(data).ledger.get(visit.id)??{charges:[],discounts:[],payments:[],allocations:[],adjustments:[]};
  const charges = ledger.charges.filter(l => dateOf(l.created_at) <= until);
  const ds = ledger.discounts.filter(d => dateOf(d.created_at) <= until && (!d.voided_at || dateOf(d.voided_at) > until));
  const discounts: Discount[] = ds.sort((a,b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)).map(d => ({
    reason: d.reason, approverId: d.approved_by, ...(d.charge_line_id ? { lineId: d.charge_line_id } : {}),
    ...(d.kind === 'fixed' ? { kind: 'fixed' as const, amount: uzs(d.amount_uzs) } : { kind: 'percent' as const, basisPoints: d.percent_bp })
  }));
  const invoice = calculateInvoice(charges.sort((a,b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)).map(l => ({
    id: l.id, unitPrice: uzs(l.unit_price_uzs), quantity: l.quantity,
    status: l.cancelled_at && dateOf(l.cancelled_at) > until ? 'ordered' : l.status,
    category: l.kind, ...(l.performer_user_id ? { doctorId: l.performer_user_id } : {})
  })), discounts, []);
  const payments = new Map(ledger.payments.filter(p => p.date <= until).map(p => [p.id, p]));
  const allocated = new Map<string,bigint>();
  for (const a of ledger.allocations) {
    const p = payments.get(a.payment_id); if (!p) continue;
    allocated.set(a.charge_line_id, (allocated.get(a.charge_line_id) ?? 0n) + BigInt(a.amount_uzs) * (p.kind === 'payment' ? 1n : -1n));
  }
  for (const a of ledger.adjustments) if (payments.has(a.payment_id) && dateOf(a.created_at) <= until)
    allocated.set(a.charge_line_id, (allocated.get(a.charge_line_id) ?? 0n) + BigInt(a.delta_uzs));
  return invoice.lines.map(l => {
    const paid = allocated.get(l.id) ?? 0n;
    if (paid < 0n || paid > l.payable) throw new DomainError('INVALID_TRANSITION');
    return { ...l, allocatedPaid: uzs(paid) };
  });
}
