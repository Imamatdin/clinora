import { accountLimitKey } from '../login/actions.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Id } from '../../contracts/index.js';
import { DomainError } from '../identity/access.js';
import { CEO_ONLY, Role } from '../identity/roles.js';
import { recordAudit, type ClinicContext } from '../../server/roles.js';
import { digest, passwordHash, passwordMatches, token } from '../../server/security.js';
import type { Tx } from '../../server/database.js';

/*
 * Shared clinic computers and PIN user switching.
 * - A device is enrolled once by a manager; the browser keeps the raw token in an httpOnly cookie.
 * - On an enrolled device a staff member picks their name and enters a 4-6 digit PIN.
 * - Wrong PINs count per account, never per IP: five wrong tries lock that PIN until a manager
 *   unlocks it or the person sets a new PIN from their own signed-in phone or computer.
 */

export const PIN_MAX_ATTEMPTS = 5;
export const DEVICE_IDLE_MINUTES = 10;
const fail = (code: ConstructorParameters<typeof DomainError>[0]): never => { throw new DomainError(code); };

/** Rejects PINs that are trivially guessed: one repeated digit, or a straight run up or down. */
export function weakPin(pin: string): boolean {
  if (/^(\d)\1+$/.test(pin)) return true;
  const digits = [...pin].map(Number);
  const steps = new Set(digits.slice(1).map((d, i) => d - digits[i]!));
  return steps.size === 1 && (steps.has(1) || steps.has(-1));
}
export const Pin = z.string().regex(/^[0-9]{4,6}$/).refine(pin => !weakPin(pin), 'PIN too simple');
export const PinInput = z.object({ pin: Pin }).strict();
export const UnlockInput = z.object({ userId: Id, pin: z.string().regex(/^[0-9]{4,6}$/) }).strict();
export const EnrollInput = z.object({ label: z.string().trim().min(1).max(80) }).strict();

export type DeviceView = { id: string; label: string; createdAt: string; createdBy: string; revokedAt: string | null; activeSessions: number };
export type ActiveDevice = { id: string; clinicId: string; clinicName: string; label: string };

// --- Enrolment (managers) ---------------------------------------------------------------

export async function enrollDevice(ctx: ClinicContext, label: string): Promise<{ device: { id: string; label: string }; rawToken: string }> {
  const id = randomUUID(), raw = token();
  await ctx.tx.query('INSERT INTO devices(id,clinic_id,label,token_hash,created_by) VALUES($1,$2,$3,$4,$5)', [id, ctx.clinicId, label, digest(raw), ctx.actorId]);
  await recordAudit(ctx.tx, ctx.actorId, ctx.clinicId, 'device.enrolled', id);
  return { device: { id, label }, rawToken: raw };
}

export async function listDevices(ctx: ClinicContext): Promise<DeviceView[]> {
  const rows = (await ctx.tx.query(`SELECT d.id, d.label, d.created_at, d.revoked_at, a.display_name created_by,
      (SELECT count(*)::int FROM sessions s WHERE s.device_id=d.id AND s.expires_at>now() AND s.last_seen_at>now()-make_interval(mins => $2)) active
    FROM devices d JOIN accounts a ON a.id=d.created_by WHERE d.clinic_id=$1 ORDER BY d.revoked_at NULLS FIRST, d.created_at DESC`, [ctx.clinicId, DEVICE_IDLE_MINUTES])).rows;
  return rows.map(r => ({ id: r.id, label: r.label, createdAt: r.created_at.toISOString(), createdBy: r.created_by, revokedAt: r.revoked_at?.toISOString() ?? null, activeSessions: r.active }));
}

/** Revocation is immediate: the token stops working and every session started on the device ends. */
export async function revokeDevice(ctx: ClinicContext, deviceId: string): Promise<{ revoked: true }> {
  const row = (await ctx.tx.query('UPDATE devices SET revoked_at=now(), revoked_by=$3 WHERE clinic_id=$1 AND id=$2 AND revoked_at IS NULL RETURNING id',
    [ctx.clinicId, deviceId, ctx.actorId])).rows[0];
  if (!row) {
    const exists = (await ctx.tx.query('SELECT 1 FROM devices WHERE clinic_id=$1 AND id=$2', [ctx.clinicId, deviceId])).rows[0];
    return fail(exists ? 'INVALID_TRANSITION' : 'NOT_FOUND');
  }
  await ctx.tx.query('DELETE FROM sessions WHERE device_id=$1', [deviceId]);
  await recordAudit(ctx.tx, ctx.actorId, ctx.clinicId, 'device.revoked', deviceId);
  return { revoked: true };
}

// --- Device-side (device cookie, no person signed in) ------------------------------------

export async function activeDevice(tx: Tx, rawToken: string | null): Promise<ActiveDevice | null> {
  if (!rawToken || !/^[a-f0-9]{64}$/.test(rawToken)) return null;
  const row = (await tx.query(`SELECT d.id, d.clinic_id, d.label, c.name FROM devices d JOIN clinics c ON c.id=d.clinic_id
    WHERE d.token_hash=$1 AND d.revoked_at IS NULL`, [digest(rawToken)])).rows[0];
  return row ? { id: row.id, clinicId: row.clinic_id, clinicName: row.name, label: row.label } : null;
}

/** People who may switch in on this device: active members with a role, an active account and a PIN. */
export async function pickerStaff(tx: Tx, device: ActiveDevice): Promise<{ userId: string; name: string; locked: boolean }[]> {
  const rows = (await tx.query(`SELECT a.id, a.display_name, p.locked_at IS NOT NULL locked FROM memberships m
      JOIN accounts a ON a.id=m.user_id AND a.status='active' AND NOT a.must_change_password
      JOIN account_pins p ON p.account_id=a.id
     WHERE m.clinic_id=$1 AND m.status='active' AND EXISTS(SELECT 1 FROM membership_roles r WHERE r.clinic_id=m.clinic_id AND r.user_id=m.user_id)
     ORDER BY a.display_name, a.id`, [device.clinicId])).rows;
  return rows.map(r => ({ userId: r.id, name: r.display_name, locked: r.locked }));
}

/**
 * Checks a PIN for a person on an enrolled device. The caller must COMMIT before reporting a
 * wrong or locked result, so a failed request never rolls the attempt counter back.
 */
export async function checkPin(tx: Tx, device: ActiveDevice, userId: string, pin: string): Promise<'ok' | 'wrong' | 'locked' | 'unavailable'> {
  const row = (await tx.query(`SELECT p.pin_hash, p.locked_at FROM account_pins p
      JOIN accounts a ON a.id=p.account_id AND a.status='active' AND NOT a.must_change_password
      JOIN memberships m ON m.user_id=a.id AND m.clinic_id=$2 AND m.status='active'
     WHERE p.account_id=$1 AND EXISTS(SELECT 1 FROM membership_roles r WHERE r.clinic_id=m.clinic_id AND r.user_id=m.user_id)
     FOR UPDATE OF p`, [userId, device.clinicId])).rows[0];
  if (!row) { await passwordMatches(pin, '00000000000000000000000000000000:' + '00'.repeat(64)); return 'unavailable'; }
  if (row.locked_at) return 'locked';
  if (await passwordMatches(pin, row.pin_hash)) {
    await tx.query('UPDATE account_pins SET failed_attempts=0 WHERE account_id=$1', [userId]);
    return 'ok';
  }
  const after = (await tx.query(`UPDATE account_pins SET failed_attempts=failed_attempts+1,
      locked_at=CASE WHEN failed_attempts+1>=$2 THEN now() ELSE NULL END WHERE account_id=$1 RETURNING locked_at`, [userId, PIN_MAX_ATTEMPTS])).rows[0];
  await recordAudit(tx, userId, device.clinicId, after.locked_at ? 'pin.locked' : 'pin.failed', device.id);
  return after.locked_at ? 'locked' : 'wrong';
}

// --- The person's own PIN, and manager unlock ---------------------------------------------

/** Setting a new PIN also clears any lockout: it proves control of a signed-in session. */
export async function setOwnPin(tx: Tx, userId: string, pin: string): Promise<{ pinSet: true }> {
  const hash = await passwordHash(pin);
  await tx.query(`INSERT INTO account_pins(account_id,pin_hash) VALUES($1,$2)
    ON CONFLICT(account_id) DO UPDATE SET pin_hash=EXCLUDED.pin_hash, failed_attempts=0, locked_at=NULL, updated_at=now()`, [userId, hash]);
  await tx.query('INSERT INTO audit_events(id,actor_id,clinic_id,action,resource_id) VALUES($1,$2,NULL,$3,$2)', [randomUUID(), userId, 'pin.set']);
  return { pinSet: true };
}

/** A manager unlocks a locked PIN of a member whose account this clinic manages (CEO accounts only by a CEO). */
export async function unlockPin(ctx: ClinicContext, userId: string): Promise<{ locked: false }> {
  if (userId === ctx.actorId) fail('FORBIDDEN');
  const member = (await ctx.tx.query(`SELECT a.managed_by_clinic_id = m.clinic_id AS managed FROM memberships m JOIN accounts a ON a.id=m.user_id
    WHERE m.clinic_id=$1 AND m.user_id=$2`, [ctx.clinicId, userId])).rows[0];
  if (!member) return fail('NOT_FOUND');
  const roles = (await ctx.tx.query('SELECT role FROM membership_roles WHERE clinic_id=$1 AND user_id=$2', [ctx.clinicId, userId])).rows.map(r => Role.parse(r.role));
  if (roles.some(r => CEO_ONLY.includes(r)) && !ctx.roles.includes('ceo')) fail('FORBIDDEN');
  if (member.managed !== true) fail('FORBIDDEN');
  const row = (await ctx.tx.query('UPDATE account_pins SET failed_attempts=0, locked_at=NULL WHERE account_id=$1 AND locked_at IS NOT NULL RETURNING account_id', [userId])).rows[0];
  if (!row) fail('INVALID_TRANSITION');
  await recordAudit(ctx.tx, ctx.actorId, ctx.clinicId, 'pin.unlocked', userId);
  return { locked: false };
}

/** Access summary per staff member for the manager's staff screen. */
export async function staffAccess(ctx: ClinicContext): Promise<{ userId: string; telegramLinked: boolean; invitePending: boolean; pinSet: boolean; pinLocked: boolean; loginUnlockAt: string | null }[]> {
  const rows = (await ctx.tx.query(`SELECT m.user_id,
      EXISTS(SELECT 1 FROM telegram_links l WHERE l.account_id=m.user_id) linked,
      EXISTS(SELECT 1 FROM telegram_invites i WHERE i.account_id=m.user_id AND i.clinic_id=m.clinic_id AND i.consumed_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>now()) pending,
      p.account_id IS NOT NULL pin_set, coalesce(p.locked_at IS NOT NULL,false) pin_locked
    FROM memberships m LEFT JOIN account_pins p ON p.account_id=m.user_id
    WHERE m.clinic_id=$1 AND m.status IN ('active','blocked') ORDER BY m.user_id`, [ctx.clinicId])).rows;
  const limits = (await ctx.tx.query('SELECT key,locked_until FROM password_login_limits WHERE locked_until>now() AND key=ANY($1::text[])', [rows.map(r => accountLimitKey(r.user_id))])).rows;
  const locked = new Map(limits.map(r => [r.key, r.locked_until.toISOString() as string]));
  return rows.map(r => ({ loginUnlockAt: locked.get(accountLimitKey(r.user_id)) ?? null, userId: r.user_id, telegramLinked: r.linked, invitePending: r.pending, pinSet: r.pin_set, pinLocked: r.pin_locked }));
}

export async function myAccess(ctx: ClinicContext): Promise<{ telegramLinked: boolean; pinSet: boolean; pinLocked: boolean }> {
  const r = (await ctx.tx.query(`SELECT EXISTS(SELECT 1 FROM telegram_links WHERE account_id=$1) linked,
      (SELECT locked_at IS NOT NULL FROM account_pins WHERE account_id=$1) locked`, [ctx.actorId])).rows[0];
  return { telegramLinked: r.linked, pinSet: r.locked !== null, pinLocked: r.locked === true };
}
