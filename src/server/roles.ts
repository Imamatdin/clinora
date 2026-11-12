import { randomUUID } from 'node:crypto';
import { DomainError } from '../modules/identity/access.js';
import { Role, type Role as RoleName } from '../modules/identity/roles.js';
import type { Tx } from './database.js';

/** The verified caller of a clinic action. Built only by requireRole from database state. */
export type ClinicContext = { tx: Tx; actorId: string; clinicId: string; roles: RoleName[]; approvalDeviceKey?:string };

/**
 * The single guard for clinic routes. Reads the membership and its roles from the database
 * on every request, so a removed role or blocked membership takes effect on the next request.
 * Not a member (or membership not active) -> NOT_FOUND, so other clinics are indistinguishable
 * from missing ones. Member without any of the required roles -> FORBIDDEN.
 */
export async function requireRole(tx: Tx, actorId: string, clinicId: string, allowed: readonly RoleName[]): Promise<ClinicContext> {
  const member = (await tx.query(
    "SELECT 1 FROM memberships WHERE clinic_id=$1 AND user_id=$2 AND status='active' FOR SHARE", [clinicId, actorId])).rows[0];
  if (!member) throw new DomainError('NOT_FOUND');
  const roles = (await tx.query('SELECT role FROM membership_roles WHERE clinic_id=$1 AND user_id=$2 ORDER BY role FOR SHARE',
    [clinicId, actorId])).rows.map(r => Role.parse(r.role));
  if (!roles.some(r => allowed.includes(r))) throw new DomainError('FORBIDDEN');
  return { tx, actorId, clinicId, roles };
}

export const recordAudit = (tx: Tx, actorId: string, clinicId: string | null, action: string, resourceId: string, detail: Record<string, unknown> | null = null) =>
  tx.query('INSERT INTO audit_events(id,actor_id,clinic_id,action,resource_id,detail) VALUES($1,$2,$3,$4,$5,$6)',
    [randomUUID(), actorId, clinicId, action, resourceId, detail === null ? null : JSON.stringify(detail)]);
