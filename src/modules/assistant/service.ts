import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { DocumentVersion, type Membership, type Principal } from '../../contracts/index.js';
import { requireApprovableVersion } from '../documents/policy.js';
import { latestApproval } from '../documents/approvals.js';
import { DomainError } from '../identity/access.js';
import { transaction, type Tx } from '../../server/database.js';
import { recordAudit, requireRole } from '../../server/roles.js';
import { CATEGORIES, FIELD_KEYS, FieldKeySchema, FORM_ID, displayValue, parseValue, validateProposals, type Category, type FieldKey, type FieldValue, type SegmentRef } from './form.js';
import { ProviderError, type AssistantProviders } from './providers.js';
import type { VoiceMessage, VoiceOutcome } from '../telegram/webhook.js';

/*
 * Doctor assistant server actions (slice A1). Every action re-reads the actor's membership, doctor role
 * and patient scope from the database. Provider calls happen outside database transactions; results are
 * published only if the job still holds its lease and the doctor still has access.
 */
const fail = (code: ConstructorParameters<typeof DomainError>[0]): never => { throw new DomainError(code); };
/** The verified caller. Session fields are present when the route needs a policy Principal (approval). */
export type Actor = { userId: string; sessionId?: string; expiresAt?: string };
export type Deps = { pool: pg.Pool; providers: AssistantProviders; origin: string };

export const LIMITS = { chunkBytes: 2 * 1024 * 1024, captureBytes: 40 * 1024 * 1024, chunks: 240, voiceSeconds: 15 * 60, capturesPerHour: 60, attempts: 5, leaseSeconds: 180 };

// ---------- Access ----------

type DoctorAccess = { principal: Principal; membership: Membership };
/** Doctor role, clinical access and (when given) the patient in scope. Missing or out of scope reads as NOT_FOUND. */
export async function doctorAccess(tx: Tx, actor: Actor, clinicId: string, patientId: string | null): Promise<DoctorAccess> {
  await requireRole(tx, actor.userId, clinicId, ['doctor']);
  const m = (await tx.query("SELECT * FROM memberships WHERE clinic_id=$1 AND user_id=$2 AND status='active' AND clinical_access FOR SHARE", [clinicId, actor.userId])).rows[0];
  if (!m) return fail('FORBIDDEN');
  if (patientId) {
    const inScope = m.patient_scope === 'clinic'
      ? (await tx.query('SELECT 1 FROM patients WHERE clinic_id=$1 AND id=$2', [clinicId, patientId])).rowCount
      : (await tx.query('SELECT 1 FROM patient_assignments WHERE clinic_id=$1 AND patient_id=$2 AND user_id=$3 FOR SHARE', [clinicId, patientId, actor.userId])).rowCount;
    if (!inScope) return fail('NOT_FOUND');
  }
  return {
    principal: { userId: actor.userId, sessionId: actor.sessionId ?? '', expiresAt: actor.expiresAt ?? '', accountStatus: 'active' },
    membership: { id: m.id, userId: actor.userId, clinicId, role: 'clinician', status: 'active', revision: m.revision,
      grant: { by: m.granted_by, at: new Date(m.granted_at).toISOString() },
      patientScope: m.patient_scope === 'clinic' ? { kind: 'clinic' } : { kind: 'assigned', patientIds: patientId ? [patientId] : [] } }
  };
}
/** Background jobs act as the capture's doctor and recheck the same rules (account, membership, role, scope). */
async function jobStillAuthorized(tx: Tx, clinicId: string, doctorId: string, patientId: string): Promise<boolean> {
  const row = (await tx.query(`SELECT 1 FROM memberships m JOIN accounts a ON a.id=m.user_id
    WHERE m.clinic_id=$1 AND m.user_id=$2 AND m.status='active' AND m.clinical_access AND a.status='active'
      AND EXISTS(SELECT 1 FROM membership_roles r WHERE r.clinic_id=m.clinic_id AND r.user_id=m.user_id AND r.role='doctor')
      AND (m.patient_scope='clinic' OR EXISTS(SELECT 1 FROM patient_assignments p WHERE p.clinic_id=m.clinic_id AND p.user_id=m.user_id AND p.patient_id=$3))
    FOR SHARE OF m`, [clinicId, doctorId, patientId])).rows[0];
  return !!row;
}
async function requireEncounter(tx: Tx, clinicId: string, patientId: string, encounterId: string) {
  const row = (await tx.query('SELECT id FROM encounters WHERE clinic_id=$1 AND patient_id=$2 AND id=$3 FOR KEY SHARE', [clinicId, patientId, encounterId])).rows[0];
  if (!row) fail('NOT_FOUND');
}

// ---------- Drafts and views ----------

async function lockDraft(tx: Tx, clinicId: string, patientId: string, encounterId: string) {
  await tx.query('INSERT INTO assistant_drafts(id,clinic_id,patient_id,encounter_id,form_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT (encounter_id) DO NOTHING',
    [randomUUID(), clinicId, patientId, encounterId, FORM_ID]);
  const d = (await tx.query('SELECT * FROM assistant_drafts WHERE encounter_id=$1 AND clinic_id=$2 AND patient_id=$3 FOR UPDATE', [encounterId, clinicId, patientId])).rows[0];
  return d ?? fail('NOT_FOUND');
}
type FieldRow = { id: string; field_key: FieldKey; field_revision: number; value: FieldValue; category: Category; status: string; origin: string; evidence: string[]; proposal_id: string | null; created_at: Date };
async function currentFields(tx: Tx, draftId: string): Promise<Map<FieldKey, FieldRow>> {
  const rows = (await tx.query('SELECT DISTINCT ON (field_key) * FROM assistant_field_versions WHERE draft_id=$1 ORDER BY field_key, field_revision DESC', [draftId])).rows as FieldRow[];
  return new Map(rows.map(r => [r.field_key, r]));
}
async function insertField(tx: Tx, draft: { id: string; clinic_id: string }, key: FieldKey, revision: number, v: { value: FieldValue; category: Category; status: string; origin: string; evidence: string[]; proposalId: string | null; actor: string | null }) {
  const id = randomUUID();
  await tx.query(`INSERT INTO assistant_field_versions(id,clinic_id,draft_id,field_key,field_revision,value,category,status,origin,evidence,proposal_id,actor_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [id, draft.clinic_id, draft.id, key, revision, JSON.stringify(v.value), v.category, v.status, v.origin, v.evidence, v.proposalId, v.actor]);
  return id;
}
const bumpDraft = (tx: Tx, draftId: string) => tx.query('UPDATE assistant_drafts SET revision=revision+1, updated_at=now() WHERE id=$1 RETURNING revision', [draftId]);

export async function draftView(tx: Tx, actor: Actor, clinicId: string, patientId: string, encounterId: string, providers: AssistantProviders) {
  await doctorAccess(tx, actor, clinicId, patientId);
  await requireEncounter(tx, clinicId, patientId, encounterId);
  const draft = await lockDraft(tx, clinicId, patientId, encounterId);
  const fields = await currentFields(tx, draft.id);
  const held = (await tx.query(`SELECT DISTINCT ON (field_key) id,field_key,value,category,evidence,created_at FROM assistant_proposals
    WHERE draft_id=$1 AND disposition='held' ORDER BY field_key, created_at DESC`, [draft.id])).rows;
  const segments = (await tx.query(`SELECT s.id,s.transcript_id "transcriptId",s.seq,s.speaker,s.text,s.start_ms "startMs",s.end_ms "endMs"
    FROM assistant_segments s JOIN assistant_transcripts t ON t.id=s.transcript_id
    WHERE s.clinic_id=$1 AND s.patient_id=$2 AND s.encounter_id=$3 ORDER BY t.created_at, s.seq`, [clinicId, patientId, encounterId])).rows;
  const transcripts = (await tx.query(`SELECT id,provider,simulated,created_at "createdAt" FROM assistant_transcripts WHERE clinic_id=$1 AND encounter_id=$2 AND patient_id=$3 ORDER BY created_at`, [clinicId, encounterId, patientId])).rows;
  const captures = (await tx.query(`SELECT id,source,status,stage,error_code "errorCode",created_at "createdAt" FROM assistant_captures
    WHERE clinic_id=$1 AND encounter_id=$2 AND patient_id=$3 ORDER BY created_at DESC LIMIT 20`, [clinicId, encounterId, patientId])).rows;
  const lastRun = (await tx.query(`SELECT provider,model,simulated,status,error_code "errorCode",accepted_count "acceptedCount",rejected_count "rejectedCount",latency_ms "latencyMs",created_at "createdAt"
    FROM assistant_extraction_runs WHERE draft_id=$1 ORDER BY created_at DESC LIMIT 1`, [draft.id])).rows[0] ?? null;
  const approval = (await tx.query(`SELECT p.id,p.version_id "versionId",p.revision,p.approved_at "approvedAt",a.display_name "approvedBy"
    FROM assistant_approvals p JOIN accounts a ON a.id=p.approved_by WHERE p.draft_id=$1`, [draft.id])).rows[0] ?? null;
  return {
    formId: draft.form_id, draft: { id: draft.id, revision: draft.revision, status: draft.status }, approval,
    fields: FIELD_KEYS.map(key => {
      const f = fields.get(key), h = held.find(x => x.field_key === key && (!f || x.created_at > f.created_at));
      return { key, fieldRevision: f?.field_revision ?? 0, value: f?.value ?? null, category: f?.category ?? null, status: f?.status ?? 'empty',
        origin: f?.origin ?? null, evidence: f?.evidence ?? [], held: h ? { proposalId: h.id, value: h.value, category: h.category, evidence: h.evidence } : null };
    }),
    segments, transcripts, captures, lastRun,
    providers: { stt: { name: providers.stt.name, simulated: providers.stt.simulated }, extractor: { name: providers.extractor.name, simulated: providers.extractor.simulated } }
  };
}

// ---------- Field review ----------

export const FieldActionInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('accept'), expectedFieldRevision: z.number().int().min(0), proposalId: z.string().uuid().nullable().default(null) }).strict(),
  z.object({ action: z.literal('edit'), expectedFieldRevision: z.number().int().min(0), value: z.unknown(), category: z.enum(CATEGORIES) }).strict(),
  z.object({ action: z.literal('clear'), expectedFieldRevision: z.number().int().min(0) }).strict()
]);
export async function fieldAction(tx: Tx, actor: Actor, clinicId: string, patientId: string, encounterId: string, keyRaw: string, input: z.infer<typeof FieldActionInput>) {
  await doctorAccess(tx, actor, clinicId, patientId);
  const key = FieldKeySchema.safeParse(keyRaw); if (!key.success) return fail('NOT_FOUND');
  await requireEncounter(tx, clinicId, patientId, encounterId);
  const draft = await lockDraft(tx, clinicId, patientId, encounterId);
  if (draft.status !== 'open') return fail('INVALID_TRANSITION');
  const current = (await currentFields(tx, draft.id)).get(key.data);
  if ((current?.field_revision ?? 0) !== input.expectedFieldRevision) return fail('STALE_VERSION');
  const next = input.expectedFieldRevision + 1;
  if (input.action === 'accept') {
    if (input.proposalId) {
      const p = (await tx.query("SELECT * FROM assistant_proposals WHERE id=$1 AND draft_id=$2 AND field_key=$3 AND disposition='held'", [input.proposalId, draft.id, key.data])).rows[0];
      if (!p) return fail('NOT_FOUND');
      await insertField(tx, draft, key.data, next, { value: p.value, category: p.category, status: 'accepted', origin: 'ai', evidence: p.evidence, proposalId: p.id, actor: actor.userId });
    } else {
      if (!current || current.status !== 'proposed') return fail('INVALID_TRANSITION');
      await insertField(tx, draft, key.data, next, { value: current.value, category: current.category, status: 'accepted', origin: 'ai', evidence: current.evidence, proposalId: current.proposal_id, actor: actor.userId });
    }
  } else if (input.action === 'edit') {
    const typed = parseValue(key.data, input.value === '' ? null : input.value, input.category);
    if (!typed.ok) return fail('INVALID_INPUT');
    await insertField(tx, draft, key.data, next, { value: typed.value, category: input.category, status: typed.value === null && input.category !== 'not_examined' ? 'cleared' : 'edited',
      origin: 'clinician', evidence: current?.evidence ?? [], proposalId: null, actor: actor.userId });
  } else {
    await insertField(tx, draft, key.data, next, { value: null, category: current?.category ?? 'reported', status: 'cleared', origin: 'clinician', evidence: [], proposalId: null, actor: actor.userId });
  }
  const revision = (await bumpDraft(tx, draft.id)).rows[0].revision;
  await recordAudit(tx, actor.userId, clinicId, 'assistant.field_' + input.action, draft.id, { field: key.data, fieldRevision: next });
  return { draftRevision: revision, fieldRevision: next };
}

// ---------- Approval ----------

export const ApproveInput = z.object({ expectedDraftRevision: z.number().int().min(0), fieldRevisions: z.record(z.string(), z.number().int().min(0)) }).strict();
export async function approve(tx: Tx, actor: Actor, clinicId: string, patientId: string, encounterId: string, input: z.infer<typeof ApproveInput>) {
  if (!actor.sessionId || !actor.expiresAt) return fail('UNAUTHENTICATED'); // Approval needs the verified session as its Principal.
  const access = await doctorAccess(tx, actor, clinicId, patientId);
  await requireEncounter(tx, clinicId, patientId, encounterId);
  const draft = await lockDraft(tx, clinicId, patientId, encounterId);
  if (draft.status === 'approved') {
    // A retried approval of the same draft revision returns the original result; anything else is stale.
    const prior = (await tx.query('SELECT id,version_id,revision,draft_revision,approved_by FROM assistant_approvals WHERE draft_id=$1', [draft.id])).rows[0];
    if (prior && prior.draft_revision === input.expectedDraftRevision && prior.approved_by === actor.userId) return { approvalId: prior.id, versionId: prior.version_id, revision: prior.revision };
    return fail('INVALID_TRANSITION');
  }
  if (draft.revision !== input.expectedDraftRevision) return fail('STALE_VERSION');
  const fields = await currentFields(tx, draft.id);
  for (const key of FIELD_KEYS) if ((fields.get(key)?.field_revision ?? 0) !== (input.fieldRevisions[key] ?? 0)) return fail('STALE_VERSION');
  // Field by field: every proposal must have been accepted, edited or cleared by the doctor.
  if ([...fields.values()].some(f => f.status === 'proposed')) return fail('INVALID_TRANSITION');
  const doc = (await tx.query('SELECT * FROM documents WHERE clinic_id=$1 AND patient_id=$2 AND encounter_id=$3 FOR UPDATE', [clinicId, patientId, encounterId])).rows[0];
  if (!doc) return fail('NOT_FOUND');
  // Task 010: once the note is approved (e.g. in the doctor workspace) it changes only through an explicit amendment.
  if (await latestApproval(tx, doc.id)) return fail('INVALID_TRANSITION');
  const evidenceIds = [...new Set([...fields.values()].flatMap(f => f.evidence))];
  const seg = new Map((await tx.query('SELECT id,start_ms,end_ms FROM assistant_segments WHERE id = ANY($1) AND clinic_id=$2 AND patient_id=$3 AND encounter_id=$4', [evidenceIds, clinicId, patientId, encounterId])).rows.map(r => [r.id, r]));
  const now = new Date().toISOString(), revision = doc.current_revision + 1;
  const docCategory = (c: Category) => c === 'not_examined' ? 'observed' : c;
  const clinicalFields = [] as unknown[];
  for (const key of FIELD_KEYS) {
    const f = fields.get(key);
    if (!f || f.status === 'cleared' || (f.value === null && f.category !== 'not_examined')) continue;
    const evidence = f.evidence.filter(id => seg.has(id)).map(id => ({ segmentId: id, segmentRevision: 1, startMs: seg.get(id)!.start_ms, endMs: seg.get(id)!.end_ms }));
    const origin = f.origin === 'ai' && evidence.length ? 'ai' : 'clinician';
    const base = { category: docCategory(f.category), status: 'clinician_confirmed', origin, revision, evidence, editedBy: actor.userId, unresolvedConflict: null };
    clinicalFields.push({ key: `gp.${key}`, value: f.value === null ? null : displayValue(key, f.value), ...base });
    if (f.category === 'not_examined') clinicalFields.push({ key: 'gp.examination.notExamined', value: true, ...base });
    if (key === 'diagnosis' && f.value && typeof f.value === 'object' && !Array.isArray(f.value)) clinicalFields.push({ key: 'gp.diagnosis.icd10', value: f.value.icd10, ...base });
    if (key === 'labOrders' && Array.isArray(f.value)) clinicalFields.push({ key: 'gp.labOrders.codes', value: f.value.join(','), ...base });
  }
  const version = DocumentVersion.parse({ id: randomUUID(), documentId: doc.id, encounterId, clinicId, patientId, revision, parentVersionId: doc.current_version_id,
    kind: 'clinician_edit', templateId: FORM_ID, fields: clinicalFields, createdBy: actor.userId, createdAt: now, amendsApprovalId: null, amendmentReason: null });
  requireApprovableVersion({ principal: access.principal, membership: access.membership, scope: { clinicId, patientId }, version, currentVersionId: version.id, expectedRevision: revision, existingApproval: null, now: new Date() });
  await tx.query('INSERT INTO document_versions(id,document_id,clinic_id,patient_id,revision,created_by,data) VALUES($1,$2,$3,$4,$5,$6,$7)', [version.id, doc.id, clinicId, patientId, revision, actor.userId, version]);
  await tx.query('UPDATE documents SET current_revision=$1,current_version_id=$2 WHERE id=$3', [revision, version.id, doc.id]);
  const approvalId = randomUUID();
  const fieldVersions = Object.fromEntries([...fields.entries()].map(([k, f]) => [k, { id: f.id, revision: f.field_revision }]));
  await tx.query(`INSERT INTO assistant_approvals(id,clinic_id,patient_id,draft_id,document_id,version_id,revision,draft_revision,field_versions,approved_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [approvalId, clinicId, patientId, draft.id, doc.id, version.id, revision, draft.revision, JSON.stringify(fieldVersions), actor.userId]);
  await tx.query("UPDATE assistant_drafts SET status='approved', updated_at=now() WHERE id=$1", [draft.id]);
  await recordAudit(tx, actor.userId, clinicId, 'assistant.approved', version.id, { revision, draftRevision: draft.revision });
  return { approvalId, versionId: version.id, revision };
}

/** Loads the approved snapshot for the PDF. Always the stored approved version, never a draft. */
export async function approvedDocument(tx: Tx, actor: Actor, clinicId: string, patientId: string, encounterId: string) {
  await doctorAccess(tx, actor, clinicId, patientId);
  const row = (await tx.query(`SELECT p.id approval_id,p.approved_at,a.display_name approver,v.data version,pt.display_name patient,pt.mrn,pt.date_of_birth,e.data encounter,c.name clinic
    FROM assistant_approvals p JOIN assistant_drafts d ON d.id=p.draft_id JOIN document_versions v ON v.id=p.version_id AND v.document_id=p.document_id
    JOIN accounts a ON a.id=p.approved_by JOIN patients pt ON pt.id=d.patient_id AND pt.clinic_id=d.clinic_id
    JOIN encounters e ON e.id=d.encounter_id AND e.clinic_id=d.clinic_id JOIN clinics c ON c.id=d.clinic_id
    WHERE d.clinic_id=$1 AND d.patient_id=$2 AND d.encounter_id=$3`, [clinicId, patientId, encounterId])).rows[0];
  return row ?? fail('NOT_FOUND');
}

// ---------- Captures ----------

export const CaptureInput = z.object({ clientKey: z.string().regex(/^[A-Za-z0-9_-]{16,100}$/), mimeType: z.string().regex(/^audio\/(webm|ogg|mp4|wav|mpeg)(;\s?codecs=[a-z0-9.,]+)?$/).max(60) }).strict();
const captureView = (c: pg.QueryResultRow) => ({ id: c.id, source: c.source, status: c.status, stage: c.stage, errorCode: c.error_code, chunkCount: c.chunk_count,
  patientId: c.patient_id, encounterId: c.encounter_id, durationS: c.duration_s, createdAt: c.created_at });

async function rateLimit(tx: Tx, clinicId: string, doctorId: string) {
  const n = Number((await tx.query("SELECT count(*) n FROM assistant_captures WHERE clinic_id=$1 AND doctor_id=$2 AND created_at > now() - interval '1 hour'", [clinicId, doctorId])).rows[0].n);
  if (n >= LIMITS.capturesPerHour) fail('RATE_LIMITED');
}
export async function createCapture(tx: Tx, actor: Actor, clinicId: string, patientId: string, encounterId: string, input: z.infer<typeof CaptureInput>, source: 'browser' | 'simulated') {
  await doctorAccess(tx, actor, clinicId, patientId);
  await requireEncounter(tx, clinicId, patientId, encounterId);
  const existing = (await tx.query('SELECT * FROM assistant_captures WHERE clinic_id=$1 AND doctor_id=$2 AND client_key=$3', [clinicId, actor.userId, input.clientKey])).rows[0];
  if (existing) {
    if (existing.encounter_id !== encounterId || existing.source !== source) return fail('IDEMPOTENCY_CONFLICT');
    return captureView(existing);
  }
  await rateLimit(tx, clinicId, actor.userId);
  const row = (await tx.query(`INSERT INTO assistant_captures(id,clinic_id,doctor_id,source,client_key,mime_type,patient_id,encounter_id,status,attached_at,attached_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),$3) RETURNING *`, [randomUUID(), clinicId, actor.userId, source, input.clientKey, input.mimeType.split(';')[0], patientId, encounterId, source === 'simulated' ? 'queued' : 'receiving'])).rows[0];
  await recordAudit(tx, actor.userId, clinicId, 'assistant.capture_created', row.id, { source });
  return captureView(row);
}
async function ownCapture(tx: Tx, actor: Actor, clinicId: string, captureId: string) {
  const c = (await tx.query('SELECT * FROM assistant_captures WHERE id=$1 AND clinic_id=$2 AND doctor_id=$3 FOR UPDATE', [captureId, clinicId, actor.userId])).rows[0];
  if (!c) return fail('NOT_FOUND');
  // Recheck current access to the capture's patient on every touch.
  await doctorAccess(tx, actor, clinicId, c.patient_id);
  return c;
}
/** Chunk upload: a retried chunk with the same checksum is a no-op; a different body for the same number conflicts. */
export async function putChunk(tx: Tx, actor: Actor, clinicId: string, captureId: string, seq: number, checksum: string, data: Buffer) {
  const c = await ownCapture(tx, actor, clinicId, captureId);
  if (createHash('sha256').update(data).digest('hex') !== checksum) return fail('INVALID_INPUT');
  const old = (await tx.query('SELECT checksum FROM assistant_audio_chunks WHERE capture_id=$1 AND seq=$2', [captureId, seq])).rows[0];
  if (old) return old.checksum === checksum ? { seq, accepted: true, duplicate: true } : fail('IDEMPOTENCY_CONFLICT');
  if (c.status !== 'receiving') return fail('INVALID_TRANSITION');
  if (seq >= LIMITS.chunks || c.chunk_count >= LIMITS.chunks || Number(c.byte_count) + data.length > LIMITS.captureBytes) return fail('INVALID_INPUT');
  await tx.query('INSERT INTO assistant_audio_chunks(capture_id,seq,checksum,size,data) VALUES($1,$2,$3,$4,$5)', [captureId, seq, checksum, data.length, data]);
  await tx.query('UPDATE assistant_captures SET chunk_count=chunk_count+1, byte_count=byte_count+$2 WHERE id=$1', [captureId, data.length]);
  return { seq, accepted: true, duplicate: false };
}
export async function finishCapture(tx: Tx, actor: Actor, clinicId: string, captureId: string, chunkCount: number) {
  const c = await ownCapture(tx, actor, clinicId, captureId);
  if (c.status !== 'receiving') return captureView(c); // Retried finish: same capture, no second job.
  const seqs = (await tx.query('SELECT seq FROM assistant_audio_chunks WHERE capture_id=$1 ORDER BY seq', [captureId])).rows.map(r => r.seq as number);
  // Gaps and missing tail chunks are reported, never silently transcribed as complete.
  if (chunkCount < 1 || seqs.length !== chunkCount || seqs.some((s, i) => s !== i)) return fail('INVALID_TRANSITION');
  const row = (await tx.query("UPDATE assistant_captures SET status='queued' WHERE id=$1 RETURNING *", [captureId])).rows[0];
  await recordAudit(tx, actor.userId, clinicId, 'assistant.capture_finished', captureId, { chunks: chunkCount });
  return captureView(row);
}
export async function captureStatus(tx: Tx, actor: Actor, clinicId: string, captureId: string) { return captureView(await ownCapture(tx, actor, clinicId, captureId)); }
export async function retryCapture(tx: Tx, actor: Actor, clinicId: string, captureId: string) {
  const c = await ownCapture(tx, actor, clinicId, captureId);
  if (c.status !== 'failed') return fail('INVALID_TRANSITION');
  if (c.audio_purged_at) return fail('INVALID_TRANSITION');
  const row = (await tx.query("UPDATE assistant_captures SET status='queued', stage=NULL, error_code=NULL, attempts=0 WHERE id=$1 RETURNING *", [captureId])).rows[0];
  return captureView(row);
}
export async function discardCapture(tx: Tx, actor: Actor, clinicId: string, captureId: string) {
  const c = await ownCapture(tx, actor, clinicId, captureId);
  if (c.status === 'done') return fail('INVALID_TRANSITION');
  await tx.query('DELETE FROM assistant_audio_chunks WHERE capture_id=$1', [captureId]);
  const row = (await tx.query("UPDATE assistant_captures SET status='discarded', lease_token=NULL, audio_purged_at=now() WHERE id=$1 RETURNING *", [captureId])).rows[0];
  await recordAudit(tx, actor.userId, clinicId, 'assistant.capture_discarded', captureId);
  return captureView(row);
}
export async function pendingTelegram(tx: Tx, actor: Actor, clinicId: string) {
  await doctorAccess(tx, actor, clinicId, null);
  return (await tx.query(`SELECT * FROM assistant_captures WHERE clinic_id=$1 AND doctor_id=$2 AND source='telegram' AND status='pending_attach'
    AND created_at > now() - interval '24 hours' ORDER BY created_at DESC LIMIT 20`, [clinicId, actor.userId])).rows.map(captureView);
}
export const AttachInput = z.object({ patientId: z.string().uuid(), encounterId: z.string().uuid() }).strict();
/** Attach a Telegram voice message to the encounter the doctor has open and confirmed. */
export async function attachCapture(tx: Tx, actor: Actor, clinicId: string, captureId: string, input: z.infer<typeof AttachInput>) {
  const c = (await tx.query("SELECT * FROM assistant_captures WHERE id=$1 AND clinic_id=$2 AND doctor_id=$3 AND source='telegram' FOR UPDATE", [captureId, clinicId, actor.userId])).rows[0];
  if (!c) return fail('NOT_FOUND');
  await doctorAccess(tx, actor, clinicId, input.patientId);
  await requireEncounter(tx, clinicId, input.patientId, input.encounterId);
  if (c.encounter_id) return c.encounter_id === input.encounterId && c.patient_id === input.patientId ? captureView(c) : fail('INVALID_TRANSITION');
  if (c.status !== 'pending_attach') return fail('INVALID_TRANSITION');
  const row = (await tx.query("UPDATE assistant_captures SET patient_id=$2, encounter_id=$3, status='queued', attached_at=now(), attached_by=$4 WHERE id=$1 RETURNING *",
    [captureId, input.patientId, input.encounterId, actor.userId])).rows[0];
  await recordAudit(tx, actor.userId, clinicId, 'assistant.capture_attached', captureId);
  return captureView(row);
}

// ---------- Background processing ----------

const inflight = new Set<Promise<void>>();
/** Start processing without blocking the request. State is durable; a restart resumes through lease expiry. */
export function kick(deps: Deps, captureId: string) {
  const job = processCapture(deps, captureId).catch(() => { /* Failure state is recorded in the database; never log clinical data. */ });
  inflight.add(job); void job.finally(() => inflight.delete(job));
}
/** Test and shutdown helper: wait for running jobs. */
export async function drainJobs() { while (inflight.size) await Promise.all([...inflight]); }
export const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date());

async function holdsLease(tx: Tx, captureId: string, lease: string) {
  return (await tx.query("SELECT * FROM assistant_captures WHERE id=$1 AND lease_token=$2 AND status='processing' FOR UPDATE", [captureId, lease])).rows[0] ?? null;
}
async function failJob(pool: pg.Pool, captureId: string, lease: string, code: string) {
  await pool.query("UPDATE assistant_captures SET status='failed', error_code=$3, lease_token=NULL, lease_until=NULL, finished_at=now() WHERE id=$1 AND lease_token=$2", [captureId, lease, code]);
}

export async function processCapture(deps: Deps, captureId: string): Promise<void> {
  const { pool, providers } = deps, lease = randomUUID();
  const claimed = (await pool.query(`UPDATE assistant_captures SET status='processing', stage=COALESCE(stage,'transcribing'), lease_token=$2,
      lease_until=now() + make_interval(secs => $3), attempts=attempts+1
    WHERE id=$1 AND encounter_id IS NOT NULL AND attempts < $4 AND (status='queued' OR (status='processing' AND lease_until < now())) RETURNING *`,
    [captureId, lease, LIMITS.leaseSeconds, LIMITS.attempts])).rows[0];
  if (!claimed) return;
  const { clinic_id: clinicId, patient_id: patientId, encounter_id: encounterId, doctor_id: doctorId } = claimed;
  try {
    let transcript = (await pool.query('SELECT id FROM assistant_transcripts WHERE capture_id=$1', [captureId])).rows[0];
    if (!transcript) {
      let audio = Buffer.alloc(0), mimeType = claimed.mime_type as string;
      if (claimed.source === 'telegram' && claimed.chunk_count === 0) {
        if (!providers.telegram) return failJob(pool, captureId, lease, 'PROVIDER_UNAVAILABLE');
        const voice = await providers.telegram.downloadVoice(claimed.telegram_file_id);
        await pool.query(`WITH c AS (INSERT INTO assistant_audio_chunks(capture_id,seq,checksum,size,data) VALUES($1,0,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING size)
          UPDATE assistant_captures SET chunk_count=1, byte_count=(SELECT size FROM c) WHERE id=$1 AND EXISTS(SELECT 1 FROM c)`,
          [captureId, createHash('sha256').update(voice.data).digest('hex'), voice.data.length, voice.data]);
        mimeType = voice.mimeType;
      }
      if (claimed.source !== 'simulated') {
        const chunks = (await pool.query('SELECT data FROM assistant_audio_chunks WHERE capture_id=$1 ORDER BY seq', [captureId])).rows;
        if (!chunks.length) return failJob(pool, captureId, lease, 'AUDIO_MISSING');
        audio = Buffer.concat(chunks.map(r => r.data as Buffer));
      } else if (!providers.stt.simulated) return failJob(pool, captureId, lease, 'PROVIDER_UNAVAILABLE');
      const started = Date.now();
      const result = await providers.stt.transcribe({ audio, mimeType });
      const segments = result.segments.filter(s => s.text.trim()).slice(0, 2000);
      if (!segments.length) return failJob(pool, captureId, lease, 'SILENCE');
      transcript = await transaction(pool, async tx => {
        if (!await holdsLease(tx, captureId, lease)) return null; // Discarded or taken over: publish nothing.
        if (!await jobStillAuthorized(tx, clinicId, doctorId, patientId)) { await tx.query("UPDATE assistant_captures SET status='failed', error_code='FORBIDDEN', lease_token=NULL WHERE id=$1", [captureId]); return null; }
        const id = randomUUID();
        const inserted = (await tx.query(`INSERT INTO assistant_transcripts(id,clinic_id,patient_id,encounter_id,capture_id,provider,simulated,language,latency_ms)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (capture_id) DO NOTHING RETURNING id`,
          [id, clinicId, patientId, encounterId, captureId, providers.stt.name, providers.stt.simulated, result.language, Date.now() - started])).rows[0];
        if (inserted) for (const [i, s] of segments.entries())
          await tx.query('INSERT INTO assistant_segments(id,clinic_id,patient_id,encounter_id,transcript_id,seq,start_ms,end_ms,speaker,text) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
            [randomUUID(), clinicId, patientId, encounterId, id, i, s.startMs, Math.max(s.startMs, s.endMs), s.speaker, s.text.slice(0, 8000)]);
        await tx.query("UPDATE assistant_captures SET stage='drafting', lease_until=now() + make_interval(secs => $2) WHERE id=$1", [captureId, LIMITS.leaseSeconds]);
        return inserted ?? (await tx.query('SELECT id FROM assistant_transcripts WHERE capture_id=$1', [captureId])).rows[0];
      });
      if (!transcript) return;
    }
    await extractInto(deps, captureId, lease, { clinicId, patientId, encounterId, doctorId });
  } catch (e) {
    await failJob(pool, captureId, lease, e instanceof ProviderError ? e.code : 'PROCESSING_FAILED');
  }
}

async function extractInto(deps: Deps, captureId: string, lease: string, s: { clinicId: string; patientId: string; encounterId: string; doctorId: string }) {
  const { pool, providers } = deps;
  // All transcripts of this encounter, so a second recording adds to the first.
  const segments = (await pool.query('SELECT id,text,speaker FROM assistant_segments WHERE clinic_id=$1 AND patient_id=$2 AND encounter_id=$3 ORDER BY transcript_id, seq',
    [s.clinicId, s.patientId, s.encounterId])).rows as SegmentRef[];
  const started = Date.now();
  let raw: unknown, error: string | null = null;
  try { raw = await providers.extractor.extract({ segments, today: today() }); }
  catch (e) { error = e instanceof ProviderError ? e.code : 'EXTRACTION_FAILED'; }
  await transaction(pool, async tx => {
    if (!await holdsLease(tx, captureId, lease)) return;
    const finish = (code: string | null) => tx.query("UPDATE assistant_captures SET status='done', stage=NULL, error_code=$2, lease_token=NULL, lease_until=NULL, finished_at=now() WHERE id=$1", [captureId, code]);
    if (!await jobStillAuthorized(tx, s.clinicId, s.doctorId, s.patientId)) { await tx.query("UPDATE assistant_captures SET status='failed', error_code='FORBIDDEN', lease_token=NULL WHERE id=$1", [captureId]); return; }
    const draft = await lockDraft(tx, s.clinicId, s.patientId, s.encounterId);
    const runId = randomUUID();
    const run = (status: string, code: string | null, acceptedCount = 0, rejectedCount = 0) => tx.query(`INSERT INTO assistant_extraction_runs(id,clinic_id,draft_id,capture_id,provider,model,simulated,status,error_code,latency_ms,accepted_count,rejected_count)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [runId, s.clinicId, draft.id, captureId, providers.extractor.name, providers.extractor.model, providers.extractor.simulated, status, code, Date.now() - started, acceptedCount, rejectedCount]);
    // Late results never change an approved note.
    if (draft.status !== 'open') { await run('failed', 'DRAFT_APPROVED'); await finish('DRAFT_APPROVED'); return; }
    if (error) { await run('failed', error); await finish('EXTRACTION_FAILED'); return; }
    const map = new Map(segments.map(x => [x.id, x]));
    const result = validateProposals(raw, map);
    if (result.malformed) { await run('failed', 'MALFORMED_OUTPUT'); await finish('EXTRACTION_FAILED'); return; }
    await run('done', null, result.accepted.length, result.rejected.length);
    for (const r of result.rejected)
      await tx.query("INSERT INTO assistant_proposals(id,clinic_id,run_id,draft_id,field_key,value,category,evidence,disposition,reject_reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'rejected',$9)",
        [randomUUID(), s.clinicId, runId, draft.id, r.field.slice(0, 50), JSON.stringify(r.value ?? null).length < 8000 ? JSON.stringify(r.value ?? null) : 'null',
          typeof r.category === 'string' ? r.category.slice(0, 40) : null, r.evidence.filter(id => /^[0-9a-f-]{36}$/i.test(id)), r.reason]);
    const fields = await currentFields(tx, draft.id);
    let changed = false;
    for (const p of result.accepted) {
      const current = fields.get(p.field);
      // Doctor-touched fields (accepted, edited, cleared) are kept; the new proposal is held for review.
      const doctorTouched = current && current.status !== 'proposed';
      const same = current && JSON.stringify(current.value) === JSON.stringify(p.value) && current.category === p.category && current.evidence.join() === p.evidence.join();
      const proposalId = randomUUID();
      await tx.query('INSERT INTO assistant_proposals(id,clinic_id,run_id,draft_id,field_key,value,category,evidence,disposition) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [proposalId, s.clinicId, runId, draft.id, p.field, JSON.stringify(p.value), p.category, p.evidence, doctorTouched ? (same ? 'applied' : 'held') : 'applied']);
      if (doctorTouched || same) continue;
      await insertField(tx, draft, p.field, (current?.field_revision ?? 0) + 1, { value: p.value, category: p.category, status: 'proposed', origin: 'ai', evidence: p.evidence, proposalId, actor: null });
      changed = true;
    }
    if (changed || result.accepted.length) await bumpDraft(tx, draft.id);
    await finish(null);
  });
}

/** Raw audio is deleted 24 hours after capture (synthetic staging default; not a legal retention claim). */
export async function purgeAudio(pool: pg.Pool) {
  await pool.query(`WITH old AS (UPDATE assistant_captures SET audio_purged_at=now() WHERE audio_purged_at IS NULL AND created_at < now() - interval '24 hours' RETURNING id)
    DELETE FROM assistant_audio_chunks WHERE capture_id IN (SELECT id FROM old)`);
}

// ---------- Telegram voice inbox ----------

/**
 * Voice note from the clinic bot's webhook (task 004's, task 015). Runs inside the webhook's transaction,
 * after the update id was recorded. The sender must have task 004's Telegram link to an active account
 * with an active membership in the link's clinic; anyone else (unlinked, blocked, removed) gets the
 * standard notice and nothing is stored. Captures wait in the doctor's inbox until the doctor attaches
 * one to an open visit; nothing is transcribed before that.
 */
export async function receiveTelegramVoice(tx: Tx, voice: VoiceMessage): Promise<VoiceOutcome> {
  const link = (await tx.query(`SELECT l.account_id, l.clinic_id FROM telegram_links l
      JOIN accounts a ON a.id=l.account_id AND a.status='active'
      JOIN memberships m ON m.clinic_id=l.clinic_id AND m.user_id=l.account_id AND m.status='active'
     WHERE l.telegram_user_id=$1`, [voice.telegramUserId])).rows[0];
  if (!link) return 'notLinked';
  if (!await isActiveDoctor(tx, link.clinic_id, link.account_id)) return 'notDoctor';
  if (voice.durationS > LIMITS.voiceSeconds || (voice.fileSize ?? 0) > 20 * 1024 * 1024) return 'tooLong';
  const inserted = (await tx.query(`INSERT INTO assistant_captures(id,clinic_id,doctor_id,source,telegram_chat_id,telegram_message_id,telegram_file_id,duration_s,mime_type,status)
    VALUES($1,$2,$3,'telegram',$4,$5,$6,$7,'audio/ogg','pending_attach') ON CONFLICT (telegram_chat_id,telegram_message_id) DO NOTHING RETURNING id`,
    [randomUUID(), link.clinic_id, link.account_id, voice.chatId, voice.messageId, voice.fileId, voice.durationS])).rows[0];
  if (!inserted) return 'duplicate'; // Same message under a new update id.
  await recordAudit(tx, link.account_id, link.clinic_id, 'assistant.telegram_voice', inserted.id);
  return 'received';
}
/** Whether this account has task 004's Telegram link (the panel's hint only; the webhook rechecks everything). */
export async function telegramLinked(tx: Tx, actor: Actor): Promise<boolean> {
  return !!(await tx.query('SELECT 1 FROM telegram_links WHERE account_id=$1', [actor.userId])).rows[0];
}
async function isActiveDoctor(tx: Tx, clinicId: string, userId: string): Promise<boolean> {
  return !!(await tx.query(`SELECT 1 FROM memberships m JOIN accounts a ON a.id=m.user_id WHERE m.clinic_id=$1 AND m.user_id=$2 AND m.status='active' AND m.clinical_access AND a.status='active'
    AND EXISTS(SELECT 1 FROM membership_roles r WHERE r.clinic_id=m.clinic_id AND r.user_id=m.user_id AND r.role='doctor')`, [clinicId, userId])).rows[0];
}
