import { randomBytes, randomUUID } from 'node:crypto';
import { DomainError } from '../identity/access.js';
import { CEO_ONLY, Role } from '../identity/roles.js';
import { recordAudit, type ClinicContext } from '../../server/roles.js';
import { digest, passwordHash } from '../../server/security.js';
import type { Tx } from '../../server/database.js';

/*
 * Telegram linking. An invite is single-use, expires after 72 hours and is stored hashed.
 * Issuing a new invite revokes older open ones for that account. A link is an identity
 * binding only: clinic access is still decided by memberships and roles on every request.
 */

export const INVITE_HOURS = 72;
const fail = (code: ConstructorParameters<typeof DomainError>[0]): never => { throw new DomainError(code); };
/** 32 random bytes, base64url: 43 characters, valid as a Telegram /start parameter (max 64, [A-Za-z0-9_-]). */
export const inviteToken = () => randomBytes(32).toString('base64url');
export const InviteToken = /^[A-Za-z0-9_-]{43}$/;

/**
 * Whom a manager may invite or unlink: a member of this clinic whose account this clinic manages
 * (the same rule as password reset, so one clinic can never take over another clinic's account),
 * and a CEO's account only by a CEO. Nobody manages their own link here; they use the self routes.
 */
export async function manageableMember(ctx: ClinicContext, userId: string): Promise<void> {
  if (userId === ctx.actorId) fail('FORBIDDEN');
  const row = (await ctx.tx.query(`SELECT m.status, a.managed_by_clinic_id = m.clinic_id AS managed FROM memberships m JOIN accounts a ON a.id=m.user_id
    WHERE m.clinic_id=$1 AND m.user_id=$2 FOR UPDATE OF m`, [ctx.clinicId, userId])).rows[0];
  if (!row) return fail('NOT_FOUND');
  const roles = (await ctx.tx.query('SELECT role FROM membership_roles WHERE clinic_id=$1 AND user_id=$2', [ctx.clinicId, userId])).rows.map(r => Role.parse(r.role));
  if (roles.some(r => CEO_ONLY.includes(r)) && !ctx.roles.includes('ceo')) fail('FORBIDDEN');
  if (row.managed !== true) fail('FORBIDDEN');
  if (row.status !== 'active') fail('INVALID_TRANSITION');
}

export async function createInvite(ctx: ClinicContext, accountId: string): Promise<{ token: string; expiresAt: string }> {
  const token = inviteToken();
  await ctx.tx.query('UPDATE telegram_invites SET revoked_at=now() WHERE account_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL', [accountId]);
  const row = (await ctx.tx.query(`INSERT INTO telegram_invites(id,clinic_id,account_id,token_hash,created_by,expires_at)
    VALUES($1,$2,$3,$4,$5,now()+make_interval(hours => $6)) RETURNING expires_at`, [randomUUID(), ctx.clinicId, accountId, digest(token), ctx.actorId, INVITE_HOURS])).rows[0];
  await recordAudit(ctx.tx, ctx.actorId, ctx.clinicId, 'telegram.invite_created', accountId);
  return { token, expiresAt: row.expires_at.toISOString() };
}

/** Removes the link, revokes open invites and ends Telegram sessions immediately. */
export async function unlink(ctx: ClinicContext, accountId: string): Promise<{ linked: false }> {
  await ctx.tx.query('DELETE FROM telegram_links WHERE account_id=$1', [accountId]);
  await ctx.tx.query('UPDATE telegram_invites SET revoked_at=now() WHERE account_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL', [accountId]);
  await ctx.tx.query("DELETE FROM sessions WHERE user_id=$1 AND via='telegram'", [accountId]);
  await recordAudit(ctx.tx, ctx.actorId, ctx.clinicId, 'telegram.unlinked', accountId);
  return { linked: false };
}

type OpenInvite = { id: string; clinicId: string; accountId: string; name: string; clinicName: string };
/** An invite that can still be used, with the account it binds. Locks the invite row when `lock` is set. */
export async function openInvite(tx: Tx, token: string, lock: boolean): Promise<OpenInvite | null> {
  if (!InviteToken.test(token)) return null;
  const row = (await tx.query(`SELECT i.id, i.clinic_id, i.account_id, a.display_name, c.name clinic_name FROM telegram_invites i
      JOIN accounts a ON a.id=i.account_id AND a.status='active'
      JOIN memberships m ON m.clinic_id=i.clinic_id AND m.user_id=i.account_id AND m.status='active'
      JOIN clinics c ON c.id=i.clinic_id
     WHERE i.token_hash=$1 AND i.consumed_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>now()
     ${lock ? 'FOR UPDATE OF i' : ''}`, [digest(token)])).rows[0];
  return row ? { id: row.id, clinicId: row.clinic_id, accountId: row.account_id, name: row.display_name, clinicName: row.clinic_name } : null;
}

/**
 * Binds a Telegram user to the invited account. The same invite can never be used twice; a
 * Telegram user already bound to another account is refused (unlink there first).
 */
export async function consumeInvite(tx: Tx, token: string, telegramUserId: number): Promise<'linked' | 'invalid' | 'taken'> {
  const invite = await openInvite(tx, token, true);
  if (!invite) return 'invalid';
  const other = (await tx.query('SELECT account_id FROM telegram_links WHERE telegram_user_id=$1 FOR UPDATE', [telegramUserId])).rows[0];
  if (other && other.account_id !== invite.accountId) return 'taken';
  await tx.query('DELETE FROM telegram_links WHERE account_id=$1', [invite.accountId]);
  await tx.query('INSERT INTO telegram_links(account_id,telegram_user_id,clinic_id) VALUES($1,$2,$3)', [invite.accountId, telegramUserId, invite.clinicId]);
  await tx.query('UPDATE telegram_invites SET consumed_at=now(), consumed_by_telegram_id=$2 WHERE id=$1', [invite.id, telegramUserId]);
  // A previous phone's Mini App sessions end; the newly linked Telegram signs in fresh.
  await tx.query("DELETE FROM sessions WHERE user_id=$1 AND via='telegram'", [invite.accountId]);
  // A temporary password the administrator saw stops working once the person proves possession
  // of their own Telegram account; they sign in through Telegram (and a PIN on clinic PCs) instead.
  await tx.query(`UPDATE accounts SET password_hash=$2, must_change_password=false WHERE id=$1 AND must_change_password`,
    [invite.accountId, await passwordHash(randomBytes(32).toString('hex'))]);
  await recordAudit(tx, invite.accountId, invite.clinicId, 'telegram.linked', invite.accountId);
  return 'linked';
}
