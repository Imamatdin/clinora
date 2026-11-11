import { Membership, Principal, type ResourceScope, type ErrorCode } from '../../contracts/index.js';

export class DomainError extends Error {
  constructor(public readonly code: ErrorCode) { super(code); }
}

/** Server-only policy primitive. Call using freshly loaded session and membership, never request claims. */
export function requireClinicalAccess(
  principalInput: unknown, membershipInput: unknown, resource: ResourceScope, now: Date
): { principal: Principal; membership: Membership } {
  const p = Principal.safeParse(principalInput);
  if (!p.success || !Number.isFinite(now.valueOf()) || Date.parse(p.data.expiresAt) <= now.valueOf() || p.data.accountStatus !== 'active') {
    throw new DomainError('UNAUTHENTICATED');
  }
  const m = Membership.safeParse(membershipInput);
  if (!m.success || m.data.userId !== p.data.userId || m.data.clinicId !== resource.clinicId ||
    m.data.status !== 'active' || m.data.role !== 'clinician' || !m.data.grant ||
    Date.parse(m.data.grant.at) > now.valueOf() ||
    (m.data.patientScope.kind === 'assigned' && !m.data.patientScope.patientIds.includes(resource.patientId))) {
    throw new DomainError('FORBIDDEN');
  }
  return { principal: p.data, membership: m.data };
}
