import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { calculateDoctorShares } from '../billing/index.js';
import { DomainError } from '../identity/access.js';
import { requireRole, recordAudit, type ClinicContext } from '../../server/roles.js';
import { records, invoiceAt, serviceDate, localDate, inRange, indexRecords, type Period, type Records, type Row } from '../reports/records.js';
import { ServiceKind } from '../../contracts/db/common.js';

export const Rule = z.object({ userId:z.string().uuid(),shareBp:z.number().int().min(0).max(10000),basis:z.enum(['billed','paid']),discountBearer:z.enum(['clinic','doctor','proportional']),categories:z.array(ServiceKind).min(1),effectiveFrom:z.iso.date() }).strict();
const fail = (code: 'NOT_FOUND'|'INVALID_TRANSITION'|'INVALID_INPUT'): never => { throw new DomainError(code); };
export class PayrollRulesMissing extends DomainError { constructor(public readonly doctors:string[]){super('INVALID_TRANSITION');} }
const json = <T>(v:T):T=>JSON.parse(JSON.stringify(v,(_k,v)=>typeof v==='bigint'?v.toString():v));
export async function rules(c:ClinicContext) {
  const ctx=await requireRole(c.tx,c.actorId,c.clinicId,['ceo','doctor']);
  const ceo=ctx.roles.includes('ceo');
  const doctors=(await c.tx.query(`SELECT a.id,a.display_name FROM accounts a JOIN memberships m ON m.user_id=a.id JOIN membership_roles r ON r.clinic_id=m.clinic_id AND r.user_id=m.user_id WHERE m.clinic_id=$1 AND r.role='doctor' AND ($3 OR a.id=$2) ORDER BY a.display_name`,[c.clinicId,c.actorId,ceo])).rows;
  const history=(await c.tx.query(`SELECT s.*,a.display_name created_by_name FROM doctor_split_rules s JOIN accounts a ON a.id=s.created_by WHERE s.clinic_id=$1 AND ($3 OR s.user_id=$2) ORDER BY s.effective_from DESC`,[c.clinicId,c.actorId,ceo])).rows;
  const today=(await c.tx.query('SELECT (now() AT TIME ZONE timezone)::date::text date FROM clinics WHERE id=$1',[c.clinicId])).rows[0].date;
  return {doctors,history,today,ceo};
}
export async function setRule(c:ClinicContext,input:z.infer<typeof Rule>) {
  await requireRole(c.tx,c.actorId,c.clinicId,['ceo']);
  await c.tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,13))',[c.clinicId]);
  const state=await rules(c);
  if(!state.doctors.some(d=>d.id===input.userId)) return fail('NOT_FOUND');
  // No backdating: existing earnings and closed payroll must retain their rule.
  if(input.effectiveFrom<state.today || (await c.tx.query(`SELECT 1 FROM payroll_periods WHERE clinic_id=$1 AND status='final' AND to_date >= $2`,[c.clinicId,input.effectiveFrom])).rowCount) return fail('INVALID_INPUT');
  const existing=state.history.find(r=>r.user_id===input.userId && r.effective_from===input.effectiveFrom);
  if(existing) {
    if(input.effectiveFrom<=state.today)return fail('INVALID_TRANSITION');
    const result=await c.tx.query(`UPDATE doctor_split_rules SET doctor_share_bp=$3,basis=$4,discount_bearer=$5,categories=$6,created_by=$7,created_at=now() WHERE clinic_id=$1 AND id=$2 RETURNING *`,[c.clinicId,existing.id,input.shareBp,input.basis,input.discountBearer,input.categories,c.actorId]);
    await recordAudit(c.tx,c.actorId,c.clinicId,'payroll.rule_corrected',existing.id,{before:existing,after:result.rows[0]});
    return result.rows[0];
  }
  const id=randomUUID();
  const result=await c.tx.query(`INSERT INTO doctor_split_rules(id,clinic_id,user_id,doctor_share_bp,basis,discount_bearer,categories,effective_from,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING *`,[id,c.clinicId,input.userId,input.shareBp,input.basis,input.discountBearer,input.categories,input.effectiveFrom,c.actorId]);
  if(!result.rowCount) return fail('INVALID_TRANSITION');
  await recordAudit(c.tx,c.actorId,c.clinicId,'payroll.rule_created',id); return result.rows[0];
}
function at(data:Records,until:string,doctor?:string,affected?:Set<string>) {
  const out=new Map<string,Row>();
  const visits=affected?[...affected].map(id=>indexRecords(data).visits.get(id)!).filter(Boolean):data.visits;
  for(const v of visits) for(const l of invoiceAt(data,v,until)) {
    if(!l.doctorId || (doctor && l.doctorId!==doctor))continue;
    const date=serviceDate(indexRecords(data).charges.get(l.id)!,data);
    const rule=data.rules.find(r=>r.user_id===l.doctorId && r.effective_from<=date);
    if(!rule && l.status!=='cancelled') {
      out.set(l.id,{charge_line_id:l.id,user_id:l.doctorId,doctor:indexRecords(data).charges.get(l.id)!.doctor,rule_id:null,status:'rule_missing',value_uzs:l.value,entitlement_uzs:0n,from_receipts_uzs:0n,clinic_funded_uzs:0n});continue;
    }
    if(!rule)continue;
    const share=calculateDoctorShares([l],l.doctorId,{doctorShareBp:rule.doctor_share_bp,basis:rule.basis,discountBearer:rule.discount_bearer,categories:rule.categories})[0];
    if(share)out.set(l.id,{charge_line_id:l.id,user_id:l.doctorId,doctor:indexRecords(data).charges.get(l.id)!.doctor,rule_id:rule.id,entitlement_uzs:share.doctorEntitlement,from_receipts_uzs:share.doctorFromReceipts,clinic_funded_uzs:share.clinicFundedShare});
  }
  return out;
}
export function computePayroll(data:Records,p:Period,doctor?:string,affected?:Set<string>) {
  const prev=new Date(Date.parse(p.from)-86400000).toISOString().slice(0,10), before=at(data,prev,doctor,affected), after=at(data,p.to,doctor,affected);
  // Period deltas pay each entitlement once and carry refunds/corrections as signed adjustments.
  return [...new Set([...before.keys(),...after.keys()])].map(id=>{
    const a=after.get(id), b=before.get(id), row={...(a??b)};
    for(const k of ['entitlement_uzs','from_receipts_uzs','clinic_funded_uzs'])row[k]=(a?.[k]??0n)-(b?.[k]??0n);
    return row;
  }).filter(r=>r.status==='rule_missing' || r.entitlement_uzs!==0n || r.from_receipts_uzs!==0n || r.clinic_funded_uzs!==0n);
}
function daily(data:Records,p:Period,doctor?:string) {
  const days=new Map<string,Set<string>>(),index=indexRecords(data);
  const add=(date:string,visit:string)=>{if(!inRange(date,p))return;const ids=days.get(date)??new Set<string>();ids.add(visit);days.set(date,ids);};
  for(const v of data.activities??[])add(v.date,v.visit_id);
  for(const v of data.charges)add(serviceDate(v,data),v.visit_id);
  for(const v of data.payments)add(v.date,v.visit_id);
  for(const v of [...data.charges,...data.discounts,...data.adjustments])for(const key of ['created_at','cancelled_at','voided_at'])if(v[key])add(localDate(v[key],data.clinic.timezone),v.visit_id??index.charges.get(v.charge_line_id)?.visit_id);
  return [...days].sort(([a],[b])=>a.localeCompare(b)).flatMap(([date,ids])=>computePayroll(data,{from:date,to:date},doctor,ids).map(l=>({...l,date})));
}
function aggregate(lines:Row[]) {
  const map=new Map<string,Row>();
  for(const line of lines){const r=map.get(line.charge_line_id)??{...line,entitlement_uzs:0n,from_receipts_uzs:0n,clinic_funded_uzs:0n};for(const k of ['entitlement_uzs','from_receipts_uzs','clinic_funded_uzs'])r[k]+=BigInt(line[k]);map.set(line.charge_line_id,r);}
  return [...map.values()];
}
export async function earnings(c:ClinicContext,p:Period) {
  const ctx=await requireRole(c.tx,c.actorId,c.clinicId,['ceo','doctor']);
  const doctor=ctx.roles.includes('ceo')?undefined:c.actorId;
  const periods=(await c.tx.query(`SELECT id,status,from_date,to_date,CASE WHEN $4::uuid IS NULL THEN daily_snapshot ELSE coalesce((SELECT jsonb_agg(l) FROM jsonb_array_elements(daily_snapshot) l WHERE l->>'user_id'=$4::text),'[]') END daily_snapshot FROM payroll_periods WHERE clinic_id=$1 AND status='final' AND from_date <= $3 AND to_date >= $2 ORDER BY from_date`,[c.clinicId,p.from,p.to,doctor??null])).rows;
  const exact=periods.length===1 && periods[0].from_date===p.from && periods[0].to_date===p.to;
  const lines=exact?(await c.tx.query(`SELECT l.*,a.display_name doctor FROM payroll_lines l JOIN accounts a ON a.id=l.user_id WHERE l.clinic_id=$1 AND l.period_id=$2 AND ($3::uuid IS NULL OR l.user_id=$3) ORDER BY a.display_name,l.charge_line_id`,[c.clinicId,periods[0].id,doctor??null])).rows:aggregate([
    ...periods.flatMap(period=>(period.daily_snapshot??[]).filter((l:Row)=>inRange(l.date,p)&&(!doctor||l.user_id===doctor))),
    ...daily(await records(c,p,{doctor}),p,doctor).filter(l=>!periods.some(period=>inRange(l.date,{from:period.from_date,to:period.to_date})))
  ]);
  const names=(await rules(c)).doctors;
  const publicPeriod=exact?{id:periods[0].id,status:periods[0].status,from_date:periods[0].from_date,to_date:periods[0].to_date}:null;
  return json({...p,period:publicPeriod,lines:lines.map(l=>({...l,doctor:l.doctor??names.find(d=>d.id===l.user_id)?.display_name??'—'}))});
}
export async function finalize(c:ClinicContext,p:Period) {
  await requireRole(c.tx,c.actorId,c.clinicId,['ceo']);
  await c.tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,13))',[c.clinicId]);
  const overlap=(await c.tx.query(`SELECT * FROM payroll_periods WHERE clinic_id=$1 AND status='final' AND from_date <= $3 AND to_date >= $2`,[c.clinicId,p.from,p.to])).rows;
  if(overlap.length) {
    if(overlap.length===1 && overlap[0].from_date===p.from && overlap[0].to_date===p.to)return earnings(c,p);
    return fail('INVALID_TRANSITION');
  }
  // Closing every included day freezes the source ledgers before a financial commitment.
  const today=(await rules(c)).today;
  if(p.to>today || (await c.tx.query(`SELECT 1 FROM business_days WHERE clinic_id=$1 AND business_date BETWEEN $2 AND $3 AND status='open'`,[c.clinicId,p.from,p.to])).rowCount)return fail('INVALID_TRANSITION');
  const data=await records(c,p), lines=computePayroll(data,p), id=randomUUID();
  const missing=[...new Set(lines.filter(l=>l.status==='rule_missing').map(l=>l.user_id))];
  if(missing.length) {
    const names=[...new Set(lines.filter(l=>missing.includes(l.user_id)).map(l=>l.doctor??l.user_id))];
    throw new PayrollRulesMissing(names);
  }
  await c.tx.query('INSERT INTO payroll_periods(id,clinic_id,from_date,to_date) VALUES($1,$2,$3,$4)',[id,c.clinicId,p.from,p.to]);
  for(const l of lines)await c.tx.query(`INSERT INTO payroll_lines(id,clinic_id,period_id,user_id,charge_line_id,rule_id,entitlement_uzs,from_receipts_uzs,clinic_funded_uzs) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[randomUUID(),c.clinicId,id,l.user_id,l.charge_line_id,l.rule_id,l.entitlement_uzs.toString(),l.from_receipts_uzs.toString(),l.clinic_funded_uzs.toString()]);
  await c.tx.query("UPDATE payroll_periods SET status='final',finalized_by=$2,finalized_at=now(),daily_snapshot=$3 WHERE id=$1",[id,c.actorId,JSON.stringify(json(daily(data,p)))]);
  await recordAudit(c.tx,c.actorId,c.clinicId,'payroll.finalized',id,p); return earnings(c,p);
}
