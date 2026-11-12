import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { BusinessDayView, CurrentDayView } from '../../contracts/clinic.js';
import { DomainError } from '../identity/access.js';
import { recordAudit, type ClinicContext } from '../../server/roles.js';
import { computeReport } from '../reports/actions.js';
import { records } from '../reports/records.js';

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
  return view((await ctx.tx.query(`${SELECT} WHERE d.id=$1`, [id])).rows[0]);
}

/** Lock the day before reading its ledgers; shift/payment writers take the same lock. */
export async function closeDay(ctx: ClinicContext, dayId: string): Promise<BusinessDayView> {
  const day = (await ctx.tx.query('SELECT * FROM business_days WHERE clinic_id=$1 AND id=$2 FOR UPDATE',[ctx.clinicId,dayId])).rows[0];
  if (!day) return fail('NOT_FOUND');
  if (day.status !== 'open') return fail('INVALID_TRANSITION');
  if ((await ctx.tx.query("SELECT 1 FROM cash_shifts WHERE clinic_id=$1 AND business_day_id=$2 AND status='open'",[ctx.clinicId,dayId])).rowCount) return fail('INVALID_TRANSITION');
  const snapshot=computeReport(await records(ctx),{from:day.business_date,to:day.business_date});
  const updated = (await ctx.tx.query(`UPDATE business_days SET status='closed', closed_by=$3, closed_at=now(), close_snapshot=$4::jsonb
    WHERE clinic_id=$1 AND id=$2 AND status='open' RETURNING id`, [ctx.clinicId, dayId, ctx.actorId, JSON.stringify(snapshot)])).rows[0];
  if (!updated) {
    const exists = (await ctx.tx.query('SELECT 1 FROM business_days WHERE clinic_id=$1 AND id=$2', [ctx.clinicId, dayId])).rows[0];
    return fail(exists ? 'INVALID_TRANSITION' : 'NOT_FOUND');
  }
  await recordAudit(ctx.tx, ctx.actorId, ctx.clinicId, 'business_day.closed', dayId);
  await ctx.tx.query('INSERT INTO report_notices(id,clinic_id,business_day_id,totals) VALUES($1,$2,$3,$4)',[randomUUID(),ctx.clinicId,dayId,JSON.stringify({collected:snapshot.totals.collected,refunds:snapshot.totals.refunds,cashOuts:snapshot.totals.cashOuts})]);
  return view((await ctx.tx.query(`${SELECT} WHERE d.id=$1`, [dayId])).rows[0]);
}
