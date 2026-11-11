import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DomainError } from '../src/modules/identity/access.js';
import { requireApprovableVersion, requireExportableVersion } from '../src/modules/documents/policy.js';
import { approval, ids, membership, now, principal, scope, version } from './fixtures.js';

const base = { principal, membership, scope, version, currentVersionId: version.id, expectedRevision: version.revision, existingApproval: null, now };
const throwsCode = (fn: () => unknown, code: string) => assert.throws(fn, (e: unknown) => e instanceof DomainError && e.code === code);
test('approval requires the current reviewed version and explicit eligible actor', () => {
  assert.deepEqual(requireApprovableVersion(base), version);
  throwsCode(() => requireApprovableVersion({ ...base, expectedRevision: 1 }), 'STALE_VERSION');
  throwsCode(() => requireApprovableVersion({ ...base, currentVersionId: randomUUID() }), 'STALE_VERSION');
  throwsCode(() => requireApprovableVersion({ ...base, version: { ...version, kind: 'ai_draft' } }), 'INVALID_TRANSITION');
  throwsCode(() => requireApprovableVersion({ ...base, existingApproval: approval }), 'INVALID_TRANSITION');
  throwsCode(() => requireApprovableVersion({ ...base, membership: { ...membership, status: 'revoked' } }), 'FORBIDDEN');
  throwsCode(() => requireApprovableVersion({ ...base, version: { ...version, patientId: ids.otherPatient } }), 'FORBIDDEN');
  throwsCode(() => requireApprovableVersion({ ...base, version: { ...version, fields: [] } }), 'INVALID_TRANSITION');
  throwsCode(() => requireApprovableVersion({ ...base, version: { ...version, fields: version.fields.map(f => ({ ...f, unresolvedConflict: 'Conflicting duration' })) } }), 'INVALID_TRANSITION');
});
test('export rejects mismatched approvals, stale content and revoked access', () => {
  const input = { ...base, approval };
  assert.deepEqual(requireExportableVersion(input), version);
  throwsCode(() => requireExportableVersion({ ...input, approval: { ...approval, versionId: randomUUID() } }), 'STALE_VERSION');
  throwsCode(() => requireExportableVersion({ ...input, approval: { ...approval, documentId: randomUUID() } }), 'STALE_VERSION');
  throwsCode(() => requireExportableVersion({ ...input, currentVersionId: randomUUID() }), 'STALE_VERSION');
  throwsCode(() => requireExportableVersion({ ...input, approval: { ...approval, clinicId: ids.otherClinic } }), 'FORBIDDEN');
  throwsCode(() => requireExportableVersion({ ...input, membership: { ...membership, status: 'revoked' } }), 'FORBIDDEN');
});
