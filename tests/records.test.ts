import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ClinicalField, DocumentVersion, Encounter, Occurrence, PatientLink, TranscriptSegment } from '../src/contracts/index.js';
import { ids, now, scope, version } from './fixtures.js';

test('retrospective and date-only occurrence survive independently of entry time', () => {
  const occurrence = { precision: 'date', date: '2020-02-29', timezone: 'Asia/Tashkent' };
  const encounter = Encounter.parse({ id: randomUUID(), ...scope, clinicianId: ids.user,
    location: { id: null, label: 'Synthetic clinic' }, specialty: 'general_medicine', occurrence,
    status: 'draft', createdAt: now.toISOString(), updatedAt: now.toISOString(), revision: 1,
    provenance: { source: 'import', externalReference: 'synthetic-source-1' } });
  assert.deepEqual(encounter.occurrence, occurrence);
  assert.notEqual(encounter.createdAt.slice(0, 10), occurrence.date);
  assert.equal(Occurrence.safeParse({ ...occurrence, date: '2023-02-29' }).success, false);
  assert.equal(Occurrence.safeParse({ ...occurrence, timezone: 'invalid-zone' }).success, false);
  assert.equal(Occurrence.safeParse({ precision: 'instant', at: '2026-11-11T12:00:00', timezone: 'Asia/Tashkent' }).success, false);
  assert.equal(Occurrence.safeParse({ precision: 'unknown', reason: 'Original record undated' }).success, true);
});
test('missing clinical values remain unknown and AI proposals need revisioned evidence', () => {
  const field = { key: 'examination', value: null, category: 'observed', status: 'uncertain', origin: 'ai', revision: 1,
    evidence: [{ segmentId: randomUUID(), segmentRevision: 1, startMs: 0, endMs: 500 }], editedBy: null, unresolvedConflict: null };
  assert.equal(ClinicalField.parse(field).value, null);
  assert.equal(ClinicalField.safeParse({ ...field, evidence: [] }).success, false);
  assert.equal(ClinicalField.safeParse({ ...field, status: 'corrected' }).success, false);
  assert.equal(ClinicalField.safeParse({ ...field, confidence: .99 }).success, false);
  assert.equal(ClinicalField.safeParse({ ...field, value: 'x'.repeat(16001) }).success, false);
  assert.equal(ClinicalField.safeParse({ ...field, evidence: Array(101).fill(field.evidence[0]) }).success, false);
});
test('transcript coordinates cannot reverse and amendments require provenance', () => {
  const segment = { id: randomUUID(), ...scope, encounterId: randomUUID(), captureId: randomUUID(), sequence: 0, revision: 1, startMs: 900, endMs: 100, text: 'Synthetic text', isFinal: true, capturedAt: now.toISOString() };
  assert.equal(TranscriptSegment.safeParse(segment).success, false);
  assert.equal(TranscriptSegment.safeParse({ ...segment, endMs: 950 }).success, true);
  assert.equal(DocumentVersion.safeParse({ ...version, kind: 'amendment' }).success, false);
  assert.equal(DocumentVersion.safeParse({ ...version, kind: 'amendment', amendsApprovalId: randomUUID(), amendmentReason: 'Corrected source' }).success, true);
});
test('patient account linking requires explicit proof, not a name or telephone', () => {
  const link = { id: randomUUID(), userId: ids.user, ...scope, status: 'verified', proofReference: null, verifiedBy: null, verifiedAt: null };
  assert.equal(PatientLink.safeParse(link).success, false);
  assert.equal(PatientLink.safeParse({ ...link, proofReference: 'synthetic-reviewed-proof', verifiedBy: ids.admin, verifiedAt: now.toISOString() }).success, true);
});
