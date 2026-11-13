import { z } from 'zod';
import { requireRole, recordAudit, type ClinicContext } from '../../server/roles.js';
import { Key, fail, once } from '../pharmacy/actions.js';
import { reconcile } from '../cashier/actions.js';

/*
 * Task 023: cancelling charge lines that were never performed. Billed-basis doctor pay counts only completed
 * lines, so an ordered line that will not happen must be able to leave the bill and the debt.
 * - Registrar, cashier, CEO or administrator: any unpaid ordered line of an open visit, with a reason.
 * - Doctor: only lines they ordered themselves (same unpaid/ordered rule).
 * - CEO or administrator at day close: mark a visit with no completed lines as a no-show, cancelling its ordered lines.
 * A line with money allocated to it is refused: refund first. Line discounts on it are voided with it.
 */
export const CANCELLERS = ['registrar', 'cashier', 'ceo', 'administrator', 'doctor'] as const;
const OFFICE = ['registrar', 'cashier', 'ceo', 'administrator'];
const reason = z.string().trim().min(1).max(500);
export const CancelInput = z.object({ idempotencyKey: Key, reason }).strict();
export const NoShowInput = z.object({ idempotencyKey: Key, visitIds: z.array(z.uuid()).min(1).max(200) }).strict();

/** Net money allocated to each line (payments minus refunds, plus discount/cancellation reallocations). */
async function allocated(c: ClinicContext, visitId: string) {
  const rows = (await c.tx.query(`SELECT charge_line_id, sum(amount)::text amount FROM (
      SELECT a.charge_line_id, CASE WHEN p.kind='payment' THEN a.amount_uzs ELSE -a.amount_uzs END amount
      FROM payment_allocations a JOIN payments p ON p.id=a.payment_id AND p.clinic_id=a.clinic_id WHERE p.clinic_id=$1 AND p.visit_id=$2
      UNION ALL SELECT a.charge_line_id, a.delta_uzs FROM cashier_allocation_adjustments a JOIN payments p ON p.id=a.payment_id AND p.clinic_id=a.clinic_id
      WHERE p.clinic_id=$1 AND p.visit_id=$2) x GROUP BY charge_line_id`, [c.clinicId, visitId])).rows;
  return new Map(rows.map(r => [r.charge_line_id as string, BigInt(r.amount)]));
}
async function openDay(c: ClinicContext) {
  if (!(await c.tx.query("SELECT 1 FROM business_days WHERE clinic_id=$1 AND status='open' FOR SHARE", [c.clinicId])).rowCount) fail('INVALID_TRANSITION');
}
/** Cancels one locked, ordered, unpaid line; voids its line discounts; reallocates receipts if the visit has any. */
async function cancelOne(c: ClinicContext, line: Record<string, any>, why: string, paid: Map<string, bigint>) {
  if (line.status !== 'ordered') return fail('INVALID_TRANSITION');
  if ((paid.get(line.id) ?? 0n) !== 0n) return fail('INVALID_TRANSITION');
  await c.tx.query(`UPDATE discounts SET voided_by=$3, voided_at=now(), void_reason=$4 WHERE clinic_id=$1 AND charge_line_id=$2 AND voided_at IS NULL`,
    [c.clinicId, line.id, c.actorId, `line cancelled: ${why}`.slice(0, 1000)]);
  await c.tx.query(`UPDATE charge_lines SET status='cancelled', cancelled_by=$3, cancelled_at=now(), cancel_reason=$4
    WHERE clinic_id=$1 AND id=$2 AND status='ordered'`, [c.clinicId, line.id, c.actorId, why]);
  // Receipts move to the remaining lines. If they would exceed what is still payable, refund first (refused here).
  if (paid.size) {
    try { await reconcile(c, line.visit_id, { cancelledLineId: line.id }); }
    catch (error) { if (error instanceof RangeError || error instanceof TypeError) return fail('INVALID_TRANSITION'); throw error; }
  }
  await recordAudit(c.tx, c.actorId, c.clinicId, 'charge.cancelled', line.id, { visitId: line.visit_id });
}

export async function cancelLine(ctx: ClinicContext, lineId: string, raw: z.input<typeof CancelInput>) {
  const c = await requireRole(ctx.tx, ctx.actorId, ctx.clinicId, CANCELLERS); const input = CancelInput.parse(raw);
  return once(c, 'charges.cancel', { ...input, lineId } as { idempotencyKey: string }, async () => {
    const ref = (await c.tx.query('SELECT visit_id FROM charge_lines WHERE clinic_id=$1 AND id=$2', [c.clinicId, lineId])).rows[0];
    if (!ref) return fail('NOT_FOUND');
    // Same lock order as the cashier: visit first, then the line.
    const v = (await c.tx.query('SELECT status FROM visits WHERE clinic_id=$1 AND id=$2 FOR UPDATE', [c.clinicId, ref.visit_id])).rows[0];
    const line = (await c.tx.query('SELECT * FROM charge_lines WHERE clinic_id=$1 AND id=$2 FOR UPDATE', [c.clinicId, lineId])).rows[0];
    // A doctor without an office role sees another doctor's line as missing.
    if (!c.roles.some(r => OFFICE.includes(r)) && line.created_by !== c.actorId) return fail('NOT_FOUND');
    if (v.status !== 'open') return fail('INVALID_TRANSITION');
    await openDay(c);
    await cancelOne(c, line, input.reason, await allocated(c, ref.visit_id));
    return { id: lineId, status: 'cancelled' };
  });
}

/** Visits of this (open) day with no completed line, at least one ordered line, nothing paid and no admission. */
export async function noShowCandidates(ctx: ClinicContext, dayId: string) {
  const c = await requireRole(ctx.tx, ctx.actorId, ctx.clinicId, ['ceo', 'administrator']);
  return (await c.tx.query(`SELECT v.id, p.full_name patient, p.patient_no,
      (SELECT count(*)::int FROM charge_lines l WHERE l.clinic_id=v.clinic_id AND l.visit_id=v.id AND l.status='ordered') ordered
    FROM visits v JOIN patients p ON p.clinic_id=v.clinic_id AND p.id=v.patient_id
    JOIN business_days d ON d.clinic_id=v.clinic_id AND d.id=v.business_day_id AND d.status='open'
    WHERE v.clinic_id=$1 AND v.business_day_id=$2 AND v.status='open'
      AND NOT EXISTS (SELECT 1 FROM admissions a WHERE a.clinic_id=v.clinic_id AND a.visit_id=v.id)
      AND NOT EXISTS (SELECT 1 FROM charge_lines l WHERE l.clinic_id=v.clinic_id AND l.visit_id=v.id AND l.status='completed')
      AND EXISTS (SELECT 1 FROM charge_lines l WHERE l.clinic_id=v.clinic_id AND l.visit_id=v.id AND l.status='ordered')
      AND NOT EXISTS (SELECT 1 FROM payments x WHERE x.clinic_id=v.clinic_id AND x.visit_id=v.id)
    ORDER BY p.patient_no LIMIT 500`, [c.clinicId, dayId])).rows
    .map(r => ({ visitId: r.id as string, patient: r.patient as string, patientNo: r.patient_no as number, ordered: r.ordered as number }));
}

/** Marks visits as no-shows at day close: ordered lines cancelled, open tickets cancelled, visit cancelled. */
export async function markNoShow(ctx: ClinicContext, dayId: string, raw: z.input<typeof NoShowInput>) {
  const c = await requireRole(ctx.tx, ctx.actorId, ctx.clinicId, ['ceo', 'administrator']); const input = NoShowInput.parse(raw);
  return once(c, 'charges.no_show', { ...input, dayId } as { idempotencyKey: string }, async () => {
    if (!(await c.tx.query("SELECT 1 FROM business_days WHERE clinic_id=$1 AND id=$2 AND status='open' FOR SHARE", [c.clinicId, dayId])).rowCount) return fail('INVALID_TRANSITION');
    const ids = [...new Set(input.visitIds)].sort();
    let cancelled = 0;
    for (const visitId of ids) {
      const v = (await c.tx.query('SELECT * FROM visits WHERE clinic_id=$1 AND id=$2 FOR UPDATE', [c.clinicId, visitId])).rows[0];
      if (!v || v.business_day_id !== dayId) return fail('NOT_FOUND');
      if (v.status !== 'open') return fail('INVALID_TRANSITION');
      if ((await c.tx.query('SELECT 1 FROM admissions WHERE clinic_id=$1 AND visit_id=$2', [c.clinicId, visitId])).rowCount) return fail('INVALID_TRANSITION');
      if ((await c.tx.query('SELECT 1 FROM payments WHERE clinic_id=$1 AND visit_id=$2', [c.clinicId, visitId])).rowCount) return fail('INVALID_TRANSITION');
      const lines = (await c.tx.query("SELECT * FROM charge_lines WHERE clinic_id=$1 AND visit_id=$2 AND status<>'cancelled' ORDER BY id FOR UPDATE", [c.clinicId, visitId])).rows;
      if (lines.some(l => l.status === 'completed')) return fail('INVALID_TRANSITION');
      for (const l of lines) { await cancelOne(c, l, 'no-show', new Map()); cancelled++; }
      await c.tx.query("UPDATE queue_tickets SET status='cancelled' WHERE clinic_id=$1 AND visit_id=$2 AND status IN ('waiting','called','in_progress')", [c.clinicId, visitId]);
      await c.tx.query("UPDATE visits SET status='cancelled', closed_at=now() WHERE clinic_id=$1 AND id=$2", [c.clinicId, visitId]);
      await recordAudit(c.tx, c.actorId, c.clinicId, 'visit.no_show', visitId, { lines: lines.length });
    }
    return { visits: ids.length, linesCancelled: cancelled };
  });
}
