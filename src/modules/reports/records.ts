import { z } from 'zod';
import { calculateInvoice, uzs, type Discount, type LineTotal } from '../billing/index.js';
import { DomainError } from '../identity/access.js';
import type { ClinicContext } from '../../server/roles.js';

const date = z.iso.date();
export const Range = z.object({ from: date, to: date }).strict().refine(v => v.from <= v.to &&
  (Date.parse(v.to) - Date.parse(v.from)) / 86400000 <= 366);
export type Period = z.infer<typeof Range>;
export type Row = Record<string, any>;
export type Records = { clinic: Row; version?:string; doctorDiscounts?:Row[]; activities?:Row[]; open?:OpenBalances; visits: Row[]; charges: Row[]; discounts: Row[]; payments: Row[]; allocations: Row[]; adjustments: Row[]; cashOuts: Row[]; rules: Row[]; shifts: Row[] };
type VisitLedger={charges:Row[];discounts:Row[];payments:Row[];allocations:Row[];adjustments:Row[]};
const scopedDiscounts=new WeakMap<Records,Map<string,Map<string,string>>>();
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
/** Group of open balances (a doctor, a department, or the whole clinic): the largest visits by
 * amount plus one remainder row, so the sum of `lines` always equals `amount`. */
export type OpenGroup = { id: string; name: string; amount: string; lines: Row[] };
export type OpenBalances = { total: string; visits: OpenGroup; doctors: OpenGroup[]; departments: OpenGroup[]; review: { id: string; label: string }[] };
/** Rows listed per group before the rest collapses into one remainder row. */
export const OPEN_TOP = { clinic: 100, group: 20 };
const BOUNDS = `bounds AS (SELECT $2::date lo,$3::date hi,($2::date::timestamp AT TIME ZONE timezone) start,
  (($3::date+1)::timestamp AT TIME ZONE timezone) finish,timezone FROM clinics WHERE id=$1)`;
/** Visits with ledger activity inside the range, each source read through its own index. */
const EVENTS = `events AS (
  SELECT v.id,d.business_date date FROM business_days d JOIN visits v ON v.clinic_id=d.clinic_id AND v.business_day_id=d.id,bounds t WHERE d.clinic_id=$1 AND d.business_date BETWEEN t.lo AND t.hi
  UNION SELECT l.visit_id,r.business_date FROM report_charge_dates r JOIN charge_lines l ON l.clinic_id=r.clinic_id AND l.id=r.charge_line_id,bounds t WHERE r.clinic_id=$1 AND r.business_date BETWEEN t.lo AND t.hi
  UNION SELECT l.visit_id,(l.cancelled_at AT TIME ZONE t.timezone)::date FROM charge_lines l,bounds t WHERE l.clinic_id=$1 AND l.cancelled_at>=t.start AND l.cancelled_at<t.finish
  UNION SELECT p.visit_id,d.business_date FROM business_days d JOIN payments p ON p.clinic_id=d.clinic_id AND p.business_day_id=d.id,bounds t WHERE d.clinic_id=$1 AND d.business_date BETWEEN t.lo AND t.hi
  UNION SELECT d.visit_id,(d.created_at AT TIME ZONE t.timezone)::date FROM discounts d,bounds t WHERE d.clinic_id=$1 AND d.created_at>=t.start AND d.created_at<t.finish
  UNION SELECT d.visit_id,(d.voided_at AT TIME ZONE t.timezone)::date FROM discounts d,bounds t WHERE d.clinic_id=$1 AND d.voided_at>=t.start AND d.voided_at<t.finish
  UNION SELECT p.visit_id,(a.created_at AT TIME ZONE t.timezone)::date FROM cashier_allocation_adjustments a JOIN payments p ON p.clinic_id=a.clinic_id AND p.id=a.payment_id,bounds t WHERE a.clinic_id=$1 AND a.created_at>=t.start AND a.created_at<t.finish
)`;
/** Read only the visits active in the range (plus, for the dashboard and day close, open balances
 * computed in SQL). Doctor reads return only owned lines, with visit-discount apportionment
 * computed in SQL to retain exact rounding. Every query is bounded by the range or by an index. */
/** ISO-8601 UTC text for a timestamptz: string-sortable and parsed by Date (plain rows would give Date objects). */
const iso = (col: string, as = col.split('.').pop()!) => `to_char(${col} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') ${as}`;
export async function records(c: ClinicContext, p: Period, options: {outstanding?:boolean; doctor?:string|undefined} = {}): Promise<Records> {
  const doctor = options.doctor ?? null, q = async (sql: string, params: unknown[]) => (await c.tx.query(sql, params)).rows;
  // Several statements, one READ COMMITTED transaction: the ledger version is read first, so any write
  // that a later statement sees has already moved it, and day close (which re-checks the version under
  // the day lock) rejects a snapshot that mixes states.
  const head = (await q(`SELECT (SELECT to_jsonb(x) FROM clinics x WHERE id=$1) clinic,
    coalesce((SELECT version::text FROM report_versions WHERE clinic_id=$1),'0') version`, [c.clinicId]))[0]!;
  let cohort = await q(`WITH ${BOUNDS}, ${EVENTS} SELECT e.id,e.date::text date FROM events e`, [c.clinicId,p.from,p.to]) as {id:string;date:string}[];
  let ids = [...new Set(cohort.map(r=>r.id))];
  if (doctor) {
    // Probe (clinic, performer, visit) per cohort visit; never scan the doctor's whole history.
    const own = new Set((await q(`SELECT v FROM unnest($2::uuid[]) v
      WHERE EXISTS(SELECT 1 FROM charge_lines l WHERE l.clinic_id=$1 AND l.performer_user_id=$3 AND l.visit_id=v)`,[c.clinicId,ids,doctor])).map(r=>r.v as string));
    cohort = cohort.filter(e=>own.has(e.id)); ids = ids.filter(id=>own.has(id));
  }
  const args = [c.clinicId,p.from,p.to,ids,doctor];
  const visits = await q(`WITH firsts AS (SELECT w.patient_id,min(b.business_date)::text first_date FROM visits w JOIN business_days b ON b.id=w.business_day_id AND b.clinic_id=w.clinic_id
      WHERE w.clinic_id=$1 AND w.status<>'cancelled' AND w.patient_id IN (SELECT patient_id FROM visits WHERE clinic_id=$1 AND id=ANY($2::uuid[])) GROUP BY w.patient_id)
    SELECT v.id,v.patient_id,v.type,v.status,${iso('v.created_at')},${iso('v.closed_at')},d.business_date::text date,p.full_name,p.patient_no::text,p.source acquisition_source,f.first_date
    FROM visits v JOIN business_days d ON d.id=v.business_day_id AND d.clinic_id=v.clinic_id JOIN patients p ON p.id=v.patient_id AND p.clinic_id=v.clinic_id
    LEFT JOIN firsts f ON f.patient_id=v.patient_id WHERE v.clinic_id=$1 AND v.id=ANY($2::uuid[])`, [c.clinicId,ids]);
  // report_charge_dates holds the service date of every line (task 021 triggers copy bed and caretaker
  // charge dates into it); the creation date is only a fallback for rows that predate it.
  const charges = await q(`WITH ${BOUNDS}, dated AS (SELECT l.*,coalesce(r.business_date,(l.created_at AT TIME ZONE t.timezone)::date) service_date
      FROM charge_lines l CROSS JOIN bounds t LEFT JOIN report_charge_dates r ON r.clinic_id=l.clinic_id AND r.charge_line_id=l.id
      WHERE l.clinic_id=$1 AND l.visit_id=ANY($4::uuid[]))
    SELECT l.id,l.visit_id,l.service_id,l.performer_user_id,l.quantity,l.unit_price_uzs::text unit_price_uzs,l.status,l.source,
      ${iso('l.created_at')},${iso('l.completed_at')},${iso('l.cancelled_at')},l.service_date::text service_date,
      s.kind,s.name_uz_cyrl service,s.department_id,d.name_uz_cyrl department,a.display_name doctor
    FROM dated l JOIN services s ON s.id=l.service_id AND s.clinic_id=l.clinic_id LEFT JOIN departments d ON d.id=s.department_id AND d.clinic_id=s.clinic_id
    LEFT JOIN accounts a ON a.id=l.performer_user_id,bounds t WHERE l.service_date<=t.hi AND ($5::uuid IS NULL OR l.performer_user_id=$5)`, args);
  const PAID = `${BOUNDS}, ps AS (SELECT p.*,d.business_date FROM payments p JOIN business_days d ON d.id=p.business_day_id AND d.clinic_id=p.clinic_id,bounds t
      WHERE p.clinic_id=$1 AND p.visit_id=ANY($4::uuid[]) AND d.business_date<=t.hi)`;
  const payments = await q(`WITH ${PAID} SELECT id,visit_id,cash_shift_id,business_day_id,kind,method,amount_uzs::text amount_uzs,refund_of,${iso('created_at')},business_date::text date
    FROM ps`, args.slice(0,4));
  const allocations = await q(`WITH ${PAID} SELECT x.payment_id,x.charge_line_id,x.amount_uzs::text amount_uzs FROM payment_allocations x JOIN ps ON ps.id=x.payment_id
    WHERE $5::uuid IS NULL OR EXISTS(SELECT 1 FROM charge_lines l WHERE l.clinic_id=$1 AND l.id=x.charge_line_id AND l.performer_user_id=$5)`, args);
  const rest = (await q(`WITH ${PAID}
    SELECT CASE WHEN $5::uuid IS NULL THEN NULL ELSE coalesce((SELECT json_agg(x) FROM (
      SELECT part.day::text date,part.charge_line_id,part.discount::text amount_uzs
      FROM report_line_parts($1,$4::uuid[],$2::date-1,$3::date) part
      JOIN charge_lines l ON l.clinic_id=$1 AND l.id=part.charge_line_id AND l.performer_user_id=$5
    ) x),'[]') END "doctorDiscounts",
    coalesce((SELECT json_agg(x) FROM (SELECT d.id,d.visit_id,d.charge_line_id,d.kind,d.percent_bp,d.amount_uzs::text amount_uzs,d.reason,d.approved_by,${iso('d.created_at')},${iso('d.voided_at')}
      FROM discounts d,bounds t WHERE d.clinic_id=$1 AND d.visit_id=ANY($4::uuid[]) AND d.created_at<t.finish AND $5::uuid IS NULL) x),'[]') discounts,
    coalesce((SELECT json_agg(y) FROM (SELECT x.id,x.payment_id,x.charge_line_id,x.discount_id,x.delta_uzs::text delta_uzs,${iso('x.created_at')}
      FROM cashier_allocation_adjustments x JOIN ps ON ps.id=x.payment_id,bounds t WHERE x.clinic_id=$1 AND x.created_at<t.finish
      AND ($5::uuid IS NULL OR EXISTS(SELECT 1 FROM charge_lines l WHERE l.clinic_id=$1 AND l.id=x.charge_line_id AND l.performer_user_id=$5))) y),'[]') adjustments,
    coalesce((SELECT json_agg(x) FROM (SELECT o.id,o.cash_shift_id,o.business_day_id,o.amount_uzs::text amount_uzs,o.note,${iso('o.created_at')},d.business_date::text date
      FROM cash_outs o JOIN business_days d ON d.id=o.business_day_id AND d.clinic_id=o.clinic_id,bounds t WHERE o.clinic_id=$1 AND $5::uuid IS NULL AND d.business_date BETWEEN t.lo AND t.hi) x),'[]') "cashOuts",
    coalesce((SELECT jsonb_agg(x ORDER BY effective_from DESC) FROM doctor_split_rules x,bounds t WHERE clinic_id=$1 AND effective_from<=t.hi AND ($5::uuid IS NULL OR x.user_id=$5)),'[]') rules,
    coalesce((SELECT json_agg(x) FROM (SELECT s.id,s.cash_desk_id,s.business_day_id,s.cashier_user_id,s.opening_cash_uzs::text opening_cash_uzs,s.counted_cash_uzs::text counted_cash_uzs,s.status,
        a.display_name cashier,d.business_date::text date
      FROM cash_shifts s JOIN accounts a ON a.id=s.cashier_user_id JOIN business_days d ON d.id=s.business_day_id AND d.clinic_id=s.clinic_id,bounds t
      WHERE s.clinic_id=$1 AND $5::uuid IS NULL AND d.business_date BETWEEN t.lo AND t.hi) x),'[]') shifts`, args))[0]!;
  const data = { clinic: head.clinic, version: head.version, visits, charges, payments, allocations, ...rest } as Records;
  if (doctor) data.activities = cohort.map(e=>({visit_id:e.id,date:e.date}));
  if (options.outstanding && !doctor) data.open = await openBalances(c, p);
  return data;
}

/**
 * Exact open balances as of the end of the range, aggregated in SQL. Candidates are visits flagged
 * open now (report_visit_open, maintained by triggers) plus visits with ledger activity after the
 * range: only those can have a different balance "as of then". Lines come from report_line_parts
 * (the invoice arithmetic), paid amounts from allocations dated on or before the end of the range.
 * The result is bounded: totals per doctor and department plus the largest visits in each.
 */
export async function openBalances(c: ClinicContext, p: Period): Promise<OpenBalances> {
  const r = await c.tx.query(`WITH ${BOUNDS},
    candidates AS (
      SELECT visit_id FROM report_visit_open WHERE clinic_id=$1 AND open
      UNION SELECT l.visit_id FROM report_charge_dates r JOIN charge_lines l ON l.clinic_id=r.clinic_id AND l.id=r.charge_line_id,bounds t WHERE r.clinic_id=$1 AND r.business_date>t.hi
      UNION SELECT l.visit_id FROM charge_lines l,bounds t WHERE l.clinic_id=$1 AND l.cancelled_at>=t.finish
      UNION SELECT p.visit_id FROM business_days d JOIN payments p ON p.clinic_id=d.clinic_id AND p.business_day_id=d.id,bounds t WHERE d.clinic_id=$1 AND d.business_date>t.hi
      UNION SELECT d.visit_id FROM discounts d,bounds t WHERE d.clinic_id=$1 AND d.created_at>=t.finish
      UNION SELECT d.visit_id FROM discounts d,bounds t WHERE d.clinic_id=$1 AND d.voided_at>=t.finish
      UNION SELECT p.visit_id FROM cashier_allocation_adjustments a JOIN payments p ON p.clinic_id=a.clinic_id AND p.id=a.payment_id,bounds t WHERE a.clinic_id=$1 AND a.created_at>=t.finish
    ),
    -- Cancelled visits are excluded from reports (computeReport) and so from open balances.
    -- (OFFSET 0 keeps this a per-candidate primary-key probe instead of a hash of every visit.)
    cohort AS (SELECT array_agg(c.visit_id) ids FROM candidates c JOIN visits v ON v.clinic_id=$1 AND v.id=c.visit_id WHERE v.status<>'cancelled'),
    parts AS (SELECT * FROM report_line_parts($1,(SELECT ids FROM cohort),$3::date,$3::date)),
    paid AS (
      SELECT x.charge_line_id,sum(x.amount) amount FROM (
        SELECT a.charge_line_id,CASE WHEN p.kind='payment' THEN a.amount_uzs ELSE -a.amount_uzs END amount
        FROM payments p JOIN business_days d ON d.clinic_id=p.clinic_id AND d.id=p.business_day_id JOIN payment_allocations a ON a.payment_id=p.id,bounds t
        WHERE p.clinic_id=$1 AND p.visit_id=ANY((SELECT ids FROM cohort)::uuid[]) AND d.business_date<=t.hi
        UNION ALL SELECT a.charge_line_id,a.delta_uzs FROM payments p JOIN business_days d ON d.clinic_id=p.clinic_id AND d.id=p.business_day_id
          JOIN cashier_allocation_adjustments a ON a.clinic_id=p.clinic_id AND a.payment_id=p.id,bounds t
        WHERE p.clinic_id=$1 AND p.visit_id=ANY((SELECT ids FROM cohort)::uuid[]) AND d.business_date<=t.hi AND a.created_at<t.finish
      ) x GROUP BY x.charge_line_id
    ),
    lines AS (SELECT q.visit_id,q.charge_line_id,q.service_id,q.performer_user_id,q.payable,coalesce(y.amount,0) paid,q.review FROM parts q LEFT JOIN paid y ON y.charge_line_id=q.charge_line_id),
    -- calculateInvoice rejects these visits (INVALID_TRANSITION / TypeError): list them for review.
    review AS (SELECT DISTINCT visit_id FROM lines WHERE review OR paid<0 OR paid>payable),
    owed AS (
      SELECT l.visit_id,l.payable-l.paid amount,l.performer_user_id doctor_id,a.display_name doctor,s.department_id,dp.name_uz_cyrl department
      FROM lines l JOIN services s ON s.clinic_id=$1 AND s.id=l.service_id
      LEFT JOIN accounts a ON a.id=l.performer_user_id LEFT JOIN departments dp ON dp.clinic_id=$1 AND dp.id=s.department_id
      WHERE l.payable<>l.paid AND l.visit_id NOT IN (SELECT visit_id FROM review)
    ),
    grouped AS (
      SELECT 'clinic' dim,'all' key,'' name,visit_id,sum(amount) amount FROM owed GROUP BY visit_id
      UNION ALL SELECT 'doctor',coalesce(doctor_id::text,'—'),coalesce(max(doctor),'—'),visit_id,sum(amount) FROM owed GROUP BY doctor_id,visit_id
      UNION ALL SELECT 'department',coalesce(department_id::text,'—'),coalesce(max(department),'—'),visit_id,sum(amount) FROM owed GROUP BY department_id,visit_id
    ),
    ranked AS (SELECT g.*,row_number() OVER (PARTITION BY dim,key ORDER BY amount DESC,visit_id) n,
      max(name) OVER (PARTITION BY dim,key) group_name FROM grouped g WHERE amount<>0),
    -- Labels only for the listed visits, not for every open balance.
    labels AS (SELECT v.id,d.business_date::text date,p.patient_no||' · '||p.full_name label,v.patient_id
      FROM visits v JOIN business_days d ON d.clinic_id=v.clinic_id AND d.id=v.business_day_id JOIN patients p ON p.clinic_id=v.clinic_id AND p.id=v.patient_id
      WHERE v.clinic_id=$1 AND v.id IN (SELECT visit_id FROM ranked WHERE n<=CASE WHEN dim='clinic' THEN $4::int ELSE $5::int END UNION SELECT visit_id FROM review)),
    groups AS (
      SELECT dim,key,group_name name,sum(amount)::text amount,
        jsonb_agg(jsonb_build_object('id',r.visit_id,'date',b.date,'label',b.label,'amount',r.amount::text,'patientId',b.patient_id) ORDER BY n)
          FILTER (WHERE n<=CASE WHEN dim='clinic' THEN $4::int ELSE $5::int END) top,
        count(*) FILTER (WHERE n>CASE WHEN dim='clinic' THEN $4::int ELSE $5::int END) rest_count,
        coalesce(sum(amount) FILTER (WHERE n>CASE WHEN dim='clinic' THEN $4::int ELSE $5::int END),0)::text rest_amount
      FROM ranked r LEFT JOIN labels b ON b.id=r.visit_id GROUP BY dim,key,group_name
    )
    SELECT coalesce((SELECT sum(amount) FROM owed),0)::text total,
      coalesce((SELECT jsonb_agg(g) FROM groups g),'[]') groups,
      coalesce((SELECT jsonb_agg(jsonb_build_object('id',b.id,'label',b.label)) FROM review w JOIN labels b ON b.id=w.visit_id),'[]') review`,
    [c.clinicId,p.from,p.to,OPEN_TOP.clinic,OPEN_TOP.group]);
  const row = r.rows[0];
  const toGroup = (g: Row): OpenGroup => {
    const lines: Row[] = [...(g.top ?? [])];
    if (Number(g.rest_count) > 0) lines.push({ id: 'rest', date: p.to, label: '', amount: g.rest_amount, rest: Number(g.rest_count) });
    return { id: g.key, name: g.name, amount: g.amount, lines };
  };
  const groups = (row.groups as Row[]);
  const clinic = groups.find(g => g.dim === 'clinic');
  return { total: row.total, review: row.review,
    visits: clinic ? toGroup(clinic) : { id: 'all', name: '', amount: '0', lines: [] },
    doctors: groups.filter(g => g.dim === 'doctor').map(toGroup), departments: groups.filter(g => g.dim === 'department').map(toGroup) };
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
  let scoped:Map<string,string>|undefined;
  if(data.doctorDiscounts){
    let dates=scopedDiscounts.get(data);
    if(!dates){dates=new Map();for(const d of data.doctorDiscounts){const parts=dates.get(d.date)??new Map<string,string>();parts.set(d.charge_line_id,d.amount_uzs);dates.set(d.date,parts);}scopedDiscounts.set(data,dates);}
    scoped=dates.get(until)??new Map();
  }
  const discounts: Discount[] = scoped ? charges.filter(l=>!(l.status==='cancelled' && (!l.cancelled_at || dateOf(l.cancelled_at)<=until))).map(l=>({kind:'fixed' as const,lineId:l.id,amount:uzs(scoped!.get(l.id)??'0'),reason:'payroll apportionment',approverId:'report'})) : ds.sort((a,b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)).map(d => ({
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
