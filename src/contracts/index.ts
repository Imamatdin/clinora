import { z } from 'zod';

export const Id = z.string().uuid();
export const Instant = z.string().datetime({ offset: true });
export const Revision = z.number().int().positive().safe();
export const Timezone = z.string().refine(value => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; }
  catch { return false; }
}, 'IANA timezone required');

export const Verification = z.discriminatedUnion('status', [
  z.object({ status: z.enum(['unverified', 'pending', 'rejected']) }).strict(),
  z.object({ status: z.literal('verified'), checkedBy: Id, checkedAt: Instant, evidenceReference: z.string().min(1) }).strict()
]);
export const Account = z.object({
  id: Id, emailVerified: z.boolean(), status: z.enum(['active', 'blocked']),
  professionalVerification: Verification
}).strict();
// Registration cannot supply privileges, membership, or a Telegram-based role.
export const Registration = z.object({ email: z.string().email(), displayName: z.string().trim().min(1).max(160) }).strict();
export const Principal = z.object({ userId: Id, sessionId: Id, expiresAt: Instant, accountStatus: z.enum(['active', 'blocked']) }).strict();
export const Membership = z.object({
  id: Id, userId: Id, clinicId: Id, role: z.enum(['clinician', 'administrator']),
  status: z.enum(['invited', 'active', 'revoked']), revision: Revision,
  grant: z.object({ by: Id, at: Instant }).strict().nullable(),
  patientScope: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('clinic') }).strict(),
    z.object({ kind: z.literal('assigned'), patientIds: z.array(Id).max(10000) }).strict()
  ])
}).strict().refine(m => m.status !== 'active' || m.grant !== null, 'Active membership requires a recorded grant');
export const PatientLink = z.object({
  id: Id, userId: Id, patientId: Id, clinicId: Id,
  status: z.enum(['pending', 'verified', 'revoked']),
  proofReference: z.string().min(1).nullable(), verifiedBy: Id.nullable(), verifiedAt: Instant.nullable()
}).strict().refine(l => l.status !== 'verified' || !!(l.proofReference && l.verifiedBy && l.verifiedAt), 'Verified link requires proof and verifier');
export const TelegramLink = z.object({
  userId: Id, telegramUserId: z.string().regex(/^[1-9][0-9]*$/), linkedAt: Instant,
  status: z.enum(['active', 'revoked'])
}).strict(); // Identity link only; never a Membership.

const CalendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}, 'Valid calendar date required');
export const Occurrence = z.discriminatedUnion('precision', [
  z.object({ precision: z.literal('instant'), at: Instant, timezone: Timezone }).strict(),
  z.object({ precision: z.literal('date'), date: CalendarDate, timezone: Timezone }).strict(),
  z.object({ precision: z.literal('unknown'), reason: z.string().min(1) }).strict()
]);
export const Provenance = z.object({
  source: z.enum(['manual', 'capture', 'import']), externalReference: z.string().min(1).nullable()
}).strict();
export const Patient = z.object({
  id: Id, clinicId: Id, displayName: z.string().trim().min(1).max(200),
  dateOfBirth: CalendarDate.nullable(), createdAt: Instant, updatedAt: Instant, revision: Revision,
  provenance: Provenance
}).strict(); // A chart has no required user account or global cross-clinic identity.
export const Encounter = z.object({
  id: Id, patientId: Id, clinicId: Id, clinicianId: Id,
  location: z.object({ id: Id.nullable(), label: z.string().min(1) }).strict(),
  specialty: z.string().min(1), occurrence: Occurrence,
  status: z.enum(['draft', 'in_progress', 'completed', 'cancelled']),
  createdAt: Instant, updatedAt: Instant, revision: Revision, provenance: Provenance
}).strict();
export const Diagnosis = z.object({
  id: Id, encounterId: Id, clinicId: Id, patientId: Id, clinicianId: Id,
  label: z.string().min(1), status: z.enum(['provisional', 'active', 'resolved', 'historical', 'entered_in_error']),
  occurrence: Occurrence, recordedAt: Instant, revision: Revision, provenance: Provenance
}).strict();
export const TranscriptSegment = z.object({
  id: Id, encounterId: Id, clinicId: Id, patientId: Id, captureId: Id,
  sequence: z.number().int().nonnegative(), revision: Revision,
  startMs: z.number().int().nonnegative(), endMs: z.number().int().nonnegative(),
  text: z.string().min(1).max(64000), isFinal: z.boolean(), capturedAt: Instant
}).strict().refine(s => s.endMs >= s.startMs, 'Invalid transcript range');
export const EvidenceReference = z.object({ segmentId: Id, segmentRevision: Revision, startMs: z.number().int().nonnegative(), endMs: z.number().int().nonnegative() }).strict()
  .refine(e => e.endMs >= e.startMs, 'Invalid evidence range');
export const ClinicalField = z.object({
  key: z.string().min(1).max(200), value: z.union([z.string().max(16000), z.number().finite(), z.boolean(), z.null()]),
  category: z.enum(['reported', 'observed', 'measured', 'history', 'assessment', 'clinician_instruction']),
  status: z.enum(['proposed', 'uncertain', 'corrected', 'clinician_confirmed']),
  origin: z.enum(['ai', 'clinician']), revision: Revision,
  evidence: z.array(EvidenceReference).max(100), editedBy: Id.nullable(), unresolvedConflict: z.string().max(2000).nullable()
}).strict().refine(f => f.origin !== 'ai' || f.evidence.length > 0, 'AI proposals require source evidence')
  .refine(f => !['corrected', 'clinician_confirmed'].includes(f.status) || f.editedBy !== null, 'Clinician changes require an actor');
export const DocumentVersion = z.object({
  id: Id, documentId: Id, encounterId: Id, clinicId: Id, patientId: Id,
  revision: Revision, parentVersionId: Id.nullable(),
  kind: z.enum(['ai_draft', 'clinician_edit', 'amendment']),
  fields: z.array(ClinicalField).max(512), createdBy: Id, createdAt: Instant,
  amendsApprovalId: Id.nullable(), amendmentReason: z.string().min(1).nullable()
}).strict().refine(d => d.kind !== 'amendment' || !!(d.amendsApprovalId && d.amendmentReason && d.parentVersionId), 'Amendment requires approved predecessor and reason')
  .refine(d => d.kind === 'amendment' || (d.amendsApprovalId === null && d.amendmentReason === null), 'Only amendments reference previous approvals');
export const Approval = z.object({
  id: Id, documentId: Id, versionId: Id, revision: Revision,
  clinicId: Id, patientId: Id, approvedBy: Id, approvedAt: Instant
}).strict();
export const IntegrationStatus = z.enum(['unavailable', 'pending', 'sending', 'succeeded', 'failed', 'uncertain']);
export const IntegrationJob = z.object({
  id: Id, clinicId: Id, patientId: Id, documentId: Id, versionId: Id, approvalId: Id,
  idempotencyKey: z.string().min(16).max(200), destination: z.string().min(1),
  status: IntegrationStatus, externalId: z.string().nullable(),
  attempts: z.number().int().nonnegative(), lastErrorCode: z.string().nullable(), updatedAt: Instant
}).strict().refine(j => j.status !== 'succeeded' || !!j.externalId, 'Success requires external acknowledgement');
export const ERROR_STATUS = {
  UNAUTHENTICATED: 401, FORBIDDEN: 403, NOT_FOUND: 404, STALE_VERSION: 409,
  IDEMPOTENCY_CONFLICT: 409, INVALID_TRANSITION: 409, INVALID_INPUT: 422,
  INTEGRATION_UNAVAILABLE: 503, NOT_IMPLEMENTED: 501
} as const;
export type ErrorCode = keyof typeof ERROR_STATUS;
export const ApiError = z.object({ error: z.object({ code: z.enum(Object.keys(ERROR_STATUS) as [ErrorCode, ...ErrorCode[]]), message: z.string(), requestId: Id }).strict() }).strict();
export type Principal = z.infer<typeof Principal>;
export type Membership = z.infer<typeof Membership>;
export type Patient = z.infer<typeof Patient>;
export type Encounter = z.infer<typeof Encounter>;
export type DocumentVersion = z.infer<typeof DocumentVersion>;
export type Approval = z.infer<typeof Approval>;
export type IntegrationJob = z.infer<typeof IntegrationJob>;
export type ResourceScope = { clinicId: string; patientId: string };
