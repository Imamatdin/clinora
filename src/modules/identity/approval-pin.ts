import { randomUUID } from 'node:crypto';
import { DomainError } from './access.js';
import { recordAudit, type ClinicContext } from '../../server/roles.js';
import { dummyHash, passwordMatches } from '../../server/security.js';
import type { Tx } from '../../server/database.js';

/*
 * Task 022: approval PINs (cashier discounts/refunds/voids and out-of-stock ward dispenses).
 * - One failure counter per approver account, across every device, session and approval kind.
 * - Five failures lock approving until a CEO or another administrator clears it. No time-based expiry.
 * - CEO and administrator PINs need at least 6 digits; an older or shorter PIN approves nothing until changed.
 * - Callers validate the target (visit, payment, stay) first, so a guess against nothing is never counted,
 *   and must COMMIT before reporting a refusal so the counter is never rolled back.
 */

export const APPROVAL_MAX_ATTEMPTS = 5;
export const APPROVER_PIN_DIGITS = 6;
const fail = (code: ConstructorParameters<typeof DomainError>[0]): never => { throw new DomainError(code); };

/** Queues a notice about the person's own account: shown on next sign-in and sent once to their Telegram. */
export async function queueAccountNotice(tx: Tx, n: { accountId: string; clinicId: string; kind: 'password_reset' | 'telegram_invite' | 'approval_locked' | 'credential_request'; actorId: string | null }) {
  const name = n.actorId ? (await tx.query('SELECT display_name FROM accounts WHERE id=$1', [n.actorId])).rows[0]?.display_name ?? null : null;
  // The chat is fixed now, so a Telegram re-link made right after an invite cannot redirect the warning to the new chat.
  const chat = (await tx.query("SELECT l.telegram_user_id::text chat FROM telegram_links l JOIN accounts a ON a.id=l.account_id AND a.status='active' WHERE l.account_id=$1", [n.accountId])).rows[0]?.chat ?? null;
  await tx.query(`INSERT INTO account_notices(id,account_id,clinic_id,kind,actor_id,actor_name,telegram_chat,telegram_done_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,CASE WHEN $7::bigint IS NULL THEN now() END)`, [randomUUID(), n.accountId, n.clinicId, n.kind, n.actorId, name, chat]);
}

/** True when the approver's PIN is accepted. Anything else (unknown approver, short PIN, locked, wrong) is false. */
export async function verifyApproverPin(ctx: ClinicContext, approverId: string, pin: string): Promise<boolean> {
  const approver = (await ctx.tx.query(`SELECT p.pin_hash, p.pin_digits FROM account_pins p
      JOIN accounts a ON a.id=p.account_id AND a.status='active' AND NOT a.must_change_password
      JOIN memberships m ON m.user_id=a.id AND m.clinic_id=$2 AND m.status='active'
     WHERE p.account_id=$1 AND EXISTS(SELECT 1 FROM membership_roles r WHERE r.clinic_id=m.clinic_id AND r.user_id=m.user_id AND r.role IN ('ceo','administrator'))`,
    [approverId, ctx.clinicId])).rows[0];
  if (!approver) { await passwordMatches(pin, dummyHash); return false; }
  // One row per approver, locked: parallel guesses from several PCs are counted one after another.
  await ctx.tx.query('INSERT INTO approval_pin_attempts(account_id) VALUES($1) ON CONFLICT DO NOTHING', [approverId]);
  const attempts = (await ctx.tx.query('SELECT failed_attempts, locked_at FROM approval_pin_attempts WHERE account_id=$1 FOR UPDATE', [approverId])).rows[0];
  if (attempts.locked_at) { await passwordMatches(pin, dummyHash); return false; }
  // An approver PIN shorter than 6 digits (or set before task 022) cannot approve; guessing it gains nothing, so it is not counted.
  if ((approver.pin_digits ?? 0) < APPROVER_PIN_DIGITS) { await passwordMatches(pin, dummyHash); return false; }
  if (await passwordMatches(pin, approver.pin_hash)) {
    if (attempts.failed_attempts) await ctx.tx.query('UPDATE approval_pin_attempts SET failed_attempts=0 WHERE account_id=$1', [approverId]);
    return true;
  }
  const failed = Math.min(attempts.failed_attempts + 1, APPROVAL_MAX_ATTEMPTS), locked = failed >= APPROVAL_MAX_ATTEMPTS;
  await ctx.tx.query('UPDATE approval_pin_attempts SET failed_attempts=$2, locked_at=CASE WHEN $3 THEN now() ELSE NULL END WHERE account_id=$1', [approverId, failed, locked]);
  await recordAudit(ctx.tx, ctx.actorId, ctx.clinicId, 'approval.pin_failed', approverId, { deviceId: ctx.deviceId ?? null, attempt: failed });
  if (locked) {
    await recordAudit(ctx.tx, ctx.actorId, ctx.clinicId, 'approval.locked', approverId);
    await queueAccountNotice(ctx.tx, { accountId: approverId, clinicId: ctx.clinicId, kind: 'approval_locked', actorId: null });
  }
  return false;
}

/** A CEO or another administrator clears an approver's lock. Nobody clears their own. Audited. */
export async function clearApprovalLock(ctx: ClinicContext, userId: string): Promise<{ approvalLocked: false }> {
  if (userId === ctx.actorId) fail('FORBIDDEN');
  if (!(await ctx.tx.query('SELECT 1 FROM memberships WHERE clinic_id=$1 AND user_id=$2', [ctx.clinicId, userId])).rowCount) fail('NOT_FOUND');
  const row = (await ctx.tx.query('UPDATE approval_pin_attempts SET failed_attempts=0, locked_at=NULL WHERE account_id=$1 AND locked_at IS NOT NULL RETURNING account_id', [userId])).rows[0];
  if (!row) fail('INVALID_TRANSITION');
  await recordAudit(ctx.tx, ctx.actorId, ctx.clinicId, 'approval.unlocked', userId);
  return { approvalLocked: false };
}

/** Whether this account must set a new PIN before approving: it holds CEO/administrator somewhere and its PIN is missing, older or short. */
export async function approverPinChangeRequired(tx: Tx, accountId: string): Promise<boolean> {
  const row = (await tx.query(`SELECT EXISTS(SELECT 1 FROM membership_roles r JOIN memberships m ON m.clinic_id=r.clinic_id AND m.user_id=r.user_id AND m.status='active'
      WHERE r.user_id=$1 AND r.role IN ('ceo','administrator')) approver,
    (SELECT pin_digits FROM account_pins WHERE account_id=$1) digits, EXISTS(SELECT 1 FROM account_pins WHERE account_id=$1) has_pin`, [accountId])).rows[0];
  return row.approver && row.has_pin && (row.digits ?? 0) < APPROVER_PIN_DIGITS;
}
