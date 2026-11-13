import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { BusinessDayView, CurrentDayView } from '../../contracts/clinic.js';
import { DomainError } from '../identity/access.js';
import { recordAudit, requireRole, type ClinicContext } from '../../server/roles.js';
import { computeReport } from '../reports/actions.js';
import { records } from '../reports/records.js';
import { onBusinessDayOpen, accrueForClose } from '../inpatient/actions.js';
import { postPendingConfirmations } from '../lab/actions.js';

/*
 * Business-day server actions. The business date is always the clinic's local calendar date
 * computed by PostgreSQL, never a client-supplied value. The database enforces one open day
 * per clinic (partial unique index) and immutability of closed days (trigger).
 */

const fail = (code: ConstructorParameters<typeof DomainError>[0]): never => { throw new DomainError(code); };
const view = (r: pg.QueryResultRow): BusinessDayView => ({ id: r.id, businessDate: r.business_date, status: r.status,
  openedBy: r.opened_by_name, openedAt: r.opened_at.toISOString(), closedBy: r.closed_by_name ?? null, closedAt: r.closed_at?.toISOString() ?? null });
const SELECT = `SELECT d.*, o.display_name opened_by_name, c.display_name closed_by_name FROM business_days d
  JOIN accounts o ON o.id=d.opened_by LEFT JOIN accounts c ON c.id=d.closed_by`;

export async function currentDay(ctx: ClinicContext): Promise<CurrentDayView> {
  const clinic = (await ctx.tx.query("SELECT timezone, (now() AT TIME ZONE timezone)::date::text today FROM clinics WHERE id=$1", [ctx.clinicId])).rows[0];
  if (!clinic) return fail('NOT_FOUND');
  const today = (await ctx.tx.query(`${SELECT} WHERE d.clinic_id=$1 AND d.business_date=$2`, [ctx.clinicId, clinic.today])).rows[0];
  const open = (await ctx.tx.query(`${SELECT} WHERE d.clinic_id=$1 AND d.status='open'`, [ctx.clinicId])).rows[0];
  return { today: clinic.today, timezone: clinic.timezone, day: today ? view(today) : null, openDay: open ? view(open) : null };
}

/** Opens today's business day. Rejected while another day is open or if today was already closed. */
export async function openDay(ctx: ClinicContext): Promise<BusinessDayView> {
  const id = randomUUID();
  // ON CONFLICT DO NOTHING covers both the (clinic, date) key and the one-open-day partial index,
  // including a concurrent opener: the loser waits for the winner's commit and inserts nothing.
  const inserted = (await ctx.tx.query(`INSERT INTO business_days(id,clinic_id,business_date,status,opened_by)
    SELECT $1, id, (now() AT TIME ZONE timezone)::date, 'open', $3 FROM clinics WHERE id=$2
    ON CONFLICT DO NOTHING RETURNING id`, [id, ctx.clinicId, ctx.actorId])).rows[0];
  if (!inserted) return fail('INVALID_TRANSITION');
  await recordAudit(ctx.tx, ctx.actorId, ctx.clinicId, 'business_day.opened', id);
  await onBusinessDayOpen(ctx);
  await postPendingConfirmations(ctx, id); // Task 017: late lab confirmations made while no day was open.
  return view((await ctx.tx.query(`${SELECT} WHERE d.id=$1`, [id])).rows[0]);
}

/** Read before the day lock; verify the MVCC ledger revision after writers drain. */
export async function closeDay(ctx: ClinicContext, dayId: string): Promise<BusinessDayView> {
  const day = (await ctx.tx.query('SELECT * FROM business_days WHERE clinic_id=$1 AND id=$2',[ctx.clinicId,dayId])).rows[0];
  if (!day) return fail('NOT_FOUND');
  if (day.status !== 'open') return fail('INVALID_TRANSITION');
  if ((await ctx.tx.query("SELECT 1 FROM cash_shifts WHERE clinic_id=$1 AND business_day_id=$2 AND status='open'",[ctx.clinicId,dayId])).rowCount) return fail('INVALID_TRANSITION');
  const p={from:day.business_date,to:day.business_date};
  // Task 023: the closing date's bed and caretaker days are charged before the snapshot, so the stored close
  // report and the live dashboard agree. Unpriced days are flagged, never fatal.
  await accrueForClose(ctx,day.business_date);
  const data=await records(ctx,p,{outstanding:true}),snapshot=computeReport(data,p);
  const locked=(await ctx.tx.query('SELECT status FROM business_days WHERE clinic_id=$1 AND id=$2 FOR UPDATE',[ctx.clinicId,dayId])).rows[0];
  const version=(await ctx.tx.query('SELECT version::text FROM report_versions WHERE clinic_id=$1',[ctx.clinicId])).rows[0]?.version??'0';
  if(locked.status!=='open' || version!==data.version)return fail('INVALID_TRANSITION');
  const updated = (await ctx.tx.query(`UPDATE business_days SET status='closed', closed_by=$3, closed_at=now(), close_snapshot=$4::jsonb
    WHERE clinic_id=$1 AND id=$2 AND status='open' RETURNING id`, [ctx.clinicId, dayId, ctx.actorId, JSON.stringify(snapshot)])).rows[0];
  if (!updated) {
    const exists = (await ctx.tx.query('SELECT 1 FROM business_days WHERE clinic_id=$1 AND id=$2', [ctx.clinicId, dayId])).rows[0];
    return fail(exists ? 'INVALID_TRANSITION' : 'NOT_FOUND');
  }
  await recordAudit(ctx.tx, ctx.actorId, ctx.clinicId, 'business_day.closed', dayId);
  // A day closed again after a reopen (task 023) sends a fresh notice with the new totals.
  await ctx.tx.query(`INSERT INTO report_notices(id,clinic_id,business_day_id,totals) VALUES($1,$2,$3,$4)
    ON CONFLICT (clinic_id,business_day_id) DO UPDATE SET totals=EXCLUDED.totals,completed_at=NULL,attempts=0,next_attempt_at=now(),delivered_chats='{}'`,
    [randomUUID(),ctx.clinicId,dayId,JSON.stringify({collected:snapshot.totals.collected,refunds:snapshot.totals.refunds,cashOuts:snapshot.totals.cashOuts})]);
  return view((await ctx.tx.query(`${SELECT} WHERE d.id=$1`, [dayId])).rows[0]);
}

/**
 * Task 023: the CEO undoes an accidental close. Only the most recent closed day, only if it is today's date and no
 * later day exists, never inside a final payroll period, always with a reason. The close snapshot is archived as a
 * prior version (append-only); the next close writes a new one.
 */
export async function reopenDay(ctx: ClinicContext, dayId: string, reason: string): Promise<BusinessDayView> {
  await requireRole(ctx.tx, ctx.actorId, ctx.clinicId, ['ceo']);
  const day = (await ctx.tx.query(`SELECT d.*, d.business_date::text date, (now() AT TIME ZONE c.timezone)::date::text today
    FROM business_days d JOIN clinics c ON c.id=d.clinic_id WHERE d.clinic_id=$1 AND d.id=$2 FOR UPDATE OF d`, [ctx.clinicId, dayId])).rows[0];
  if (!day) return fail('NOT_FOUND');
  if (day.status !== 'closed' || day.date !== day.today) return fail('INVALID_TRANSITION');
  if ((await ctx.tx.query('SELECT 1 FROM business_days WHERE clinic_id=$1 AND business_date>$2', [ctx.clinicId, day.date])).rowCount) return fail('INVALID_TRANSITION');
  if ((await ctx.tx.query("SELECT 1 FROM payroll_periods WHERE clinic_id=$1 AND status='final' AND $2::date BETWEEN from_date AND to_date", [ctx.clinicId, day.date])).rowCount) return fail('INVALID_TRANSITION');
  const version = (await ctx.tx.query('SELECT coalesce(max(version),0)+1 v FROM business_day_close_versions WHERE business_day_id=$1', [dayId])).rows[0].v;
  // Copied in SQL so closed_at keeps its full precision (the reopen trigger matches on it).
  await ctx.tx.query(`INSERT INTO business_day_close_versions(id,clinic_id,business_day_id,version,close_snapshot,closed_by,closed_at,reopened_by,reopen_reason)
    SELECT $1,clinic_id,id,$3,close_snapshot,closed_by,closed_at,$4,$5 FROM business_days WHERE clinic_id=$2 AND id=$6`, [randomUUID(), ctx.clinicId, version, ctx.actorId, reason, dayId]);
  await ctx.tx.query("SELECT set_config('clinora.reopen_day',$1,true)", [dayId]);
  // The one-open-day index refuses this if another day is open.
  const updated = (await ctx.tx.query(`UPDATE business_days SET status='open', closed_by=NULL, closed_at=NULL, close_snapshot=NULL
    WHERE clinic_id=$1 AND id=$2 AND status='closed' AND NOT EXISTS (SELECT 1 FROM business_days o WHERE o.clinic_id=$1 AND o.status='open') RETURNING id`, [ctx.clinicId, dayId])).rows[0];
  await ctx.tx.query("SELECT set_config('clinora.reopen_day','',true)");
  if (!updated) return fail('INVALID_TRANSITION');
  await recordAudit(ctx.tx, ctx.actorId, ctx.clinicId, 'business_day.reopened', dayId, { version, reason });
  return view((await ctx.tx.query(`${SELECT} WHERE d.id=$1`, [dayId])).rows[0]);
}
