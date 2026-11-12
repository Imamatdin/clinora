import { z } from 'zod';
import { calculateInvoice, uzs, type Discount, type LineTotal } from '../billing/index.js';
import { DomainError } from '../identity/access.js';
import type { ClinicContext } from '../../server/roles.js';

const date = z.iso.date();
export const Range = z.object({ from: date, to: date }).strict().refine(v => v.from <= v.to &&
  (Date.parse(v.to) - Date.parse(v.from)) / 86400000 <= 366);
export type Period = z.infer<typeof Range>;
export type Row = Record<string, any>;
export type Records = { clinic: Row; version?:string; doctorDiscounts?:Row[]; visits: Row[]; charges: Row[]; discounts: Row[]; payments: Row[]; allocations: Row[]; adjustments: Row[]; cashOuts: Row[]; rules: Row[]; shifts: Row[] };
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
/** Bound the cohort and dates in SQL. Doctor reads return only owned lines, with
 * visit-discount apportionment computed in SQL to retain exact rounding. */
export async function records(c: ClinicContext, p: Period, options: {outstanding?:boolean; doctor?:string|undefined} = {}): Promise<Records> {
  const r = await c.tx.query(`WITH
    bounds AS (SELECT $2::date lo,$3::date hi,($2::date::timestamp AT TIME ZONE timezone) start,
      (($3::date+1)::timestamp AT TIME ZONE timezone) finish FROM clinics WHERE id=$1),
    dated AS NOT MATERIALIZED (SELECT l.*,coalesce(b.charge_date,k.charge_date,r.business_date,(l.created_at AT TIME ZONE c.timezone)::date) service_date
      FROM charge_lines l JOIN clinics c ON c.id=l.clinic_id
      LEFT JOIN bed_day_charges b ON b.clinic_id=l.clinic_id AND b.charge_line_id=l.id
      LEFT JOIN caretaker_day_charges k ON k.clinic_id=l.clinic_id AND k.charge_line_id=l.id
      LEFT JOIN report_charge_dates r ON r.clinic_id=l.clinic_id AND r.charge_line_id=l.id WHERE l.clinic_id=$1),
    activity AS (
      SELECT v.id FROM visits v JOIN business_days d ON d.clinic_id=v.clinic_id AND d.id=v.business_day_id,bounds t WHERE v.clinic_id=$1 AND d.business_date BETWEEN t.lo AND t.hi
      UNION SELECT l.visit_id FROM report_charge_dates r JOIN charge_lines l ON l.clinic_id=r.clinic_id AND l.id=r.charge_line_id,bounds t WHERE r.clinic_id=$1 AND r.business_date BETWEEN t.lo AND t.hi
      UNION SELECT l.visit_id FROM charge_lines l,bounds t WHERE l.clinic_id=$1 AND l.cancelled_at>=t.start AND l.cancelled_at<t.finish
      UNION SELECT p.visit_id FROM payments p JOIN business_days d ON d.clinic_id=p.clinic_id AND d.id=p.business_day_id,bounds t WHERE p.clinic_id=$1 AND d.business_date BETWEEN t.lo AND t.hi
      UNION SELECT d.visit_id FROM discounts d,bounds t WHERE d.clinic_id=$1 AND (d.created_at>=t.start AND d.created_at<t.finish OR d.voided_at>=t.start AND d.voided_at<t.finish)
      UNION SELECT p.visit_id FROM cashier_allocation_adjustments a JOIN payments p ON p.clinic_id=a.clinic_id AND p.id=a.payment_id,bounds t WHERE a.clinic_id=$1 AND a.created_at>=t.start AND a.created_at<t.finish
      UNION SELECT l.visit_id FROM dated l,bounds t WHERE $4 AND l.service_date<=t.hi GROUP BY l.visit_id
        HAVING sum(CASE WHEN l.status='cancelled' AND l.cancelled_at<t.finish THEN 0 ELSE l.quantity*l.unit_price_uzs::numeric END)<>
          coalesce((SELECT sum(CASE WHEN p.kind='payment' THEN p.amount_uzs ELSE -p.amount_uzs END) FROM payments p JOIN business_days d ON d.clinic_id=p.clinic_id AND d.id=p.business_day_id WHERE p.clinic_id=$1 AND p.visit_id=l.visit_id AND d.business_date<=$3::date),0)
    ), selected AS (SELECT id FROM activity WHERE $5::uuid IS NULL OR EXISTS(SELECT 1 FROM charge_lines l WHERE l.clinic_id=$1 AND l.visit_id=activity.id AND l.performer_user_id=$5)),
    ps AS (SELECT p.*,d.business_date::text date FROM payments p JOIN business_days d ON d.id=p.business_day_id AND d.clinic_id=p.clinic_id,bounds t WHERE p.clinic_id=$1 AND p.visit_id IN(SELECT id FROM selected) AND d.business_date<=t.hi)
    SELECT
    (SELECT to_jsonb(x) FROM clinics x WHERE id=$1) clinic,
    coalesce((SELECT version::text FROM report_versions WHERE clinic_id=$1),'0') version,
    CASE WHEN $5::uuid IS NULL THEN NULL ELSE coalesce((SELECT jsonb_agg(x) FROM (
      SELECT day::date::text date,part.charge_line_id,part.discount_uzs::text amount_uzs
      FROM selected v CROSS JOIN generate_series($2::date-1,$3::date,interval '1 day') day
      CROSS JOIN LATERAL report_line_discounts($1,v.id,day::date) part
      JOIN charge_lines l ON l.clinic_id=$1 AND l.id=part.charge_line_id AND l.performer_user_id=$5
    ) x),'[]') END "doctorDiscounts",
    coalesce((SELECT jsonb_agg(x) FROM (SELECT v.*,d.business_date::text date,p.full_name,p.patient_no::text,p.source acquisition_source,
      (SELECT min(b.business_date)::text FROM visits w JOIN business_days b ON b.id=w.business_day_id AND b.clinic_id=w.clinic_id WHERE w.clinic_id=v.clinic_id AND w.patient_id=v.patient_id AND w.status<>'cancelled') first_date
      FROM visits v JOIN business_days d ON d.id=v.business_day_id AND d.clinic_id=v.clinic_id JOIN patients p ON p.id=v.patient_id AND p.clinic_id=v.clinic_id WHERE v.clinic_id=$1 AND v.id IN(SELECT id FROM selected)) x),'[]') visits,
    coalesce((SELECT jsonb_agg(to_jsonb(x)||jsonb_build_object('unit_price_uzs',x.unit_price_uzs::text)) FROM (SELECT l.*,s.kind,s.name_uz_cyrl service,s.department_id,d.name_uz_cyrl department,a.display_name doctor
      FROM dated l JOIN services s ON s.id=l.service_id AND s.clinic_id=l.clinic_id LEFT JOIN departments d ON d.id=s.department_id AND d.clinic_id=s.clinic_id LEFT JOIN accounts a ON a.id=l.performer_user_id,bounds t WHERE l.visit_id IN(SELECT id FROM selected) AND l.service_date<=t.hi AND ($5::uuid IS NULL OR l.performer_user_id=$5)) x),'[]') charges,
    coalesce((SELECT jsonb_agg(to_jsonb(x)||jsonb_build_object('amount_uzs',x.amount_uzs::text)) FROM discounts x,bounds t WHERE clinic_id=$1 AND visit_id IN(SELECT id FROM selected) AND x.created_at<t.finish AND $5::uuid IS NULL),'[]') discounts,
    coalesce((SELECT jsonb_agg(to_jsonb(x)||jsonb_build_object('amount_uzs',x.amount_uzs::text)) FROM ps x),'[]') payments,
    coalesce((SELECT jsonb_agg(to_jsonb(x)||jsonb_build_object('amount_uzs',x.amount_uzs::text)) FROM payment_allocations x WHERE clinic_id=$1 AND payment_id IN(SELECT id FROM ps) AND ($5::uuid IS NULL OR EXISTS(SELECT 1 FROM charge_lines l WHERE l.clinic_id=$1 AND l.id=x.charge_line_id AND l.performer_user_id=$5))),'[]') allocations,
    coalesce((SELECT jsonb_agg(to_jsonb(x)||jsonb_build_object('delta_uzs',x.delta_uzs::text)) FROM cashier_allocation_adjustments x,bounds t WHERE clinic_id=$1 AND payment_id IN(SELECT id FROM ps) AND x.created_at<t.finish AND ($5::uuid IS NULL OR EXISTS(SELECT 1 FROM charge_lines l WHERE l.clinic_id=$1 AND l.id=x.charge_line_id AND l.performer_user_id=$5))),'[]') adjustments,
    coalesce((SELECT jsonb_agg(to_jsonb(x)||jsonb_build_object('amount_uzs',x.amount_uzs::text)) FROM (SELECT o.*,d.business_date::text date FROM cash_outs o JOIN business_days d ON d.id=o.business_day_id AND d.clinic_id=o.clinic_id,bounds t WHERE o.clinic_id=$1 AND $5::uuid IS NULL AND d.business_date BETWEEN t.lo AND t.hi) x),'[]') "cashOuts",
    coalesce((SELECT jsonb_agg(x ORDER BY effective_from DESC) FROM doctor_split_rules x,bounds t WHERE clinic_id=$1 AND effective_from<=t.hi AND ($5::uuid IS NULL OR x.user_id=$5)),'[]') rules,
    coalesce((SELECT jsonb_agg(to_jsonb(x)||jsonb_build_object('opening_cash_uzs',x.opening_cash_uzs::text,'counted_cash_uzs',x.counted_cash_uzs::text)) FROM (SELECT s.*,a.display_name cashier,d.business_date::text date FROM cash_shifts s JOIN accounts a ON a.id=s.cashier_user_id JOIN business_days d ON d.id=s.business_day_id AND d.clinic_id=s.clinic_id,bounds t WHERE s.clinic_id=$1 AND $5::uuid IS NULL AND d.business_date BETWEEN t.lo AND t.hi) x),'[]') shifts`, [c.clinicId,p.from,p.to,options.outstanding??false,options.doctor??null]);
  return r.rows[0] as Records;
}
export const inRange = (date: string, p: Period) => date >= p.from && date <= p.to;
const calendars=new Map<string,Intl.DateTimeFormat>();
export const localDate = (stamp: string, timezone: string) => {let f=calendars.get(timezone);if(!f){f=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'});calendars.set(timezone,f);}return f.format(new Date(stamp));};
export const serviceDate = (line:Row,data:Records):string => line.service_date ?? localDate(line.created_at,data.clinic.timezone);
export const sum = (rows: Row[], field: string) => rows.reduce((n, r) => n + BigInt(r[field]), 0n);
export function invoiceAt(data: Records, visit: Row, until: string): readonly LineTotal[] {
  const dateOf = (v: string) => localDate(v, data.clinic.timezone);
  const ledger=indexRecords(data).ledger.get(visit.id)??{charges:[],discounts:[],payments:[],allocations:[],adjustments:[]};
  const charges = ledger.charges.filter(l => serviceDate(l,data) <= until);
  const ds = ledger.discounts.filter(d => dateOf(d.created_at) <= until && (!d.voided_at || dateOf(d.voided_at) > until));
  const discounts: Discount[] = data.doctorDiscounts ? data.doctorDiscounts.filter(d=>d.date===until && charges.some(l=>l.id===d.charge_line_id && !(l.status==='cancelled' && (!l.cancelled_at || dateOf(l.cancelled_at)<=until)))).map(d=>({kind:'fixed' as const,lineId:d.charge_line_id,amount:uzs(d.amount_uzs),reason:'payroll apportionment',approverId:'report'})) : ds.sort((a,b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)).map(d => ({
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
