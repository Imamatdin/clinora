import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../identity/access.js';
import { calculateInvoice, countBedDays, uzs, type BedDayRule, type Discount } from '../billing/index.js';
import { requireRole, recordAudit, type ClinicContext } from '../../server/roles.js';
import { verifyApproverPin } from '../identity/approval-pin.js';
import { priceAt } from '../../server/repo/prices.js';
import { dispense } from '../pharmacy/actions.js';
import { AdmitInput, TransferInput, ServiceInput, CaretakerInput, DailyInput, KeyInput, ChangeRuleInput, RuleInput, type InvoiceView, type WardView } from './contracts.js';

export const WARD = ['ceo','administrator','inpatient'] as const;
export const READ = [...WARD,'cashier','doctor'] as const;
const fail = (code:ConstructorParameters<typeof DomainError>[0]):never => {throw new DomainError(code);};
const parse = <T>(s:z.ZodType<T>, v:unknown):T => {const r=s.safeParse(v);return r.success?r.data:fail('INVALID_INPUT');};
const json = (v:unknown) => JSON.stringify(v, (_k,x)=>typeof x==='bigint'?x.toString():x);
// All inpatient writers take the same clinic lock before any admission/bed locks. This also
// serializes daily runs against transfers/discharge, and requests with different retry keys.
async function guard(ctx:ClinicContext, roles:readonly ('ceo'|'administrator'|'inpatient'|'doctor'|'cashier')[]=WARD) {
  await ctx.tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,11011))',[ctx.clinicId]);
  ctx.roles=(await requireRole(ctx.tx,ctx.actorId,ctx.clinicId,roles)).roles;
}
async function clock(ctx:ClinicContext) {
  // Transaction start may precede a wait for another transfer. Use the clock after acquiring
  // our locks so assignment intervals cannot run backwards under concurrent requests.
  return (await ctx.tx.query("WITH t AS MATERIALIZED (SELECT clock_timestamp() instant) SELECT timezone,(instant AT TIME ZONE timezone)::date::text today,instant FROM clinics CROSS JOIN t WHERE id=$1",[ctx.clinicId])).rows[0]!;
}
async function retry<T>(ctx:ClinicContext,key:string,payload:unknown,fn:()=>Promise<T>):Promise<T> {
  const old=(await ctx.tx.query('SELECT payload=$4::jsonb matches,result FROM inpatient_requests WHERE clinic_id=$1 AND actor_id=$2 AND key=$3',[ctx.clinicId,ctx.actorId,key,json(payload)])).rows[0];
  if(old) return old.matches?old.result:fail('IDEMPOTENCY_CONFLICT');
  const result=await fn();
  await ctx.tx.query('INSERT INTO inpatient_requests(clinic_id,actor_id,key,payload,result) VALUES($1,$2,$3,$4,$5)',[ctx.clinicId,ctx.actorId,key,json(payload),json(result)]);
  return result;
}
async function stay(ctx:ClinicContext,id:string,active=true) {
  // Cashier, pharmacy and surgery lock the visit first. Follow the same order before
  // taking the admission lock, including reads that produce a consistent invoice.
  const ref=(await ctx.tx.query('SELECT visit_id FROM admissions WHERE clinic_id=$1 AND id=$2',[ctx.clinicId,id])).rows[0];
  if(!ref)return fail('NOT_FOUND');
  await ctx.tx.query('SELECT id FROM visits WHERE clinic_id=$1 AND id=$2 FOR UPDATE',[ctx.clinicId,ref.visit_id]);
  const row=(await ctx.tx.query(`SELECT a.*,v.patient_id,v.status visit_status,
    (a.admitted_at AT TIME ZONE c.timezone)::date::text admission_date,
    (a.discharged_at AT TIME ZONE c.timezone)::date::text discharge_date
    FROM admissions a JOIN visits v ON v.id=a.visit_id JOIN clinics c ON c.id=a.clinic_id
    WHERE a.clinic_id=$1 AND a.id=$2 FOR UPDATE OF a`,[ctx.clinicId,id])).rows[0];
  if(!row) return fail('NOT_FOUND');
  if(active && (row.status!=='admitted'||row.visit_status!=='open')) return fail('INVALID_TRANSITION');
  return row;
}
async function openBusinessDay(ctx:ClinicContext) {
  const row=(await ctx.tx.query("SELECT id FROM business_days WHERE clinic_id=$1 AND status='open' FOR SHARE",[ctx.clinicId])).rows[0];
  if(!row)return fail('INVALID_TRANSITION');return row.id as string;
}
async function freeBed(ctx:ClinicContext,id:string,department:string) {
  const row=(await ctx.tx.query(`SELECT b.* FROM beds b JOIN rooms r ON r.id=b.room_id
    JOIN services s ON s.id=b.bed_service_id WHERE b.clinic_id=$1 AND b.id=$2
    AND b.is_active AND r.is_active AND (r.department_id=$3 OR r.department_id IS NULL) AND s.is_active AND s.kind='bed'
    AND NOT EXISTS(SELECT 1 FROM bed_assignments ba WHERE ba.bed_id=b.id AND ba.to_at IS NULL) FOR UPDATE OF b`,[ctx.clinicId,id,department])).rows[0];
  if(!row)return fail('INVALID_TRANSITION');return row;
}
async function ruleAt(ctx:ClinicContext,date:string):Promise<BedDayRule> {
  const row=(await ctx.tx.query('SELECT rule FROM inpatient_rule_history WHERE clinic_id=$1 AND effective_date<=$2 ORDER BY effective_date DESC,sequence DESC LIMIT 1',[ctx.clinicId,date])).rows[0];
  return parse(RuleInput,row?.rule);
}
/** `pricedAt` picks the price (a bed day uses its own date's price). created_at/completed_at are
 * always the real posting time; the billed date of a bed or caretaker day lives in its charge_date. */
async function line(ctx:ClinicContext,visit:string,service:string,quantity:number,pricedAt:Date,source:string) {
  const price=await priceAt(ctx.tx,ctx.clinicId,service,pricedAt);if(!price)return fail('INVALID_INPUT');
  const id=randomUUID(),postedAt=(await clock(ctx)).instant;
  await ctx.tx.query(`INSERT INTO charge_lines(id,clinic_id,visit_id,service_id,quantity,unit_price_uzs,status,source,created_by,created_at,completed_by,completed_at)
    VALUES($1,$2,$3,$4,$5,$6,'completed',$7,$8,$9,$8,$9)`,[id,ctx.clinicId,visit,service,quantity,price.priceUzs.toString(),source,ctx.actorId,postedAt]);
  return id;
}
/**
 * A CEO/administrator approves an out-of-stock ward dispense by typing their PIN on the same shared PC.
 * Task 022: the PIN goes through the one approver counter shared with cashier approvals (identity/approval-pin.ts):
 * five failures from any device lock approving until a CEO or another administrator clears it. The stay and
 * service are checked first, so a guess is never counted against nothing. The caller must commit before
 * reporting a refusal so the counter is never rolled back.
 */
async function approveOverride(ctx:ClinicContext,stayId:string,serviceId:string,o:{approverId:string;pin:string}):Promise<string|null> {
  if(!ctx.deviceId||!(await ctx.tx.query('SELECT 1 FROM devices WHERE id=$1 AND clinic_id=$2 AND revoked_at IS NULL',[ctx.deviceId,ctx.clinicId])).rowCount)return null;
  if(!(await ctx.tx.query("SELECT 1 FROM admissions WHERE clinic_id=$1 AND id=$2 AND status='admitted'",[ctx.clinicId,stayId])).rowCount)return fail('NOT_FOUND');
  if(!(await ctx.tx.query('SELECT 1 FROM services WHERE clinic_id=$1 AND id=$2 AND is_active',[ctx.clinicId,serviceId])).rowCount)return fail('INVALID_INPUT');
  if(await verifyApproverPin(ctx,o.approverId,o.pin))return o.approverId;
  await recordAudit(ctx.tx,ctx.actorId,ctx.clinicId,'inpatient.override_failed',o.approverId,{deviceId:ctx.deviceId});
  return null;
}

export async function ward(ctx:ClinicContext):Promise<WardView> {
  ctx.roles=(await requireRole(ctx.tx,ctx.actorId,ctx.clinicId,READ)).roles;
  const c=await clock(ctx);
  // Doctors get only their assigned stays, never the clinic bed map, pending visits or other names.
  const doctorOnly=ctx.roles.includes('doctor')&&!ctx.roles.some(r=>(WARD as readonly string[]).includes(r)||r==='cashier');
  const [beds,visits,departments,doctors,services,admissions,settings]=await Promise.all([
    doctorOnly?{rows:[]}:ctx.tx.query(`SELECT b.id,r.name room,b.label,r.department_id,ba.admission_id,p.full_name patient FROM beds b JOIN rooms r ON r.id=b.room_id
      LEFT JOIN bed_assignments ba ON ba.bed_id=b.id AND ba.to_at IS NULL LEFT JOIN admissions a ON a.id=ba.admission_id
      LEFT JOIN visits v ON v.id=a.visit_id LEFT JOIN patients p ON p.id=v.patient_id
      WHERE b.clinic_id=$1 AND b.is_active AND r.is_active ORDER BY r.name,b.label`,[ctx.clinicId]),
    doctorOnly?{rows:[]}:ctx.tx.query(`SELECT v.id,p.full_name patient,p.patient_no FROM visits v JOIN patients p ON p.id=v.patient_id
      WHERE v.clinic_id=$1 AND v.type='inpatient' AND v.status='open' AND NOT EXISTS(SELECT 1 FROM admissions a WHERE a.visit_id=v.id) ORDER BY v.created_at`,[ctx.clinicId]),
    ctx.tx.query('SELECT id,name_uz_cyrl name FROM departments WHERE clinic_id=$1 AND is_active ORDER BY name_uz_cyrl',[ctx.clinicId]),
    ctx.tx.query(`SELECT m.user_id id,a.display_name name FROM memberships m JOIN accounts a ON a.id=m.user_id
      JOIN doctor_profiles dp ON dp.clinic_id=m.clinic_id AND dp.user_id=m.user_id
      WHERE m.clinic_id=$1 AND m.status='active' AND a.status='active' AND dp.is_active
      AND EXISTS(SELECT 1 FROM membership_roles r WHERE r.clinic_id=m.clinic_id AND r.user_id=m.user_id AND r.role='doctor') ORDER BY a.display_name`,[ctx.clinicId]),
    ctx.tx.query(`SELECT s.id,s.name_uz_cyrl name,s.kind,(SELECT price_uzs::text FROM service_prices p WHERE p.service_id=s.id AND p.effective_from<=now() ORDER BY effective_from DESC LIMIT 1) price
      FROM services s WHERE s.clinic_id=$1 AND s.is_active ORDER BY name_uz_cyrl`,[ctx.clinicId]),
    ctx.tx.query(`SELECT a.id,a.visit_id,p.full_name patient,r.name room,b.label bed,a.status,a.admitted_at,a.expected_discharge,
      ac.display_name attending,a.attending_user_id FROM admissions a JOIN visits v ON v.id=a.visit_id JOIN patients p ON p.id=v.patient_id
      JOIN accounts ac ON ac.id=a.attending_user_id LEFT JOIN bed_assignments ba ON ba.admission_id=a.id AND ba.to_at IS NULL
      LEFT JOIN beds b ON b.id=ba.bed_id LEFT JOIN rooms r ON r.id=b.room_id
      WHERE a.clinic_id=$1 AND (NOT $2::boolean OR (a.attending_user_id=$3 AND patient_access_active(a.clinic_id,v.patient_id,$3)))
      ORDER BY a.status,r.name,b.label,a.admitted_at DESC`,[ctx.clinicId,doctorOnly,ctx.actorId]),
    ctx.tx.query('SELECT bed_day_rule FROM clinic_settings WHERE clinic_id=$1',[ctx.clinicId])
  ]);
  // Who can approve an out-of-stock ward dispense by PIN (names only, ward staff only).
  const approvers=ctx.roles.some(r=>(WARD as readonly string[]).includes(r))?(await ctx.tx.query(`SELECT a.id,a.display_name name FROM memberships m
    JOIN accounts a ON a.id=m.user_id AND a.status='active' JOIN account_pins p ON p.account_id=a.id
    WHERE m.clinic_id=$1 AND m.status='active' AND EXISTS(SELECT 1 FROM membership_roles r WHERE r.clinic_id=m.clinic_id AND r.user_id=m.user_id AND r.role IN ('ceo','administrator'))
    ORDER BY a.display_name,a.id`,[ctx.clinicId])).rows:[];
  const flags=doctorOnly?[]:await attention(ctx);
  return JSON.parse(json({attention:flags,today:c.today,rule:settings.rows[0].bed_day_rule,effectiveRule:await ruleAt(ctx,c.today),beds:beds.rows,visits:visits.rows,departments:departments.rows,doctors:doctors.rows,services:services.rows,admissions:admissions.rows,approvers}));
}
export async function admit(ctx:ClinicContext,raw:unknown) {
  const i=parse(AdmitInput,raw);await guard(ctx);
  return retry(ctx,i.key,{action:'admit',...i},async()=>{
    await openBusinessDay(ctx);const c=await clock(ctx);
    if(i.expectedDischarge&&i.expectedDischarge<c.today)return fail('INVALID_INPUT');
    const v=(await ctx.tx.query("SELECT * FROM visits WHERE clinic_id=$1 AND id=$2 AND type='inpatient' AND status='open' FOR UPDATE",[ctx.clinicId,i.visitId])).rows[0];
    if(!v)return fail('NOT_FOUND');
    if((await ctx.tx.query('SELECT 1 FROM admissions WHERE visit_id=$1',[i.visitId])).rowCount)return fail('INVALID_TRANSITION');
    const valid=(await ctx.tx.query(`SELECT 1 FROM departments d JOIN doctor_profiles p ON p.clinic_id=d.clinic_id
      JOIN memberships m ON m.clinic_id=p.clinic_id AND m.user_id=p.user_id JOIN accounts a ON a.id=m.user_id
      WHERE d.clinic_id=$1 AND d.id=$2 AND d.is_active AND p.user_id=$3 AND p.is_active AND m.status='active' AND a.status='active'
      AND EXISTS(SELECT 1 FROM membership_roles r WHERE r.clinic_id=m.clinic_id AND r.user_id=m.user_id AND r.role='doctor')`,[ctx.clinicId,i.departmentId,i.doctorId])).rowCount;
    if(!valid)return fail('INVALID_INPUT');
    const bed=await freeBed(ctx,i.bedId,i.departmentId);if(!await priceAt(ctx.tx,ctx.clinicId,bed.bed_service_id,c.instant))return fail('INVALID_INPUT');
    const id=randomUUID();
    await ctx.tx.query('INSERT INTO admissions(id,clinic_id,visit_id,department_id,attending_user_id,admitted_at,expected_discharge) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,ctx.clinicId,i.visitId,i.departmentId,i.doctorId,c.instant,i.expectedDischarge]);
    await ctx.tx.query('INSERT INTO bed_assignments(id,clinic_id,admission_id,bed_id,from_at) VALUES($1,$2,$3,$4,$5)',[randomUUID(),ctx.clinicId,id,i.bedId,c.instant]);
    await ctx.tx.query(`INSERT INTO patient_assignments(clinic_id,patient_id,user_id,visit_id) VALUES($1,$2,$3,$4)
      ON CONFLICT(clinic_id,patient_id,user_id) DO UPDATE SET visit_id=EXCLUDED.visit_id,granted_at=now()`,[ctx.clinicId,v.patient_id,i.doctorId,i.visitId]);
    await recordAudit(ctx.tx,ctx.actorId,ctx.clinicId,'inpatient.admitted',id);return {id};
  });
}
export async function transfer(ctx:ClinicContext,id:string,raw:unknown) {
  const i=parse(TransferInput,raw);await guard(ctx);
  return retry(ctx,i.key,{action:'transfer',id,...i},async()=>{
    const a=await stay(ctx,id);const bed=await freeBed(ctx,i.bedId,a.department_id);const c=await clock(ctx);
    // Task 023: the new bed bills from its first full date on; a price in force now covers every later date.
    if(!await priceAt(ctx.tx,ctx.clinicId,bed.bed_service_id,c.instant))return fail('INVALID_INPUT');
    await ctx.tx.query('UPDATE bed_assignments SET to_at=$3 WHERE clinic_id=$1 AND admission_id=$2 AND to_at IS NULL',[ctx.clinicId,id,c.instant]);
    await ctx.tx.query('INSERT INTO bed_assignments(id,clinic_id,admission_id,bed_id,from_at) VALUES($1,$2,$3,$4,$5)',[randomUUID(),ctx.clinicId,id,i.bedId,c.instant]);
    await recordAudit(ctx.tx,ctx.actorId,ctx.clinicId,'inpatient.transferred',id);return {id};
  });
}
/** Returns `{refused}` (mapped to 403 after commit) when an override approval PIN is not accepted. */
export async function addService(ctx:ClinicContext,id:string,raw:unknown):Promise<{id:string}|{refused:true}> {
  const i=parse(ServiceInput,raw);await guard(ctx);
  const approverId=i.override?await approveOverride(ctx,id,i.serviceId,i.override):undefined;
  if(approverId===null)return {refused:true};
  // The PIN is never stored: the replay payload keeps only the reason and the approver.
  const override=i.override&&{reason:i.override.reason,approverId:i.override.approverId};
  return retry(ctx,i.key,{action:'service',id,...i,override},async()=>{
    const a=await stay(ctx,id);await openBusinessDay(ctx);
    const s=(await ctx.tx.query("SELECT kind,track_stock FROM services WHERE clinic_id=$1 AND id=$2 AND is_active AND kind NOT IN ('bed','caretaker')",[ctx.clinicId,i.serviceId])).rows[0];
    if(!s)return fail('INVALID_INPUT');
    const stockDispensed=s.kind==='medicine'||(s.kind==='good'&&s.track_stock);
    const chargeId=stockDispensed?(await dispense(ctx,{visitId:a.visit_id,serviceId:i.serviceId,qty:i.quantity,idempotencyKey:`inpatient:${i.key}`,source:'inpatient',
        ...override?{overrideReason:override.reason}:{}},approverId?{approverId}:{})).chargeLineId
      :await line(ctx,a.visit_id,i.serviceId,i.quantity,(await clock(ctx)).instant,'inpatient');
    await recordAudit(ctx.tx,ctx.actorId,ctx.clinicId,'inpatient.service_added',id,{chargeId,stockDispensed});return {id:chargeId};
  });
}
export async function addCaretaker(ctx:ClinicContext,id:string,raw:unknown) {
  const i=parse(CaretakerInput,raw);await guard(ctx);
  return retry(ctx,i.key,{action:'caretaker',id,...i},async()=>{
    await stay(ctx,id);const c=await clock(ctx);
    if(i.dailyServiceId&&!(await ctx.tx.query("SELECT 1 FROM services WHERE clinic_id=$1 AND id=$2 AND kind='caretaker' AND is_active",[ctx.clinicId,i.dailyServiceId])).rowCount)return fail('INVALID_INPUT');
    // Task 023: caretaker days bill from today, priced at the start of each date. Prices only move forward,
    // so a price in force at the start of today covers every date this caretaker will be billed.
    if(i.dailyServiceId&&!await priceAt(ctx.tx,ctx.clinicId,i.dailyServiceId,await dayStart(ctx,c.today)))return fail('INVALID_INPUT');
    const caretakerId=randomUUID();await ctx.tx.query('INSERT INTO caretakers(id,clinic_id,admission_id,full_name,phone,from_date,daily_service_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[caretakerId,ctx.clinicId,id,i.fullName,i.phone,c.today,i.dailyServiceId]);
    await recordAudit(ctx.tx,ctx.actorId,ctx.clinicId,'inpatient.caretaker_added',id);return {id:caretakerId};
  });
}

async function dayStart(ctx:ClinicContext,date:string):Promise<Date> {
  return (await ctx.tx.query('SELECT ($2::date::timestamp AT TIME ZONE timezone) start FROM clinics WHERE id=$1',[ctx.clinicId,date])).rows[0].start;
}
type StayDay={admission:string;visit:string;kind:'bed'|'caretaker';caretaker?:string;date:string;service:string;quantity:number;at:Date};
/**
 * Task 023: posts one dated bed or caretaker charge. A day the service has no price for is not charged and not
 * fatal: it is flagged "needs attention" for the ward and administrator. While the stay is admitted, a later run
 * charges it once a price covers it (a service's first price may be backdated). After discharge the database
 * refuses new charges on the stay, so a flag left at discharge stays visible for the administrator to settle.
 */
async function stayDay(ctx:ClinicContext,d:StayDay):Promise<boolean> {
  const price=await priceAt(ctx.tx,ctx.clinicId,d.service,d.at);
  if(!price) {
    const r=await ctx.tx.query(`INSERT INTO inpatient_attention(id,clinic_id,admission_id,kind,charge_date,service_id,caretaker_id,quantity,priced_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,[randomUUID(),ctx.clinicId,d.admission,d.kind,d.date,d.service,d.caretaker??null,d.quantity,d.at]);
    if(r.rowCount)await recordAudit(ctx.tx,ctx.actorId,ctx.clinicId,'inpatient.unpriced_day',d.admission,{kind:d.kind,date:d.date,serviceId:d.service});
    return false;
  }
  const charge=await line(ctx,d.visit,d.service,d.quantity,d.at,d.kind==='bed'?'bed_day':'caretaker');
  if(d.kind==='bed')await ctx.tx.query('INSERT INTO bed_day_charges(clinic_id,admission_id,charge_date,charge_line_id) VALUES($1,$2,$3,$4)',[ctx.clinicId,d.admission,d.date,charge]);
  else await ctx.tx.query('INSERT INTO caretaker_day_charges(clinic_id,caretaker_id,charge_date,charge_line_id) VALUES($1,$2,$3,$4)',[ctx.clinicId,d.caretaker,d.date,charge]);
  await ctx.tx.query(`UPDATE inpatient_attention SET resolved_at=now() WHERE admission_id=$1 AND kind=$2 AND charge_date=$3
    AND coalesce(caretaker_id,admission_id)=coalesce($4::uuid,admission_id) AND resolved_at IS NULL`,[d.admission,d.kind,d.date,d.caretaker??null]);
  return true;
}
/** Unresolved "needs attention" days, for the ward screen and the discharge invoice. */
export async function attention(ctx:ClinicContext,admissionId?:string) {
  return (await ctx.tx.query(`SELECT f.id,f.admission_id,f.kind,f.charge_date::text date,s.name_uz_cyrl service,p.full_name patient
    FROM inpatient_attention f JOIN services s ON s.id=f.service_id JOIN admissions a ON a.id=f.admission_id
    JOIN visits v ON v.id=a.visit_id JOIN patients p ON p.id=v.patient_id
    WHERE f.clinic_id=$1 AND f.resolved_at IS NULL AND ($2::uuid IS NULL OR f.admission_id=$2) ORDER BY f.charge_date,f.id LIMIT 200`,[ctx.clinicId,admissionId??null])).rows;
}

/** Charges settled calendar dates only. Today's bed occupancy remains provisional until discharge.
 * A transfer date belongs to the first bed occupied that date, priced at that assignment/date's start.
 * This avoids needing to void an append-only daily charge when a patient leaves today.
 */
async function accrue(ctx:ClinicContext,id:string,through:string,discharge=false) {
  const a=await stay(ctx,id);const c=await clock(ctx);let added=0;
  if(through<a.admission_date)return 0;
  const dates=(await ctx.tx.query(`SELECT d::date::text date,d AT TIME ZONE $3 start,(d+interval '1 day') AT TIME ZONE $3 finish
    FROM generate_series($1::timestamp,$2::timestamp,interval '1 day') d`,[a.admission_date,through,c.timezone])).rows;
  for(const day of dates) {
    const rule=await ruleAt(ctx,day.date);
    const isFirst=day.date===a.admission_date,isLast=discharge&&day.date===through;
    const billable=isFirst&&isLast?(rule.countAdmissionDay||rule.countDischargeDay):isFirst?rule.countAdmissionDay:isLast?rule.countDischargeDay:true;
    const bed=(await ctx.tx.query(`SELECT b.bed_service_id,ba.from_at FROM bed_assignments ba JOIN beds b ON b.id=ba.bed_id
      WHERE ba.clinic_id=$1 AND ba.admission_id=$2 AND ba.from_at<$4 AND (ba.to_at IS NULL OR ba.to_at>$3)
      ORDER BY ba.from_at,ba.id LIMIT 1`,[ctx.clinicId,id,day.start,day.finish])).rows[0];
    if(!bed)return fail('INVALID_TRANSITION');
    const at=new Date(Math.max(day.start.valueOf(),bed.from_at.valueOf()));
    let quantity=Number(billable);
    if(isLast) {
      // The current date is never precharged by the daily job. Any minimum-stay
      // shortfall therefore fits in its one immutable dated line, without a second charge.
      const minimum=countBedDays({admissionDate:through,dischargeDate:through,rule});
      const prior=(await ctx.tx.query('SELECT coalesce(sum(c.quantity),0)::int n FROM bed_day_charges b JOIN charge_lines c ON c.id=b.charge_line_id WHERE b.admission_id=$1',[id])).rows[0].n;
      quantity=Math.max(quantity,minimum-prior);
    }
    if(quantity>0&&!(await ctx.tx.query('SELECT 1 FROM bed_day_charges WHERE admission_id=$1 AND charge_date=$2',[id,day.date])).rowCount) {
      if(await stayDay(ctx,{admission:id,visit:a.visit_id,kind:'bed',date:day.date,service:bed.bed_service_id,quantity,at}))added++;
    }
    const caretakers=(await ctx.tx.query(`SELECT * FROM caretakers WHERE clinic_id=$1 AND admission_id=$2 AND daily_service_id IS NOT NULL
      AND from_date<=$3 AND (to_date IS NULL OR to_date>=$3)`,[ctx.clinicId,id,day.date])).rows;
    for(const ct of caretakers) {
      const ctFirst=day.date===ct.from_date,ctLast=isLast||day.date===ct.to_date;
      const ctBillable=ctFirst&&ctLast?(rule.countAdmissionDay||rule.countDischargeDay):ctFirst?rule.countAdmissionDay:ctLast?rule.countDischargeDay:true;
      if(!ctBillable)continue;
      if((await ctx.tx.query('SELECT 1 FROM caretaker_day_charges WHERE caretaker_id=$1 AND charge_date=$2',[ct.id,day.date])).rowCount)continue;
      if(await stayDay(ctx,{admission:id,visit:a.visit_id,kind:'caretaker',caretaker:ct.id,date:day.date,service:ct.daily_service_id,quantity:1,at}))added++;
    }
  }
  return added;
}
export async function dailyCharges(ctx:ClinicContext,raw:unknown) {
  const i=parse(DailyInput,raw);await guard(ctx);
  return retry(ctx,i.key,{action:'daily',...i},async()=>{
    await openBusinessDay(ctx);const c=await clock(ctx);if(i.through>=c.today)return fail('INVALID_INPUT');
    let added=0;const ids=(await ctx.tx.query("SELECT id FROM admissions WHERE clinic_id=$1 AND status='admitted' ORDER BY id",[ctx.clinicId])).rows;
    for(const a of ids)added+=await accrue(ctx,a.id,i.through);
    await recordAudit(ctx.tx,ctx.actorId,ctx.clinicId,'inpatient.daily_charges',ctx.clinicId,{through:i.through,added});return {added};
  });
}
/** Hook called in the business-day opener's transaction. A failure rolls back opening as well. */
export async function onBusinessDayOpen(ctx:ClinicContext) {
  const c=await clock(ctx);
  const yesterday=(await ctx.tx.query('SELECT ($1::date-1)::text date',[c.today])).rows[0].date;
  return dailyCharges(ctx,{key:randomUUID(),through:yesterday});
}
/**
 * Task 023: called by day close before its snapshot, so the stored close report includes the closing date's ward
 * revenue. Accrues bed and caretaker days through the closing date for every admitted stay. Idempotent per date:
 * the next day's open run (through yesterday) finds these days already charged.
 */
export async function accrueForClose(ctx:ClinicContext,date:string) {
  await ctx.tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,11011))',[ctx.clinicId]);
  let added=0;const ids=(await ctx.tx.query("SELECT id FROM admissions WHERE clinic_id=$1 AND status='admitted' ORDER BY id",[ctx.clinicId])).rows;
  for(const a of ids)added+=await accrue(ctx,a.id,date);
  if(added)await recordAudit(ctx.tx,ctx.actorId,ctx.clinicId,'inpatient.daily_charges',ctx.clinicId,{through:date,added,atClose:true});
  return added;
}
export async function changeRule(ctx:ClinicContext,raw:unknown) {
  const i=parse(ChangeRuleInput,raw);await guard(ctx,['ceo','administrator']);
  return retry(ctx,i.key,{action:'rule',...i},async()=>{
    await ctx.tx.query('UPDATE clinic_settings SET bed_day_rule=$2,updated_by=$3,updated_at=now() WHERE clinic_id=$1',[ctx.clinicId,json(i.rule),ctx.actorId]);
    await recordAudit(ctx.tx,ctx.actorId,ctx.clinicId,'inpatient.rule_changed',ctx.clinicId);return {effective:'tomorrow'};
  });
}
export async function invoice(ctx:ClinicContext,id:string):Promise<InvoiceView> {
  ctx.roles=(await requireRole(ctx.tx,ctx.actorId,ctx.clinicId,READ)).roles;const a=await stay(ctx,id,false);
  if(ctx.roles.includes('doctor')&&!ctx.roles.some(r=>(WARD as readonly string[]).includes(r)||r==='cashier')) {
    if(a.attending_user_id!==ctx.actorId||!(await ctx.tx.query('SELECT 1 WHERE patient_access_active($1,$2,$3)',[ctx.clinicId,a.patient_id,ctx.actorId])).rowCount)return fail('FORBIDDEN');
  }
  const now=(await clock(ctx)).instant.toISOString();
  const saved=(await ctx.tx.query('SELECT snapshot FROM inpatient_discharge_invoices WHERE clinic_id=$1 AND admission_id=$2',[ctx.clinicId,id])).rows[0];
  if(saved) {
    // Lines stay frozen as of discharge; payments and discounts after discharge are live, so the
    // cashier collecting the balance is reflected here and on the printed invoice.
    const snapshot=saved.snapshot as InvoiceView,linesAsOf=snapshot.linesAsOf??snapshot.issuedAt;
    const kinds=new Map((await ctx.tx.query('SELECT l.id,s.kind FROM charge_lines l JOIN services s ON s.id=l.service_id WHERE l.clinic_id=$1 AND l.id=ANY($2::uuid[])',
      [ctx.clinicId,snapshot.lines.map(l=>l.id)])).rows.map(r=>[r.id as string,r.kind as string]));
    const frozen=snapshot.lines.map(l=>({id:l.id,unitPrice:uzs(l.price),quantity:l.quantity,status:(l.value==='0'&&l.price!=='0'?'cancelled':'completed') as 'cancelled'|'completed',category:kinds.get(l.id)??'service'}));
    const totals=await settle(ctx,a.visit_id,frozen);
    return {...snapshot,linesAsOf,paymentsAsOf:now,...totals};
  }
  const lines=(await ctx.tx.query(`SELECT l.*,s.name_uz_cyrl name,s.kind FROM charge_lines l JOIN services s ON s.id=l.service_id WHERE l.clinic_id=$1 AND l.visit_id=$2 ORDER BY l.created_at,l.id`,[ctx.clinicId,a.visit_id])).rows;
  const totals=await settle(ctx,a.visit_id,lines.map(l=>({id:l.id,unitPrice:uzs(l.unit_price_uzs),quantity:l.quantity,status:l.status,category:l.kind})));
  const names=(await ctx.tx.query('SELECT c.name clinic,p.full_name patient,p.patient_no FROM clinics c JOIN patients p ON p.clinic_id=c.id WHERE c.id=$1 AND p.id=$2',[ctx.clinicId,a.patient_id])).rows[0];
  return {...names,patientNo:names.patient_no,admissionId:id,visitId:a.visit_id,issuedAt:now,linesAsOf:now,paymentsAsOf:now,
    lines:lines.map(l=>({id:l.id,name:l.name,quantity:l.quantity,price:l.unit_price_uzs,value:(l.status==='cancelled'?0n:BigInt(l.unit_price_uzs)*BigInt(l.quantity)).toString(),source:l.source})),
    ...totals};
}
/** Value, discount, payable, paid and due for these lines against the visit's current discounts and net receipts. */
async function settle(ctx:ClinicContext,visitId:string,lines:Parameters<typeof calculateInvoice>[0]) {
  const ids=new Set(lines.map(l=>l.id));
  const discounts=(await ctx.tx.query('SELECT * FROM discounts WHERE clinic_id=$1 AND visit_id=$2 AND voided_at IS NULL ORDER BY created_at,id',[ctx.clinicId,visitId])).rows
    .filter(d=>!d.charge_line_id||ids.has(d.charge_line_id));
  const payments=(await ctx.tx.query('SELECT * FROM payments WHERE clinic_id=$1 AND visit_id=$2 ORDER BY created_at,id',[ctx.clinicId,visitId])).rows;
  const ds:Discount[]=discounts.map(d=>({...d.charge_line_id?{lineId:d.charge_line_id}:{},reason:d.reason,approverId:d.approved_by,...d.kind==='percent'?{kind:'percent' as const,basisPoints:d.percent_bp}:{kind:'fixed' as const,amount:uzs(d.amount_uzs)}}));
  // Current discounts may have reallocated/refunded old payments. Like the cashier,
  // calculate the current payable against net receipts, not a historic gross-payment peak.
  const net=payments.reduce((sum,p)=>sum+(p.kind==='payment'?1n:-1n)*BigInt(p.amount_uzs),0n);
  let totals:ReturnType<typeof calculateInvoice>;
  try {totals=calculateInvoice(lines,ds,net>0n?[{id:'net',kind:'payment',amount:uzs(net)}]:[]);}catch{return fail('INVALID_TRANSITION');}
  return {value:totals.value.toString(),discount:totals.discount.toString(),payable:totals.payable.toString(),paid:totals.paid.toString(),due:totals.due.toString()};
}
export async function discharge(ctx:ClinicContext,id:string,raw:unknown) {
  const i=parse(KeyInput,raw);await guard(ctx);
  return retry(ctx,i.key,{action:'discharge',id,...i},async()=>{
    const a=await stay(ctx,id);await openBusinessDay(ctx);const c=await clock(ctx);
    await accrue(ctx,id,c.today,true);
    const snapshot={...await invoice(ctx,id),needsAttention:(await attention(ctx,id)).map(f=>({kind:f.kind,date:f.date,service:f.service}))};
    await ctx.tx.query('INSERT INTO inpatient_discharge_invoices(clinic_id,admission_id,snapshot,issued_by) VALUES($1,$2,$3,$4)',[ctx.clinicId,id,json(snapshot),ctx.actorId]);
    await ctx.tx.query('UPDATE bed_assignments SET to_at=$3 WHERE clinic_id=$1 AND admission_id=$2 AND to_at IS NULL',[ctx.clinicId,id,c.instant]);
    await ctx.tx.query("UPDATE admissions SET status='discharged',discharged_at=$3 WHERE clinic_id=$1 AND id=$2",[ctx.clinicId,id,c.instant]);
    await ctx.tx.query("UPDATE visits SET status='closed',closed_at=$3 WHERE clinic_id=$1 AND id=$2",[ctx.clinicId,a.visit_id,c.instant]);
    await ctx.tx.query('UPDATE caretakers SET to_date=$3 WHERE clinic_id=$1 AND admission_id=$2 AND to_date IS NULL',[ctx.clinicId,id,c.today]);
    await recordAudit(ctx.tx,ctx.actorId,ctx.clinicId,'inpatient.discharged',id,{due:snapshot.due});return snapshot;
  });
}

