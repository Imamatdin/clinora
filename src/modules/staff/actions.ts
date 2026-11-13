import { randomInt, randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { StaffCreateInput, StaffRolesInput, StaffStatusInput, StaffView } from '../../contracts/clinic.js';
import { DomainError } from '../identity/access.js';
import { CEO_ONLY, Role, type Role as RoleName } from '../identity/roles.js';
import { recordAudit, type ClinicContext } from '../../server/roles.js';
import { passwordHash } from '../../server/security.js';
import { queueAccountNotice } from '../identity/approval-pin.js';

/*
 * Staff management server actions. Each takes a ClinicContext produced by requireRole
 * (caller already verified as CEO or administrator of ctx.clinicId) and validated input.
 * The UI and, later, the assistant call these through the same route; no logic lives in React.
 */

const fail = (code: ConstructorParameters<typeof DomainError>[0]): never => { throw new DomainError(code); };
// No 0/O/1/l/I to avoid misreading when the administrator dictates it.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
/** Temporary password, shown once to the administrator, never stored in plaintext or logs. */
export function temporaryPassword(): string {
  const groups = Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join(''));
  return groups.join('-');
}

type Target = { userId: string; status: string; managedHere: boolean; roles: RoleName[] };
async function target(ctx: ClinicContext, userId: string): Promise<Target> {
  const row = (await ctx.tx.query(`SELECT m.status, a.managed_by_clinic_id = m.clinic_id AS managed FROM memberships m
    JOIN accounts a ON a.id=m.user_id WHERE m.clinic_id=$1 AND m.user_id=$2 FOR UPDATE OF m`, [ctx.clinicId, userId])).rows[0];
  if (!row) return fail('NOT_FOUND');
  const roles = (await ctx.tx.query('SELECT role FROM membership_roles WHERE clinic_id=$1 AND user_id=$2', [ctx.clinicId, userId])).rows.map(r => Role.parse(r.role));
  return { userId, status: row.status, managedHere: row.managed === true, roles };
}
/** Nobody changes their own access here (prevents self-escalation and accidental lockout). */
function notSelf(ctx: ClinicContext, userId: string) { if (ctx.actorId === userId) fail('FORBIDDEN'); }
/** Granting, removing or touching the CEO role, or a CEO's account, requires the caller to be CEO. */
function ceoRule(ctx: ClinicContext, ...roleSets: RoleName[][]) {
  if (roleSets.some(set => set.some(r => CEO_ONLY.includes(r))) && !ctx.roles.includes('ceo')) fail('FORBIDDEN');
}

export async function listStaff(ctx: ClinicContext): Promise<StaffView[]> {
  const rows = (await ctx.tx.query(`SELECT m.user_id, a.display_name, a.login, a.phone, m.status, a.must_change_password,
      a.managed_by_clinic_id = m.clinic_id AS managed,
      coalesce(array_agg(r.role ORDER BY r.role) FILTER (WHERE r.role IS NOT NULL), '{}') AS roles
    FROM memberships m JOIN accounts a ON a.id=m.user_id
    LEFT JOIN membership_roles r ON r.clinic_id=m.clinic_id AND r.user_id=m.user_id
    WHERE m.clinic_id=$1 AND m.status IN ('active','blocked')
    GROUP BY m.user_id, a.display_name, a.login, a.phone, m.status, a.must_change_password, a.managed_by_clinic_id, m.clinic_id
    ORDER BY a.display_name, m.user_id`, [ctx.clinicId])).rows;
  return rows.map(r => ({ userId: r.user_id, fullName: r.display_name, login: r.login, phone: r.phone, roles: r.roles.map((x: string) => Role.parse(x)),
    status: r.status, managed: r.managed === true, mustChangePassword: r.must_change_password }));
}

async function writeRoles(ctx: ClinicContext, userId: string, roles: RoleName[]) {
  await ctx.tx.query('DELETE FROM membership_roles WHERE clinic_id=$1 AND user_id=$2', [ctx.clinicId, userId]);
  for (const role of roles) {
    await ctx.tx.query('INSERT INTO membership_roles(clinic_id,user_id,role,granted_by) VALUES($1,$2,$3,$4)', [ctx.clinicId, userId, role, ctx.actorId]);
  }
  // The task-002 notebook still gates clinical reads on clinical_access; keep it in step with the doctor role.
  await ctx.tx.query(`UPDATE memberships SET clinical_access=$3, role=CASE WHEN $3 THEN 'clinician' ELSE 'administrator' END, revision=revision+1
    WHERE clinic_id=$1 AND user_id=$2`, [ctx.clinicId, userId, roles.includes('doctor')]);
}

export async function createStaff(ctx: ClinicContext, input: z.infer<typeof StaffCreateInput>): Promise<{ staff: StaffView; temporaryPassword: string }> {
  ceoRule(ctx, input.roles);
  const taken = (await ctx.tx.query('SELECT login=$1 AS login FROM accounts WHERE login=$1 OR ($2::text IS NOT NULL AND phone=$2)', [input.login, input.phone])).rows;
  if (taken.length) fail('ALREADY_EXISTS');
  const userId = randomUUID(), password = temporaryPassword();
  await ctx.tx.query(`INSERT INTO accounts(id,email,login,phone,display_name,password_hash,must_change_password,managed_by_clinic_id)
    VALUES($1,NULL,$2,$3,$4,$5,true,$6)`, [userId, input.login, input.phone, input.fullName, await passwordHash(password), ctx.clinicId]);
  await ctx.tx.query(`INSERT INTO memberships(id,clinic_id,user_id,clinical_access,patient_scope,status,granted_by)
    VALUES($1,$2,$3,false,'assigned','active',$4)`, [randomUUID(), ctx.clinicId, userId, ctx.actorId]);
  await writeRoles(ctx, userId, input.roles);
  await recordAudit(ctx.tx, ctx.actorId, ctx.clinicId, 'staff.created', userId, { roles: input.roles });
  return { staff: { userId, fullName: input.fullName, login: input.login, phone: input.phone, roles: [...input.roles].sort(), status: 'active', managed: true, mustChangePassword: true }, temporaryPassword: password };
}

export async function changeRoles(ctx: ClinicContext, userId: string, input: z.infer<typeof StaffRolesInput>): Promise<{ roles: RoleName[] }> {
  notSelf(ctx, userId);
  const t = await target(ctx, userId);
  ceoRule(ctx, t.roles, input.roles);
  const roles = [...input.roles].sort();
  await writeRoles(ctx, userId, roles);
  await recordAudit(ctx.tx, ctx.actorId, ctx.clinicId, 'staff.roles_changed', userId, { before: t.roles, after: roles });
  return { roles };
}

export async function setStatus(ctx: ClinicContext, userId: string, input: z.infer<typeof StaffStatusInput>): Promise<{ status: 'active' | 'blocked' }> {
  notSelf(ctx, userId);
  const t = await target(ctx, userId);
  ceoRule(ctx, t.roles);
  if (!['active', 'blocked'].includes(t.status)) fail('INVALID_TRANSITION');
  await ctx.tx.query('UPDATE memberships SET status=$3, revision=revision+1 WHERE clinic_id=$1 AND user_id=$2', [ctx.clinicId, userId, input.status]);
  if (t.managedHere) {
    // An account this clinic created belongs to it alone: block sign-in entirely and end every session now.
    await ctx.tx.query('UPDATE accounts SET status=$2 WHERE id=$1', [userId, input.status]);
    if (input.status === 'blocked') await ctx.tx.query('DELETE FROM sessions WHERE user_id=$1', [userId]);
  }
  await recordAudit(ctx.tx, ctx.actorId, ctx.clinicId, input.status === 'blocked' ? 'staff.blocked' : 'staff.unblocked', userId);
  return { status: input.status };
}

export type PendingConfirmation = { pendingConfirmation: true; requestId: string };
const CONFIRMED_USE_MINUTES = 60;
/**
 * Task 022: an administrator who resets a doctor's password or issues their Telegram invite could then act as that
 * doctor. That reset needs a CEO's confirmation first (CEO accounts are already CEO-only). Returns null when the
 * caller may go ahead now (a CEO, a non-doctor target, or a confirmed request, which this call uses up);
 * otherwise the open request, created on first call and announced to the clinic's CEOs.
 */
export async function credentialGate(ctx: ClinicContext, userId: string, kind: 'password' | 'telegram'): Promise<PendingConfirmation | null> {
  if (ctx.roles.includes('ceo')) return null;
  const doctor = (await ctx.tx.query("SELECT 1 FROM membership_roles WHERE clinic_id=$1 AND user_id=$2 AND role='doctor'", [ctx.clinicId, userId])).rowCount;
  if (!doctor) return null;
  // Serialize concurrent requests for one target so only one request row (and one CEO notice) is created.
  await ctx.tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,22022))', [`${ctx.clinicId}:${userId}:${kind}`]);
  const used = (await ctx.tx.query(`UPDATE credential_requests SET used_at=now() WHERE id=(SELECT id FROM credential_requests
      WHERE clinic_id=$1 AND target_id=$2 AND kind=$3 AND requested_by=$4 AND confirmed_at IS NOT NULL AND used_at IS NULL AND expires_at>now()
      ORDER BY confirmed_at DESC LIMIT 1) RETURNING id`, [ctx.clinicId, userId, kind, ctx.actorId])).rows[0];
  if (used) { await recordAudit(ctx.tx, ctx.actorId, ctx.clinicId, 'staff.credential_request_used', used.id); return null; }
  const open = (await ctx.tx.query(`SELECT id FROM credential_requests WHERE clinic_id=$1 AND target_id=$2 AND kind=$3 AND requested_by=$4
      AND confirmed_at IS NULL AND used_at IS NULL AND expires_at>now() ORDER BY created_at DESC LIMIT 1`, [ctx.clinicId, userId, kind, ctx.actorId])).rows[0];
  if (open) return { pendingConfirmation: true, requestId: open.id };
  const requestId = randomUUID();
  await ctx.tx.query(`INSERT INTO credential_requests(id,clinic_id,target_id,kind,requested_by,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '24 hours')`,
    [requestId, ctx.clinicId, userId, kind, ctx.actorId]);
  await recordAudit(ctx.tx, ctx.actorId, ctx.clinicId, 'staff.credential_requested', requestId, { target: userId, kind });
  const ceos = (await ctx.tx.query(`SELECT r.user_id FROM membership_roles r JOIN memberships m ON m.clinic_id=r.clinic_id AND m.user_id=r.user_id AND m.status='active'
    WHERE r.clinic_id=$1 AND r.role='ceo'`, [ctx.clinicId])).rows;
  for (const ceo of ceos) await queueAccountNotice(ctx.tx, { accountId: ceo.user_id, clinicId: ctx.clinicId, kind: 'credential_request', actorId: ctx.actorId });
  return { pendingConfirmation: true, requestId };
}

/** Open requests for the CEO's confirmation screen: who asked, for whom, what. */
export async function credentialRequests(ctx: ClinicContext) {
  const rows = (await ctx.tx.query(`SELECT q.id, q.kind, q.created_at, q.target_id, t.display_name target, r.display_name requester
    FROM credential_requests q JOIN accounts t ON t.id=q.target_id JOIN accounts r ON r.id=q.requested_by
    WHERE q.clinic_id=$1 AND q.confirmed_at IS NULL AND q.used_at IS NULL AND q.expires_at>now() ORDER BY q.created_at`, [ctx.clinicId])).rows;
  return rows.map(r => ({ id: r.id as string, kind: r.kind as 'password' | 'telegram', createdAt: r.created_at.toISOString() as string,
    targetId: r.target_id as string, target: r.target as string, requester: r.requester as string }));
}
/** A CEO confirms one request. The administrator then repeats the reset within an hour; the confirmation is single-use. */
export async function confirmCredentialRequest(ctx: ClinicContext, requestId: string): Promise<{ confirmed: true }> {
  if (!ctx.roles.includes('ceo')) fail('FORBIDDEN');
  const row = (await ctx.tx.query(`UPDATE credential_requests SET confirmed_by=$3, confirmed_at=now(), expires_at=now()+make_interval(mins => $4)
    WHERE clinic_id=$1 AND id=$2 AND confirmed_at IS NULL AND used_at IS NULL AND expires_at>now() AND requested_by<>$3 RETURNING target_id, kind`,
    [ctx.clinicId, requestId, ctx.actorId, CONFIRMED_USE_MINUTES])).rows[0];
  if (!row) return fail('NOT_FOUND');
  await recordAudit(ctx.tx, ctx.actorId, ctx.clinicId, 'staff.credential_confirmed', requestId, { target: row.target_id, kind: row.kind });
  return { confirmed: true };
}

export async function resetPassword(ctx: ClinicContext, userId: string): Promise<{ temporaryPassword: string } | PendingConfirmation> {
  notSelf(ctx, userId);
  const t = await target(ctx, userId);
  ceoRule(ctx, t.roles);
  // An account another clinic or the person themself controls must never be taken over from here.
  if (!t.managedHere) fail('FORBIDDEN');
  const pending = await credentialGate(ctx, userId, 'password');
  if (pending) return pending;
  const password = temporaryPassword();
  await ctx.tx.query('UPDATE accounts SET password_hash=$2, must_change_password=true WHERE id=$1', [userId, await passwordHash(password)]);
  await ctx.tx.query('DELETE FROM sessions WHERE user_id=$1', [userId]);
  await recordAudit(ctx.tx, ctx.actorId, ctx.clinicId, 'staff.password_reset', userId);
  // The person learns of it on Telegram now and in the app on next sign-in, with who and when.
  await queueAccountNotice(ctx.tx, { accountId: userId, clinicId: ctx.clinicId, kind: 'password_reset', actorId: ctx.actorId });
  return { temporaryPassword: password };
}
