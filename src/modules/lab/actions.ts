import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireRole, recordAudit, type ClinicContext } from '../../server/roles.js';
import { Key, fail, once } from '../pharmacy/actions.js';

/*
 * Laboratory workspace (task 010, increment C6). Lab staff see lab orders (charge lines of kind 'lab'),
 * enter results as append-only lab_results versions and confirm the test, which completes the charge line
 * exactly once at the price fixed when the doctor ordered it. Nothing here reads visit notes or payments.
 * Managers (CEO, administrator) can watch the lab list; only laboratory staff write.
 */
export const LAB = ['laboratory'] as const;
export const LAB_READ = ['laboratory', 'ceo', 'administrator'] as const;

const ResultValue = z.object({
  name: z.string().trim().min(1).max(120),
  // Kept as text: "<0.1", "негатив" or "5,4" are results; an unknown value is simply not entered, never 0.
  value: z.string().trim().min(1).max(200),
  unit: z.string().trim().max(40).default(''),
  reference: z.string().trim().max(120).default('')
}).strict();
export const ResultInput = z.object({ idempotencyKey: Key, expectedVersion: z.number().int().min(0).max(1000),
  values: z.array(ResultValue).min(1).max(60), comment: z.string().trim().max(2000).default('') }).strict();
export const ConfirmInput = z.object({ idempotencyKey: Key }).strict();

const LINE_SELECT = `SELECT l.id, l.status, l.created_at, l.completed_at, l.visit_id, s.name_uz_cyrl service, s.unit,
    coalesce(p.full_name, p.display_name) patient_name, p.patient_no, coalesce(p.birth_date, p.date_of_birth)::text birth_date, p.gender,
    a.display_name ordered_by,
    -- Task 025: the orderer's role for the card label; doctor first, then the role list order (roles.ts).
    (SELECT r.role FROM membership_roles r WHERE r.clinic_id=l.clinic_id AND r.user_id=l.created_by
      ORDER BY array_position(ARRAY['doctor','registrar','administrator','ceo','cashier','inpatient','laboratory','pharmacy'], r.role) LIMIT 1) ordered_by_role,
    v.status visit_status, vd.business_date::text visit_date, vd.status visit_day_status,
    (SELECT pc.posted_at IS NULL FROM lab_pending_confirmations pc WHERE pc.clinic_id=l.clinic_id AND pc.charge_line_id=l.id) pending,
    (SELECT max(version) FROM lab_results r WHERE r.clinic_id=l.clinic_id AND r.charge_line_id=l.id) result_version
  FROM charge_lines l
  JOIN services s ON s.clinic_id=l.clinic_id AND s.id=l.service_id AND s.kind='lab'
  JOIN visits v ON v.clinic_id=l.clinic_id AND v.id=l.visit_id
  JOIN business_days vd ON vd.clinic_id=v.clinic_id AND vd.id=v.business_day_id
  JOIN patients p ON p.clinic_id=v.clinic_id AND p.id=v.patient_id
  JOIN accounts a ON a.id=l.created_by`;
const lineView = (r: Record<string, any>) => ({ id: r.id as string, status: r.status as string, service: r.service as string,
  patientName: r.patient_name as string, patientNo: r.patient_no as number | null, orderedBy: r.ordered_by as string, orderedByRole: (r.ordered_by_role ?? null) as string | null,
  orderedAt: r.created_at, completedAt: r.completed_at, resultVersion: (r.result_version ?? null) as number | null,
  // Task 017: an order from a closed business day (results arrive the next day) and a confirmation waiting for a day to open.
  visitDate: r.visit_date as string, late: r.visit_day_status === 'closed', pending: r.pending === true });

/**
 * Lab lines of today's (open) business day, plus orders of closed days still waiting for a result (task 017), newest
 * first. With no day open, only those waiting orders are listed. Filtering by status happens on the client.
 */
export async function orders(ctx: ClinicContext) {
  const c = await requireRole(ctx.tx, ctx.actorId, ctx.clinicId, LAB_READ);
  const day = (await c.tx.query("SELECT id, business_date::text date FROM business_days WHERE clinic_id=$1 AND status='open'", [c.clinicId])).rows[0];
  const rows = (await c.tx.query(`${LINE_SELECT} WHERE l.clinic_id=$1 AND l.status<>'cancelled'
      AND (v.business_day_id=$2 OR (vd.status='closed' AND l.status='ordered'))
    ORDER BY CASE l.status WHEN 'ordered' THEN 0 ELSE 1 END, l.created_at DESC LIMIT 500`, [c.clinicId, day?.id ?? null])).rows;
  return { day: day ? { id: day.id as string, date: day.date as string } : null, orders: rows.map(lineView) };
}

/**
 * Posts late confirmations made while no business day was open (task 017). Runs inside the day-open transaction:
 * each waiting line completes once, attributed to the new day; the closed day it was ordered on is untouched.
 */
export async function postPendingConfirmations(ctx: ClinicContext, dayId: string) {
  // Task 023: the technician is recorded in completed_by only. A lab line's performer stays the ordering doctor (or none).
  const posted = (await ctx.tx.query(`UPDATE charge_lines l SET status='completed', completed_by=p.requested_by, completed_at=now(),
      completed_business_day_id=$2
    FROM lab_pending_confirmations p WHERE p.clinic_id=$1 AND p.posted_at IS NULL AND l.clinic_id=p.clinic_id AND l.id=p.charge_line_id AND l.status='ordered'
    RETURNING l.id`, [ctx.clinicId, dayId])).rows;
  await ctx.tx.query('UPDATE lab_pending_confirmations SET posted_business_day_id=$2, posted_at=now() WHERE clinic_id=$1 AND posted_at IS NULL', [ctx.clinicId, dayId]);
  for (const r of posted) await recordAudit(ctx.tx, ctx.actorId, ctx.clinicId, 'lab.confirmation_posted', r.id, { businessDayId: dayId });
  return posted.length;
}

async function line(c: ClinicContext, id: string, lock = false) {
  const row = (await c.tx.query(`${LINE_SELECT} WHERE l.clinic_id=$1 AND l.id=$2 ${lock ? 'FOR UPDATE OF l' : ''}`, [c.clinicId, id])).rows[0];
  return row ?? fail('NOT_FOUND');
}

/** One lab order with the patient's identifying basics and every result version (history is never rewritten). */
export async function order(ctx: ClinicContext, id: string) {
  const c = await requireRole(ctx.tx, ctx.actorId, ctx.clinicId, LAB_READ);
  const r = await line(c, id);
  const versions = (await c.tx.query(`SELECT x.version, x.result, x.entered_at, a.display_name entered_by FROM lab_results x JOIN accounts a ON a.id=x.entered_by
    WHERE x.clinic_id=$1 AND x.charge_line_id=$2 ORDER BY x.version DESC`, [c.clinicId, id])).rows;
  return { ...lineView(r), birthDate: r.birth_date as string | null, gender: r.gender as string | null, visitOpen: r.visit_status === 'open',
    versions: versions.map(v => ({ version: v.version as number, enteredAt: v.entered_at, enteredBy: v.entered_by as string, ...(v.result as object) })) };
}

/** Appends a result version. expectedVersion guards against two people overwriting each other's entry. */
export async function enterResult(ctx: ClinicContext, id: string, raw: z.input<typeof ResultInput>) {
  const c = await requireRole(ctx.tx, ctx.actorId, ctx.clinicId, LAB); const input = ResultInput.parse(raw);
  return once(c, 'lab.result', { ...input, lineId: id } as { idempotencyKey: string }, async () => {
    const r = await line(c, id, true);
    if (r.status === 'cancelled') return fail('INVALID_TRANSITION');
    if ((r.result_version ?? 0) !== input.expectedVersion) return fail('STALE_VERSION');
    const version = input.expectedVersion + 1, resultId = randomUUID();
    const result = { values: input.values, comment: input.comment || null, afterConfirmation: r.status === 'completed' };
    await c.tx.query('INSERT INTO lab_results(id,clinic_id,charge_line_id,version,result,entered_by) VALUES($1,$2,$3,$4,$5,$6)',
      [resultId, c.clinicId, id, version, JSON.stringify(result), c.actorId]);
    await recordAudit(c.tx, c.actorId, c.clinicId, 'lab.result_entered', id, { version, afterConfirmation: result.afterConfirmation });
    return { id: resultId, version };
  });
}

/** Confirms the test: the charge line moves ordered -> completed once. Repeats (any key, any device) change nothing. */
export async function confirm(ctx: ClinicContext, id: string, raw: z.input<typeof ConfirmInput>) {
  const c = await requireRole(ctx.tx, ctx.actorId, ctx.clinicId, LAB); const input = ConfirmInput.parse(raw);
  return once(c, 'lab.confirm', { ...input, lineId: id } as { idempotencyKey: string }, async () => {
    const r = await line(c, id, true);
    if (r.status === 'cancelled' || !r.result_version) return fail('INVALID_TRANSITION');
    if (r.status === 'completed') return { id, status: 'completed', completedNow: false };
    // Task 017: a result that arrives after the visit's day is closed (or after discharge) is still confirmed. The
    // completion posts to the business day open now, with the original visit date kept in the audit; the line's
    // value stays on its own day, whose closed snapshot is never rewritten. With no day open it waits (pending).
    const day = (await c.tx.query("SELECT id, business_date::text date FROM business_days WHERE clinic_id=$1 AND status='open' FOR SHARE", [c.clinicId])).rows[0];
    const late = r.visit_day_status === 'closed' || r.visit_status !== 'open';
    if (!day) {
      await c.tx.query(`INSERT INTO lab_pending_confirmations(charge_line_id,clinic_id,result_version,requested_by) VALUES($1,$2,$3,$4)
        ON CONFLICT (charge_line_id) DO NOTHING`, [id, c.clinicId, r.result_version, c.actorId]);
      await recordAudit(c.tx, c.actorId, c.clinicId, 'lab.confirmation_pending', id, { version: r.result_version, visitDate: r.visit_date });
      return { id, status: 'pending', completedNow: false, visitDate: r.visit_date as string };
    }
    const done = (await c.tx.query(`UPDATE charge_lines SET status='completed', completed_by=$3, completed_at=now(),
      completed_business_day_id=$4 WHERE clinic_id=$1 AND id=$2 AND status='ordered'`, [c.clinicId, id, c.actorId, day.id])).rowCount;
    await recordAudit(c.tx, c.actorId, c.clinicId, 'lab.confirmed', id, { version: r.result_version, ...(late ? { late: true, visitDate: r.visit_date, postedTo: day.date } : {}) });
    return { id, status: 'completed', completedNow: !!done, ...(late ? { late: true, visitDate: r.visit_date as string, postedTo: day.date as string } : {}) };
  });
}
