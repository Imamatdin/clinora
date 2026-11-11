import { randomUUID } from 'node:crypto';
import type { Approval, DocumentVersion, Membership, Principal } from '../src/contracts/index.js';

export const ids = { user: randomUUID(), otherUser: randomUUID(), clinic: randomUUID(), otherClinic: randomUUID(), patient: randomUUID(), otherPatient: randomUUID(), admin: randomUUID() };
export const now = new Date('2026-11-11T15:00:00Z');
export const scope = { clinicId: ids.clinic, patientId: ids.patient };
export const principal: Principal = { userId: ids.user, sessionId: randomUUID(), accountStatus: 'active', expiresAt: '2026-11-11T16:00:00Z' };
export const membership: Membership = {
  id: randomUUID(), userId: ids.user, clinicId: ids.clinic, role: 'clinician', status: 'active', revision: 1,
  grant: { by: ids.admin, at: '2026-11-10T00:00:00Z' }, patientScope: { kind: 'clinic' }
};
export const version: DocumentVersion = {
  id: randomUUID(), documentId: randomUUID(), encounterId: randomUUID(), ...scope,
  revision: 2, parentVersionId: randomUUID(), kind: 'clinician_edit',
  fields: [{ key: 'reported_duration', value: 'three days', category: 'reported', status: 'clinician_confirmed', origin: 'clinician', revision: 1, evidence: [], editedBy: ids.user, unresolvedConflict: null }],
  createdBy: ids.user, createdAt: '2026-11-11T14:00:00Z', amendsApprovalId: null, amendmentReason: null
};
export const approval: Approval = {
  id: randomUUID(), documentId: version.documentId, versionId: version.id, revision: version.revision,
  ...scope, approvedBy: ids.user, approvedAt: now.toISOString()
};
