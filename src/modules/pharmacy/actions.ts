import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../identity/access.js';
import { requireRole, recordAudit, type ClinicContext } from '../../server/roles.js';
import { priceAt } from '../../server/repo/prices.js';

export const PHARMACY = ['ceo','administrator','pharmacy'] as const;
export const DISPENSERS = [...PHARMACY,'doctor','inpatient'] as const;
const qty = z.number().int().min(1).max(2147483647);
const text = z.string().trim().min(1).max(1000);
export const Key = z.string().min(8).max(200);
const base = { serviceId: z.uuid(), idempotencyKey: Key };
export const ReceiptInput = z.object({ ...base, qty, unitCostUzs: z.string().regex(/^(0|[1-9]\d{0,18})$/).refine(v => /^(0|[1-9]\d{0,18})$/.test(v) && BigInt(v) <= 9223372036854775807n), supplier: text, note: text.optional() });
export const AdjustmentInput = z.object({ ...base, qty: z.number().int().min(-2147483647).max(2147483647).refine(v => v !== 0), reason: text, overrideReason: text.optional() });
export const DispenseInput = z.object({ ...base, visitId: z.uuid(), qty, overrideReason: text.optional(), source:z.enum(['pharmacy','inpatient']).optional() });
export const ThresholdInput = z.object({ ...base, threshold: z.number().int().min(0).max(2147483647) });
export const fail = (code: ConstructorParameters<typeof DomainError>[0]): never => { throw new DomainError(code); };

/** Called inside the caller's transaction; guard is repeated here for non-HTTP callers. */
export async function authorize(ctx: ClinicContext, roles: Parameters<typeof requireRole>[3]) {
  return requireRole(ctx.tx, ctx.actorId, ctx.clinicId, roles);
}
/** Payload-bound, actor-scoped replay; authorization and resource checks run before this. */
export async function once<T>(ctx: ClinicContext, operation: string, input: { idempotencyKey: string }, work: () => Promise<T>): Promise<T> {
  const key = Key.parse(input.idempotencyKey);
  const scope = [ctx.clinicId, ctx.actorId, operation, key];
  await ctx.tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(scope)]);
  const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const old = (await ctx.tx.query('SELECT payload_hash,response FROM idempotency_records WHERE clinic_id=$1 AND actor_id=$2 AND operation=$3 AND key=$4', scope)).rows[0];
  if (old) { if (old.payload_hash !== hash) return fail('IDEMPOTENCY_CONFLICT'); return old.response as T; }
  const result = await work();
  await ctx.tx.query('INSERT INTO idempotency_records(clinic_id,actor_id,operation,key,payload_hash,response) VALUES($1,$2,$3,$4,$5,$6)', [...scope,hash,JSON.stringify(result)]);
  return result;
}
export async function stockItem(ctx: ClinicContext, serviceId: string) {
  const row = (await ctx.tx.query("SELECT * FROM services WHERE clinic_id=$1 AND id=$2 AND is_active AND track_stock AND kind IN ('medicine','good') FOR UPDATE", [ctx.clinicId,serviceId])).rows[0];
  if (!row) return fail('NOT_FOUND');
  return row;
}
export async function onHand(ctx: ClinicContext, serviceId: string): Promise<bigint> {
  return BigInt((await ctx.tx.query('SELECT coalesce(sum(qty),0)::text qty FROM stock_movements WHERE clinic_id=$1 AND service_id=$2', [ctx.clinicId,serviceId])).rows[0].qty);
}
/**
 * Negative stock needs a reason and a CEO/administrator. `approverId` is never read from a request
 * body: only a caller that has already verified that person (ward PIN approval) passes it.
 */
async function override(ctx: ClinicContext, serviceId: string, delta: number, reason?: string, approverId?: string) {
  if (await onHand(ctx,serviceId) + BigInt(delta) >= 0n) return null;
  if (!reason) return fail('INVALID_TRANSITION');
  if (approverId) { await authorize({ ...ctx, actorId: approverId },['ceo','administrator']); return approverId; }
  await authorize(ctx,['ceo','administrator']);
  return ctx.actorId;
}
/** Patient access for this visit, whatever its status. Rechecked before every replay as well. */
async function visitAccess(ctx: ClinicContext, visitId: string) {
  const row = (await ctx.tx.query('SELECT patient_id FROM visits WHERE clinic_id=$1 AND id=$2', [ctx.clinicId,visitId])).rows[0];
  if (!row) return fail('NOT_FOUND');
  if (!ctx.roles.some(r => ['ceo','administrator','pharmacy','inpatient'].includes(r))) {
    if (!(await ctx.tx.query('SELECT 1 FROM patient_assignments WHERE clinic_id=$1 AND patient_id=$2 AND user_id=$3', [ctx.clinicId,row.patient_id,ctx.actorId])).rowCount) return fail('FORBIDDEN');
  }
}
export async function visitForCharge(ctx: ClinicContext, visitId: string) {
  const row = (await ctx.tx.query(`SELECT v.* FROM visits v JOIN business_days d ON d.clinic_id=v.clinic_id AND d.id=v.business_day_id
    WHERE v.clinic_id=$1 AND v.id=$2 AND v.status='open' AND (d.status='open' OR
      (v.type='inpatient' AND EXISTS(SELECT 1 FROM admissions a WHERE a.clinic_id=v.clinic_id AND a.visit_id=v.id AND a.status='admitted')
      AND EXISTS(SELECT 1 FROM business_days current_day WHERE current_day.clinic_id=v.clinic_id AND current_day.status='open' FOR SHARE)))
    FOR UPDATE OF v FOR SHARE OF d`, [ctx.clinicId,visitId])).rows[0];
  if (!row) return fail('NOT_FOUND');
  if (!ctx.roles.some(r => ['ceo','administrator','pharmacy','inpatient'].includes(r))) {
    if (!(await ctx.tx.query('SELECT 1 FROM patient_assignments WHERE clinic_id=$1 AND patient_id=$2 AND user_id=$3', [ctx.clinicId,row.patient_id,ctx.actorId])).rowCount) return fail('FORBIDDEN');
  }
  return row;
}
export async function addCharge(ctx: ClinicContext, visitId: string, serviceId: string, quantity: number, source: 'pharmacy'|'surgery'|'inpatient', at: Date, performer: string | null = null) {
  const price = await priceAt(ctx.tx,ctx.clinicId,serviceId,at);
  if (!price) return fail('INVALID_TRANSITION');
  const id = randomUUID();
  await ctx.tx.query(`INSERT INTO charge_lines(id,clinic_id,visit_id,service_id,quantity,unit_price_uzs,status,source,created_by,completed_by,completed_at,performer_user_id)
    VALUES($1,$2,$3,$4,$5,$6,'completed',$7,$8,$8,$9,$10)`, [id,ctx.clinicId,visitId,serviceId,quantity,price.priceUzs.toString(),source,ctx.actorId,at,performer]);
  return id;
}
export async function receive(ctx: ClinicContext, raw: z.input<typeof ReceiptInput>) {
  ctx = await authorize(ctx,PHARMACY); const input = ReceiptInput.parse(raw);
  return once(ctx,'pharmacy.receipt',input,async () => {
    await stockItem(ctx,input.serviceId); const id = randomUUID();
    await ctx.tx.query(`INSERT INTO stock_movements(id,clinic_id,service_id,qty,reason,unit_cost_uzs,supplier,note,created_by)
      VALUES($1,$2,$3,$4,'receipt',$5,$6,$7,$8)`, [id,ctx.clinicId,input.serviceId,input.qty,input.unitCostUzs,input.supplier,input.note ?? null,ctx.actorId]);
    await recordAudit(ctx.tx,ctx.actorId,ctx.clinicId,'pharmacy.received',id,{ serviceId: input.serviceId, qty: input.qty });
    return { id };
  });
}
/** Atomic movement + priced charge. Exported for doctor and inpatient actions. */
export async function dispense(ctx: ClinicContext, raw: z.input<typeof DispenseInput>, verified: { approverId?: string } = {}) {
  ctx = await authorize(ctx,DISPENSERS); const input = DispenseInput.parse(raw);
  // Access is rechecked first (a revoked assignment gets nothing, not even a replay). Then replay:
  // a retry after the visit closed (discharge, day close) returns the recorded result; only a new
  // dispense requires an open, chargeable visit.
  await visitAccess(ctx,input.visitId);
  return once(ctx,'pharmacy.dispense',input,async () => {
    await visitForCharge(ctx,input.visitId);
    await stockItem(ctx,input.serviceId);
    const approver = await override(ctx,input.serviceId,-input.qty,input.overrideReason,verified.approverId);
    const chargeLineId = await addCharge(ctx,input.visitId,input.serviceId,input.qty,input.source??'pharmacy',new Date());
    const id = randomUUID();
    await ctx.tx.query(`INSERT INTO stock_movements(id,clinic_id,service_id,qty,reason,visit_id,charge_line_id,created_by,override_approved_by,override_reason)
      VALUES($1,$2,$3,$4,'dispense',$5,$6,$7,$8,$9)`, [id,ctx.clinicId,input.serviceId,-input.qty,input.visitId,chargeLineId,ctx.actorId,approver,approver ? input.overrideReason : null]);
    await recordAudit(ctx.tx,ctx.actorId,ctx.clinicId,'pharmacy.dispensed',id,{ chargeLineId, approver, overrideReason: approver ? input.overrideReason : null });
    return { id, chargeLineId };
  });
}
export async function adjust(ctx: ClinicContext, raw: z.input<typeof AdjustmentInput>) {
  ctx = await authorize(ctx,PHARMACY); const input = AdjustmentInput.parse(raw);
  return once(ctx,'pharmacy.adjust',input,async () => {
    await stockItem(ctx,input.serviceId); const approver = await override(ctx,input.serviceId,input.qty,input.overrideReason); const id = randomUUID();
    await ctx.tx.query(`INSERT INTO stock_movements(id,clinic_id,service_id,qty,reason,note,created_by,override_approved_by,override_reason)
      VALUES($1,$2,$3,$4,'adjustment',$5,$6,$7,$8)`, [id,ctx.clinicId,input.serviceId,input.qty,input.reason,ctx.actorId,approver,approver ? input.overrideReason : null]);
    await recordAudit(ctx.tx,ctx.actorId,ctx.clinicId,'pharmacy.adjusted',id,{ approver, reason: input.reason, overrideReason: approver ? input.overrideReason : null }); return { id };
  });
}
export async function setThreshold(ctx: ClinicContext, raw: z.input<typeof ThresholdInput>) {
  ctx = await authorize(ctx,PHARMACY); const input = ThresholdInput.parse(raw);
  return once(ctx,'pharmacy.threshold',input,async () => {
    await stockItem(ctx,input.serviceId);
    await ctx.tx.query(`INSERT INTO pharmacy_settings(clinic_id,service_id,low_stock_threshold,updated_by) VALUES($1,$2,$3,$4)
      ON CONFLICT(clinic_id,service_id) DO UPDATE SET low_stock_threshold=$3,updated_by=$4,updated_at=now()`, [ctx.clinicId,input.serviceId,input.threshold,ctx.actorId]);
    await recordAudit(ctx.tx,ctx.actorId,ctx.clinicId,'pharmacy.threshold_set',input.serviceId,{ threshold: input.threshold }); return { id: input.serviceId };
  });
}
export async function stock(ctx: ClinicContext) {
  ctx = await authorize(ctx,PHARMACY);
  return (await ctx.tx.query(`SELECT s.id,s.name_uz_cyrl name,s.unit,coalesce(sum(m.qty),0)::text on_hand,coalesce(p.low_stock_threshold,0) threshold
    FROM services s LEFT JOIN stock_movements m ON m.clinic_id=s.clinic_id AND m.service_id=s.id
    LEFT JOIN pharmacy_settings p ON p.clinic_id=s.clinic_id AND p.service_id=s.id
    WHERE s.clinic_id=$1 AND s.track_stock AND s.kind IN ('medicine','good') AND s.is_active
    GROUP BY s.id,p.low_stock_threshold ORDER BY s.name_uz_cyrl`, [ctx.clinicId])).rows;
}
export async function history(ctx: ClinicContext, serviceId: string) {
  ctx = await authorize(ctx,PHARMACY);
  return (await ctx.tx.query('SELECT * FROM stock_movements WHERE clinic_id=$1 AND service_id=$2 ORDER BY created_at DESC,id', [ctx.clinicId,serviceId])).rows;
}
