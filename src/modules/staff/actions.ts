import { randomInt, randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { StaffCreateInput, StaffRolesInput, StaffStatusInput, StaffView } from '../../contracts/clinic.js';
import { DomainError } from '../identity/access.js';
import { CEO_ONLY, Role, type Role as RoleName } from '../identity/roles.js';
import { recordAudit, type ClinicContext } from '../../server/roles.js';
import { passwordHash } from '../../server/security.js';

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

export async function resetPassword(ctx: ClinicContext, userId: string): Promise<{ temporaryPassword: string }> {
  notSelf(ctx, userId);
  const t = await target(ctx, userId);
  ceoRule(ctx, t.roles);
  // An account another clinic or the person themself controls must never be taken over from here.
  if (!t.managedHere) fail('FORBIDDEN');
  const password = temporaryPassword();
  await ctx.tx.query('UPDATE accounts SET password_hash=$2, must_change_password=true WHERE id=$1', [userId, await passwordHash(password)]);
  await ctx.tx.query('DELETE FROM sessions WHERE user_id=$1', [userId]);
  await recordAudit(ctx.tx, ctx.actorId, ctx.clinicId, 'staff.password_reset', userId);
  return { temporaryPassword: password };
}
