import { Approval, DocumentVersion, type ResourceScope } from '../../contracts/index.js';
import { DomainError, requireClinicalAccess } from '../identity/access.js';

export function requireApprovableVersion(input: {
  principal: unknown; membership: unknown; scope: ResourceScope; version: unknown;
  currentVersionId: string; expectedRevision: number; existingApproval: unknown | null; now: Date;
}): DocumentVersion {
  requireClinicalAccess(input.principal, input.membership, input.scope, input.now);
  const result = DocumentVersion.safeParse(input.version);
  if (!result.success) throw new DomainError('INVALID_INPUT');
  const v = result.data;
  if (v.clinicId !== input.scope.clinicId || v.patientId !== input.scope.patientId) throw new DomainError('FORBIDDEN');
  if (v.id !== input.currentVersionId || v.revision !== input.expectedRevision) throw new DomainError('STALE_VERSION');
  if (input.existingApproval !== null || v.kind === 'ai_draft' || v.fields.length === 0 ||
    v.fields.some(f => f.unresolvedConflict !== null || f.status === 'proposed' || f.status === 'uncertain')) {
    throw new DomainError('INVALID_TRANSITION');
  }
  return v;
}

/** Export always rechecks authorization and resolves the exact approved snapshot on the server. */
export function requireExportableVersion(input: {
  principal: unknown; membership: unknown; scope: ResourceScope; version: unknown;
  approval: unknown; currentVersionId: string; now: Date;
}): DocumentVersion {
  requireClinicalAccess(input.principal, input.membership, input.scope, input.now);
  const v = DocumentVersion.safeParse(input.version), a = Approval.safeParse(input.approval);
  if (!v.success || !a.success) throw new DomainError('INVALID_INPUT');
  if ([v.data, a.data].some(x => x.clinicId !== input.scope.clinicId || x.patientId !== input.scope.patientId)) throw new DomainError('FORBIDDEN');
  if (v.data.id !== input.currentVersionId || a.data.versionId !== v.data.id ||
    a.data.documentId !== v.data.documentId || a.data.revision !== v.data.revision) throw new DomainError('STALE_VERSION');
  return v.data;
}
