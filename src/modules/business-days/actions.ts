import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { BusinessDayView, CurrentDayView } from '../../contracts/clinic.js';
import { DomainError } from '../identity/access.js';
import { recordAudit, type ClinicContext } from '../../server/roles.js';

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

/** Closes an open day. close_snapshot is an empty placeholder until increment C8 fills it. */
export async function closeDay(ctx: ClinicContext, dayId: string): Promise<BusinessDayView> {
  const updated = (await ctx.tx.query(`UPDATE business_days SET status='closed', closed_by=$3, closed_at=now(), close_snapshot='{}'::jsonb
    WHERE clinic_id=$1 AND id=$2 AND status='open' RETURNING id`, [ctx.clinicId, dayId, ctx.actorId])).rows[0];
  if (!updated) {
    const exists = (await ctx.tx.query('SELECT 1 FROM business_days WHERE clinic_id=$1 AND id=$2', [ctx.clinicId, dayId])).rows[0];
    return fail(exists ? 'INVALID_TRANSITION' : 'NOT_FOUND');
  }
  await recordAudit(ctx.tx, ctx.actorId, ctx.clinicId, 'business_day.closed', dayId);
  return view((await ctx.tx.query(`${SELECT} WHERE d.id=$1`, [dayId])).rows[0]);
}
