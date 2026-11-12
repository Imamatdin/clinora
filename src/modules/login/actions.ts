import type pg from 'pg';
import { transaction } from '../../server/database.js';
import { digest } from '../../server/security.js';
import { DomainError } from '../identity/access.js';
import { manageableMember } from '../telegram/links.js';
import { recordAudit, type ClinicContext } from '../../server/roles.js';

export class LoginLimited extends DomainError {
  constructor(public unlockAt: string) { super('RATE_LIMITED'); }
}
export const accountLimitKey = (userId: string) => digest('password-account:' + userId);

/** Serializes attempts across processes. Return errors from work, rather than throwing, so failures commit. */
export async function passwordLogin<T>(pool: pg.Pool, key: string, ip: string,
  work: (tx: pg.PoolClient) => Promise<{ ok: true; value: T } | { ok: false }>): Promise<T> {
  const result = await transaction(pool, async tx => {
    const ipKey = digest('password-ip:' + ip);
    // All login paths take IP then account locks. Unlock takes only the account lock.
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [ipKey]);
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
    const ipLimit = (await tx.query('SELECT attempts,reset_at,reset_at>clock_timestamp() active FROM login_limits WHERE key=$1', [ipKey])).rows[0];
    if (ipLimit?.active && ipLimit.attempts >= 300) return { limited: ipLimit.reset_at.toISOString() as string };
    await tx.query('INSERT INTO password_login_limits(key) VALUES($1) ON CONFLICT DO NOTHING', [key]);
    const limit = (await tx.query('SELECT locked_until,locked_until>clock_timestamp() locked FROM password_login_limits WHERE key=$1', [key])).rows[0]!;
    if (limit.locked) return { limited: limit.locked_until.toISOString() as string };
    // Expired lock starts a new consecutive-failure sequence. Unlocked failures do not expire.
    if (limit.locked_until) await tx.query('UPDATE password_login_limits SET failures=0,locked_until=NULL WHERE key=$1', [key]);
    const outcome = await work(tx);
    if (outcome.ok) {
      await tx.query('DELETE FROM password_login_limits WHERE key=$1', [key]);
      return { value: outcome.value };
    }
    await tx.query(`INSERT INTO login_limits(key,attempts,reset_at) VALUES($1,1,clock_timestamp()+interval '15 minutes')
      ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN login_limits.reset_at<=clock_timestamp() THEN 1 ELSE login_limits.attempts+1 END,
      reset_at=CASE WHEN login_limits.reset_at<=clock_timestamp() THEN clock_timestamp()+interval '15 minutes' ELSE login_limits.reset_at END`, [ipKey]);
    const after = (await tx.query(`UPDATE password_login_limits SET failures=failures+1,
      locked_until=CASE WHEN failures+1>=10 THEN clock_timestamp()+interval '15 minutes' ELSE NULL END WHERE key=$1 RETURNING locked_until`, [key])).rows[0]!;
    return after.locked_until ? { limited: after.locked_until.toISOString() as string } : { wrong: true };
  });
  if ('limited' in result) throw new LoginLimited(result.limited!);
  if ('wrong' in result) throw new DomainError('UNAUTHENTICATED');
  return result.value!;
}

/** Same managed-account and CEO protections as PIN unlock and Telegram link management. */
export async function unlockLogin(ctx: ClinicContext, userId: string): Promise<{ locked: false }> {
  await manageableMember(ctx, userId);
  const key = accountLimitKey(userId);
  await ctx.tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
  await ctx.tx.query('DELETE FROM password_login_limits WHERE key=$1', [key]);
  await recordAudit(ctx.tx, ctx.actorId, ctx.clinicId, 'login.unlocked', userId);
  return { locked: false };
}
