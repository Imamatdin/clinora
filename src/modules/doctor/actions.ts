import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DocumentVersion, Encounter } from '../../contracts/index.js';

type ClinicalField = DocumentVersion['fields'][number];
import { requireRole, recordAudit, type ClinicContext } from '../../server/roles.js';
import { priceAt } from '../../server/repo/prices.js';
import { Key, fail, once } from '../pharmacy/actions.js';
import { setTicketStatus } from '../registration/actions.js';
import { carriedFields, currentVersion, latestApproval, nextDraftKind, requireApprovable, type ApprovalRef } from '../documents/approvals.js';

/*
 * Doctor workspace (task 010, increment C6). Every action re-reads the doctor role, clinical access and
 * patient scope from the database. A doctor works only on tickets of their own queue points and on
 * patients routed to them (patient_assignments, written by registration); anything else reads as NOT_FOUND.
 * Visit notes reuse the task-002 encounters/documents/document_versions with approval versions intact.
 */

export const DOCTOR = ['doctor'] as const;
/** Services a doctor may order from the visit screen. Medicines go through pharmacy, beds and surgery have their own flows. */
export const ORDERABLE = ['lab', 'procedure', 'diagnostic', 'consultation', 'other'] as const;
export const TEMPLATE_ID = 'clinora-visit-v1';
const NOTE_KEYS = ['reported', 'observed', 'assessment', 'plan'] as const;
const CATEGORY = { reported: 'reported', observed: 'observed', assessment: 'assessment', plan: 'clinician_instruction' } as const;
export const RX_KEY = 'rx.lines';
/** Field keys this editor writes; every other field of the current version (e.g. assistant gp.*) is carried unchanged. */
const OWNED: ReadonlySet<string> = new Set([...NOTE_KEYS, RX_KEY]);

const text = (max: number) => z.string().trim().min(1).max(max);
export const RxLine = z.object({ medicine: text(200), dose: text(100), frequency: text(100), duration: text(100), notes: z.string().trim().max(500).default('') }).strict();
export const Prescription = z.array(RxLine).max(30);
export type RxLine = z.infer<typeof RxLine>;
const NoteText = z.string().max(16000);
export const KeyInput = z.object({ idempotencyKey: Key }).strict();
export const NoteInput = z.object({
  idempotencyKey: Key, expectedRevision: z.number().int().min(0).max(1000000),
  note: z.object({ reported: NoteText, observed: NoteText, assessment: NoteText, plan: NoteText }).strict(),
  prescription: Prescription.default([]),
  amendmentReason: z.string().trim().min(1).max(500).optional()
}).strict();
export const ApproveInput = z.object({ idempotencyKey: Key, expectedRevision: z.number().int().min(1).max(1000000) }).strict();
export const OrderInput = z.object({ idempotencyKey: Key,
  items: z.array(z.object({ serviceId: z.uuid(), quantity: z.number().int().min(1).max(20) }).strict()).min(1).max(20) }).strict();

type Scope = 'clinic' | 'assigned';
/** Binds the route's resource id into the idempotency payload, so one key cannot replay onto another resource. */
const scoped = (input: { idempotencyKey: string }, resource: Record<string, string>): { idempotencyKey: string } => ({ ...input, ...resource });
/** Doctor role and clinical access, rechecked on every call. */
async function doctor(ctx: ClinicContext): Promise<{ c: ClinicContext; scope: Scope }> {
  const c = await requireRole(ctx.tx, ctx.actorId, ctx.clinicId, DOCTOR);
  const m = (await c.tx.query("SELECT patient_scope FROM memberships WHERE clinic_id=$1 AND user_id=$2 AND status='active' AND clinical_access FOR SHARE", [c.clinicId, c.actorId])).rows[0];
  if (!m) return fail('FORBIDDEN');
  return { c, scope: m.patient_scope === 'clinic' ? 'clinic' : 'assigned' };
}
/** Missing, other clinic, or not routed to this doctor all read the same: NOT_FOUND. */
async function patientInScope(c: ClinicContext, scope: Scope, patientId: string) {
  const ok = scope === 'clinic'
    ? (await c.tx.query('SELECT 1 FROM patients WHERE clinic_id=$1 AND id=$2', [c.clinicId, patientId])).rowCount
    : (await c.tx.query('SELECT 1 FROM patient_assignments WHERE clinic_id=$1 AND patient_id=$2 AND user_id=$3 FOR SHARE', [c.clinicId, patientId, c.actorId])).rowCount;
  if (!ok) fail('NOT_FOUND');
}

// ---------- Visit start and completion ----------
// The queue itself (today's tickets, call next, missed call) is task 007's API in src/modules/registration.
// Ticket status changes here go through 007's setTicketStatus, so there is one status machine and one ownership rule.

/** Locks one of this doctor's tickets of the open day, with what the visit screen needs. */
async function myTicket(c: ClinicContext, ticketId: string) {
  const row = (await c.tx.query(`SELECT t.id, t.status, t.visit_id, v.patient_id, v.status visit_status, qp.name_uz_cyrl point_name
    FROM queue_tickets t
    JOIN queue_points qp ON qp.clinic_id=t.clinic_id AND qp.id=t.queue_point_id AND qp.kind='doctor' AND qp.user_id=$2
    JOIN business_days d ON d.clinic_id=t.clinic_id AND d.id=t.business_day_id AND d.status='open'
    JOIN visits v ON v.clinic_id=t.clinic_id AND v.id=t.visit_id
    WHERE t.clinic_id=$1 AND t.id=$3 FOR UPDATE OF t`, [c.clinicId, c.actorId, ticketId])).rows[0];
  return row ?? fail('NOT_FOUND');
}
/** One step through 007's queue status machine. The outer action is idempotent, so the inner key only needs to be fresh. */
const moveTicket = (c: ClinicContext, ticketId: string, status: 'in_progress' | 'completed') =>
  setTicketStatus(c, ticketId, { status, idempotencyKey: randomUUID() });

async function ensureEncounter(c: ClinicContext, t: Record<string, any>): Promise<{ encounterId: string; documentId: string }> {
  const found = (await c.tx.query(`SELECT e.id, d.id document_id FROM encounters e JOIN documents d ON d.clinic_id=e.clinic_id AND d.encounter_id=e.id
    WHERE e.clinic_id=$1 AND e.visit_id=$2 AND e.clinician_id=$3`, [c.clinicId, t.visit_id, c.actorId])).rows[0];
  if (found) return { encounterId: found.id, documentId: found.document_id };
  const info = (await c.tx.query(`SELECT c.timezone, p.specialty_uz_cyrl FROM clinics c
    LEFT JOIN doctor_profiles p ON p.clinic_id=c.id AND p.user_id=$2 WHERE c.id=$1`, [c.clinicId, c.actorId])).rows[0];
  const id = randomUUID(), documentId = randomUUID(), now = new Date().toISOString();
  const encounter = Encounter.parse({ id, patientId: t.patient_id, clinicId: c.clinicId, clinicianId: c.actorId,
    location: { id: null, label: t.point_name }, specialty: info?.specialty_uz_cyrl ?? 'Шифокор қабули',
    occurrence: { precision: 'instant', at: now, timezone: info?.timezone ?? 'Asia/Tashkent' },
    status: 'in_progress', createdAt: now, updatedAt: now, revision: 1, provenance: { source: 'manual', externalReference: null } });
  await c.tx.query('INSERT INTO encounters(id,clinic_id,patient_id,clinician_id,data,visit_id) VALUES($1,$2,$3,$4,$5,$6)', [id, c.clinicId, t.patient_id, c.actorId, encounter, t.visit_id]);
  await c.tx.query('INSERT INTO documents(id,clinic_id,patient_id,encounter_id) VALUES($1,$2,$3,$4)', [documentId, c.clinicId, t.patient_id, id]);
  await recordAudit(c.tx, c.actorId, c.clinicId, 'encounter.created', id, { visitId: t.visit_id });
  return { encounterId: id, documentId };
}

/** Starts (or reopens) the consultation: ticket in progress and the doctor's encounter for this visit, created on first open. */
export async function startVisit(ctx: ClinicContext, ticketId: string, raw: z.input<typeof KeyInput>) {
  const { c, scope } = await doctor(ctx); const input = KeyInput.parse(raw);
  return once(c, 'doctor.start_visit', scoped(input, { ticketId }), async () => {
    const t = await myTicket(c, ticketId);
    await patientInScope(c, scope, t.patient_id);
    if (t.status === 'cancelled' || t.visit_status !== 'open') return fail('INVALID_TRANSITION');
    if (t.status === 'waiting' || t.status === 'called') await moveTicket(c, ticketId, 'in_progress');
    const enc = await ensureEncounter(c, t);
    return { ticketId, patientId: t.patient_id as string, visitId: t.visit_id as string, ...enc };
  });
}

/**
 * Marks the consultation completed: the ticket and the doctor's consultation charge line for this ticket.
 * The line moves ordered -> completed once; repeating (any key, any device) completes nothing further.
 */
export async function completeConsultation(ctx: ClinicContext, ticketId: string, raw: z.input<typeof KeyInput>) {
  const { c, scope } = await doctor(ctx); const input = KeyInput.parse(raw);
  return once(c, 'doctor.complete', scoped(input, { ticketId }), async () => {
    const t = await myTicket(c, ticketId);
    await patientInScope(c, scope, t.patient_id);
    if (t.status === 'cancelled') return fail('INVALID_TRANSITION');
    const line = (await c.tx.query(`SELECT l.id, l.status FROM charge_lines l
      JOIN services s ON s.clinic_id=l.clinic_id AND s.id=l.service_id AND s.kind='consultation'
      WHERE l.clinic_id=$1 AND l.visit_id=$2 AND l.status<>'cancelled'
        AND (l.queue_ticket_id=$3 OR (l.queue_ticket_id IS NULL AND l.performer_user_id=$4))
      ORDER BY (l.queue_ticket_id IS NOT NULL) DESC, l.created_at, l.id LIMIT 1 FOR UPDATE OF l`, [c.clinicId, t.visit_id, ticketId, c.actorId])).rows[0];
    let completedNow = false;
    if (line?.status === 'ordered') {
      completedNow = !!(await c.tx.query(`UPDATE charge_lines SET status='completed', completed_by=$3, completed_at=now(), performer_user_id=coalesce(performer_user_id,$3)
        WHERE clinic_id=$1 AND id=$2 AND status='ordered'`, [c.clinicId, line.id, c.actorId])).rowCount;
    }
    if (t.status === 'waiting' || t.status === 'called') await moveTicket(c, ticketId, 'in_progress');
    if (t.status !== 'completed') await moveTicket(c, ticketId, 'completed');
    await recordAudit(c.tx, c.actorId, c.clinicId, 'doctor.consultation_completed', ticketId, { chargeLineId: line?.id ?? null, completedNow });
    return { ticketId, status: 'completed', chargeLineId: (line?.id ?? null) as string | null, completedNow };
  });
}

// ---------- Patient card ----------

/** Patient summary, previous visits with their diagnosis, and lab results. Routed patients only. */
export async function patientCard(ctx: ClinicContext, patientId: string) {
  const { c, scope } = await doctor(ctx);
  await patientInScope(c, scope, patientId);
  const p = (await c.tx.query(`SELECT id, coalesce(full_name, display_name) name, patient_no, coalesce(birth_date, date_of_birth)::text birth_date, gender
    FROM patients WHERE clinic_id=$1 AND id=$2`, [c.clinicId, patientId])).rows[0];
  const visits = (await c.tx.query(`SELECT e.id, e.created_at, e.data, a.display_name doctor, e.clinician_id=$3 mine,
      cur.data current, ap.version_data approved, ap.approved_at
    FROM encounters e JOIN accounts a ON a.id=e.clinician_id
    JOIN documents d ON d.clinic_id=e.clinic_id AND d.encounter_id=e.id
    LEFT JOIN document_versions cur ON cur.document_id=d.id AND cur.id=d.current_version_id
    LEFT JOIN LATERAL (SELECT v.data version_data, x.approved_at FROM (
        SELECT version_id, revision, approved_at FROM note_approvals WHERE document_id=d.id
        UNION ALL SELECT version_id, revision, approved_at FROM assistant_approvals WHERE document_id=d.id) x
      JOIN document_versions v ON v.document_id=d.id AND v.id=x.version_id ORDER BY x.revision DESC LIMIT 1) ap ON true
    WHERE e.clinic_id=$1 AND e.patient_id=$2 ORDER BY e.created_at DESC LIMIT 30`, [c.clinicId, patientId, c.actorId])).rows;
  const labs = (await c.tx.query(`SELECT l.id, s.name_uz_cyrl service, l.status, l.created_at, l.completed_at, r.version, r.result, r.entered_at
    FROM charge_lines l JOIN services s ON s.clinic_id=l.clinic_id AND s.id=l.service_id AND s.kind='lab'
    JOIN visits v ON v.clinic_id=l.clinic_id AND v.id=l.visit_id AND v.patient_id=$2
    LEFT JOIN LATERAL (SELECT version, result, entered_at FROM lab_results WHERE clinic_id=l.clinic_id AND charge_line_id=l.id ORDER BY version DESC LIMIT 1) r ON true
    WHERE l.clinic_id=$1 AND l.status<>'cancelled' ORDER BY l.created_at DESC LIMIT 50`, [c.clinicId, patientId])).rows;
  const diagnosis = (v: unknown) => { const f = (v as DocumentVersion | null)?.fields ?? []; const x = f.find(f => f.key === 'assessment') ?? f.find(f => f.key === 'gp.diagnosis'); return x?.value == null ? null : String(x.value); };
  return {
    patient: { id: p.id as string, name: p.name as string, patientNo: p.patient_no as number | null, birthDate: p.birth_date as string | null, gender: p.gender as string | null },
    visits: visits.map(v => ({ encounterId: v.id as string, at: v.created_at, specialty: v.data.specialty as string, doctor: v.doctor as string, mine: v.mine as boolean,
      approved: !!v.approved, approvedAt: v.approved_at ?? null,
      // Another doctor's unapproved draft is not shown as a diagnosis.
      diagnosis: v.approved ? diagnosis(v.approved) : v.mine ? diagnosis(v.current) : null })),
    labs: labs.map(l => ({ id: l.id as string, service: l.service as string, status: l.status as string, orderedAt: l.created_at, completedAt: l.completed_at,
      result: l.version ? { version: l.version as number, enteredAt: l.entered_at, ...(l.result as object) } : null }))
  };
}

// ---------- Visit note ----------

/** The doctor's own encounter. Locks the document row when `lock` is set. Patient must still be in scope. */
async function myEncounter(c: ClinicContext, scope: Scope, encounterId: string, lock = false) {
  const row = (await c.tx.query(`SELECT e.id, e.patient_id, e.visit_id, e.data, e.created_at, d.id document_id, d.current_revision, d.current_version_id
    FROM encounters e JOIN documents d ON d.clinic_id=e.clinic_id AND d.encounter_id=e.id
    WHERE e.clinic_id=$1 AND e.id=$2 AND e.clinician_id=$3 ${lock ? 'FOR UPDATE OF d' : ''}`, [c.clinicId, encounterId, c.actorId])).rows[0];
  if (!row) return fail('NOT_FOUND');
  await patientInScope(c, scope, row.patient_id);
  return row;
}

export function parsePrescription(fields: readonly ClinicalField[]): RxLine[] {
  const raw = fields.find(f => f.key === RX_KEY)?.value;
  if (typeof raw !== 'string') return [];
  try { const r = Prescription.safeParse(JSON.parse(raw)); return r.success ? r.data : []; } catch { return []; }
}
const noteOf = (v: DocumentVersion | null) => Object.fromEntries(NOTE_KEYS.map(k => { const x = v?.fields.find(f => f.key === k)?.value; return [k, x == null ? '' : String(x)]; })) as Record<typeof NOTE_KEYS[number], string>;
const approvalView = (a: ApprovalRef | null, currentId: string | null) => a ? { ...a, current: a.versionId === currentId } : null;

export async function visitView(ctx: ClinicContext, encounterId: string) {
  const { c, scope } = await doctor(ctx);
  const e = await myEncounter(c, scope, encounterId);
  const current = await currentVersion(c.tx, { id: e.document_id, current_version_id: e.current_version_id });
  const approval = await latestApproval(c.tx, e.document_id);
  const ticket = e.visit_id ? (await c.tx.query(`SELECT t.id, t.number, t.status FROM queue_tickets t
    JOIN queue_points qp ON qp.clinic_id=t.clinic_id AND qp.id=t.queue_point_id AND qp.kind='doctor' AND qp.user_id=$3
    WHERE t.clinic_id=$1 AND t.visit_id=$2 ORDER BY t.created_at DESC LIMIT 1`, [c.clinicId, e.visit_id, c.actorId])).rows[0] ?? null : null;
  const visit = e.visit_id ? (await c.tx.query('SELECT status FROM visits WHERE clinic_id=$1 AND id=$2', [c.clinicId, e.visit_id])).rows[0] : null;
  // Only lines this doctor ordered or performs; other doctors' services and prices stay with the cashier.
  const charges = e.visit_id ? (await c.tx.query(`SELECT l.id, s.name_uz_cyrl service, s.kind, l.status, l.quantity, l.unit_price_uzs::text unit_price_uzs, l.created_at,
      (SELECT max(version) FROM lab_results r WHERE r.clinic_id=l.clinic_id AND r.charge_line_id=l.id) result_version
    FROM charge_lines l JOIN services s ON s.clinic_id=l.clinic_id AND s.id=l.service_id
    WHERE l.clinic_id=$1 AND l.visit_id=$2 AND (l.created_by=$3 OR l.performer_user_id=$3 OR l.queue_ticket_id=$4)
    ORDER BY l.created_at, l.id`, [c.clinicId, e.visit_id, c.actorId, ticket?.id ?? null])).rows : [];
  return {
    encounter: { id: e.id as string, patientId: e.patient_id as string, visitId: e.visit_id as string | null, specialty: e.data.specialty as string,
      location: e.data.location.label as string, createdAt: e.created_at },
    visitOpen: visit?.status === 'open', ticket,
    documentId: e.document_id as string, revision: e.current_revision as number, versionId: e.current_version_id as string | null,
    kind: current?.kind ?? null, amendmentReason: current?.amendmentReason ?? null,
    note: noteOf(current), prescription: current ? parsePrescription(current.fields) : [],
    otherFields: (current?.fields ?? []).filter(f => !OWNED.has(f.key)).map(f => ({ key: f.key, value: f.value })),
    approval: approvalView(approval, e.current_version_id),
    charges: charges.map(l => ({ id: l.id as string, service: l.service as string, kind: l.kind as string, status: l.status as string, quantity: l.quantity as number,
      unitPriceUzs: l.unit_price_uzs as string, resultVersion: (l.result_version ?? null) as number | null }))
  };
}

/** Saves a draft version. After an approval the draft is an explicit amendment that names the approval and a reason. */
export async function saveNote(ctx: ClinicContext, encounterId: string, raw: z.input<typeof NoteInput>) {
  const { c, scope } = await doctor(ctx); const input = NoteInput.parse(raw);
  return once(c, 'doctor.save_note', scoped(input, { encounterId }), async () => {
    const e = await myEncounter(c, scope, encounterId, true);
    if (e.current_revision !== input.expectedRevision) return fail('STALE_VERSION');
    const current = await currentVersion(c.tx, { id: e.document_id, current_version_id: e.current_version_id });
    const kind = nextDraftKind(await latestApproval(c.tx, e.document_id), current, input.amendmentReason);
    const revision = e.current_revision + 1, now = new Date().toISOString();
    const field = (key: string, value: string | null, category: ClinicalField['category']): ClinicalField =>
      ({ key, value, category, status: 'proposed', origin: 'clinician', revision, evidence: [], editedBy: c.actorId, unresolvedConflict: null });
    // An empty field stays unrecorded (null), never an empty or "normal" value.
    const fields = [...NOTE_KEYS.map(k => field(k, input.note[k].trim() || null, CATEGORY[k])),
      ...(input.prescription.length ? [field(RX_KEY, JSON.stringify(input.prescription), 'clinician_instruction')] : []),
      ...carriedFields(current, OWNED)];
    const version = DocumentVersion.parse({ id: randomUUID(), documentId: e.document_id, encounterId, clinicId: c.clinicId, patientId: e.patient_id,
      revision, parentVersionId: e.current_version_id, ...kind, templateId: TEMPLATE_ID, fields, createdBy: c.actorId, createdAt: now });
    await c.tx.query('INSERT INTO document_versions(id,document_id,clinic_id,patient_id,revision,created_by,data) VALUES($1,$2,$3,$4,$5,$6,$7)', [version.id, e.document_id, c.clinicId, e.patient_id, revision, c.actorId, version]);
    await c.tx.query('UPDATE documents SET current_revision=$1,current_version_id=$2 WHERE id=$3', [revision, version.id, e.document_id]);
    await recordAudit(c.tx, c.actorId, c.clinicId, 'doctor.note_saved', version.id, { revision, kind: version.kind });
    return { revision, versionId: version.id, kind: version.kind };
  });
}

/**
 * Approves the current version by writing an immutable confirmed copy of it and an approval that references
 * that exact version. An amendment must name the latest approval; the new approval records which one it supersedes.
 */
export async function approveNote(ctx: ClinicContext, encounterId: string, raw: z.input<typeof ApproveInput>) {
  const { c, scope } = await doctor(ctx); const input = ApproveInput.parse(raw);
  return once(c, 'doctor.approve_note', scoped(input, { encounterId }), async () => {
    const e = await myEncounter(c, scope, encounterId, true);
    if (e.current_revision !== input.expectedRevision) return fail('STALE_VERSION');
    const approval = await latestApproval(c.tx, e.document_id);
    const current = requireApprovable(await currentVersion(c.tx, { id: e.document_id, current_version_id: e.current_version_id }), input.expectedRevision, approval);
    if (approval && (current.kind !== 'amendment' || current.amendsApprovalId !== approval.id)) return fail('INVALID_TRANSITION');
    if (current.fields.some(f => f.key === RX_KEY) && !parsePrescription(current.fields).length) return fail('INVALID_INPUT');
    const revision = current.revision + 1, now = new Date().toISOString();
    const fields = current.fields.map(f => f.status === 'clinician_confirmed' || f.status === 'corrected' ? f
      : { ...f, status: 'clinician_confirmed' as const, editedBy: f.editedBy ?? c.actorId, revision });
    const version = DocumentVersion.parse({ ...current, id: randomUUID(), revision, parentVersionId: current.id, fields, createdBy: c.actorId, createdAt: now });
    await c.tx.query('INSERT INTO document_versions(id,document_id,clinic_id,patient_id,revision,created_by,data) VALUES($1,$2,$3,$4,$5,$6,$7)', [version.id, e.document_id, c.clinicId, e.patient_id, revision, c.actorId, version]);
    await c.tx.query('UPDATE documents SET current_revision=$1,current_version_id=$2 WHERE id=$3', [revision, version.id, e.document_id]);
    const approvalId = randomUUID();
    await c.tx.query(`INSERT INTO note_approvals(id,clinic_id,patient_id,document_id,version_id,revision,amends_approval_id,approved_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [approvalId, c.clinicId, e.patient_id, e.document_id, version.id, revision, approval?.id ?? null, c.actorId]);
    await recordAudit(c.tx, c.actorId, c.clinicId, 'doctor.note_approved', version.id, { revision, amends: approval?.id ?? null });
    return { approvalId, versionId: version.id, revision };
  });
}

// ---------- Orders ----------

/**
 * Orderable services with the price in force now, read through the shared priceAt helper (the same rule the catalog
 * and charging use). Services without a price are not offered: nothing is ever charged as zero.
 */
export async function catalog(ctx: ClinicContext) {
  const { c } = await doctor(ctx);
  const services = (await c.tx.query('SELECT id, name_uz_cyrl name, kind FROM services WHERE clinic_id=$1 AND is_active AND kind = ANY($2) ORDER BY kind, name_uz_cyrl LIMIT 500',
    [c.clinicId, ORDERABLE])).rows;
  const now = new Date(), out = [] as { id: string; name: string; kind: string; priceUzs: string }[];
  for (const s of services) {
    const price = await priceAt(c.tx, c.clinicId, s.id, now);
    if (price) out.push({ id: s.id, name: s.name, kind: s.kind, priceUzs: price.priceUzs.toString() });
  }
  return out;
}

/** New ordered charge lines on the doctor's visit, priced by priceAt at the moment of ordering. */
export async function orderServices(ctx: ClinicContext, encounterId: string, raw: z.input<typeof OrderInput>) {
  const { c, scope } = await doctor(ctx); const input = OrderInput.parse(raw);
  return once(c, 'doctor.order', scoped(input, { encounterId }), async () => {
    const e = await myEncounter(c, scope, encounterId);
    if (!e.visit_id) return fail('INVALID_TRANSITION');
    const open = (await c.tx.query(`SELECT 1 FROM visits v JOIN business_days d ON d.clinic_id=v.clinic_id AND d.id=v.business_day_id
      WHERE v.clinic_id=$1 AND v.id=$2 AND v.status='open' AND d.status='open' FOR SHARE OF v, d`, [c.clinicId, e.visit_id])).rowCount;
    if (!open) return fail('INVALID_TRANSITION');
    const at = new Date(), lines = [] as { id: string; serviceId: string; unitPriceUzs: string }[];
    for (const item of input.items) {
      const ok = (await c.tx.query('SELECT 1 FROM services WHERE clinic_id=$1 AND id=$2 AND is_active AND kind = ANY($3) FOR SHARE', [c.clinicId, item.serviceId, ORDERABLE])).rowCount;
      if (!ok) return fail('NOT_FOUND');
      const price = await priceAt(c.tx, c.clinicId, item.serviceId, at);
      if (!price) return fail('INVALID_TRANSITION');
      const id = randomUUID();
      await c.tx.query(`INSERT INTO charge_lines(id,clinic_id,visit_id,service_id,quantity,unit_price_uzs,status,source,created_by,created_at)
        VALUES($1,$2,$3,$4,$5,$6,'ordered','doctor',$7,$8)`, [id, c.clinicId, e.visit_id, item.serviceId, item.quantity, price.priceUzs.toString(), c.actorId, at]);
      lines.push({ id, serviceId: item.serviceId, unitPriceUzs: price.priceUzs.toString() });
    }
    await recordAudit(c.tx, c.actorId, c.clinicId, 'doctor.services_ordered', e.visit_id, { lines: lines.map(l => l.id) });
    return { lines };
  });
}

// ---------- Prescription ----------

export type PrescriptionDocument = {
  clinic: { name: string; address: string | null; phone: string | null }; patient: { name: string; patientNo: number | null; birthDate: string | null };
  doctor: { name: string; specialty: string | null }; approvedAt: string; timezone: string; approvalId: string; versionId: string; revision: number;
  diagnosis: string | null; lines: RxLine[]; recommendations: string | null;
};
/** Everything printed on the prescription, read only from the latest approved version (never a newer draft). */
export async function prescriptionDocument(ctx: ClinicContext, encounterId: string): Promise<PrescriptionDocument> {
  const { c, scope } = await doctor(ctx);
  const e = await myEncounter(c, scope, encounterId);
  const approval = await latestApproval(c.tx, e.document_id);
  if (!approval) return fail('INVALID_TRANSITION');
  const v = DocumentVersion.parse((await c.tx.query('SELECT data FROM document_versions WHERE document_id=$1 AND id=$2', [e.document_id, approval.versionId])).rows[0].data);
  const info = (await c.tx.query(`SELECT cl.name clinic, cl.timezone, s.receipt_header, coalesce(p.full_name, p.display_name) patient, p.patient_no,
      coalesce(p.birth_date, p.date_of_birth)::text birth_date, a.display_name doctor, dp.specialty_uz_cyrl specialty
    FROM clinics cl JOIN patients p ON p.clinic_id=cl.id AND p.id=$2 JOIN accounts a ON a.id=$3
    LEFT JOIN clinic_settings s ON s.clinic_id=cl.id LEFT JOIN doctor_profiles dp ON dp.clinic_id=cl.id AND dp.user_id=$3
    WHERE cl.id=$1`, [c.clinicId, e.patient_id, c.actorId])).rows[0];
  const header = (info.receipt_header ?? {}) as Record<string, unknown>;
  const str = (x: unknown) => typeof x === 'string' && x.trim() ? x.trim() : null;
  const value = (key: string) => { const x = v.fields.find(f => f.key === key)?.value; return x == null ? null : String(x); };
  await recordAudit(c.tx, c.actorId, c.clinicId, 'doctor.prescription_rendered', approval.versionId, { revision: approval.revision });
  return {
    clinic: { name: str(header.name) ?? info.clinic, address: str(header.address), phone: str(header.phone) },
    patient: { name: info.patient, patientNo: info.patient_no, birthDate: info.birth_date },
    doctor: { name: info.doctor, specialty: info.specialty ?? null }, approvedAt: approval.approvedAt, timezone: info.timezone,
    approvalId: approval.id, versionId: v.id, revision: v.revision,
    diagnosis: value('assessment') ?? value('gp.diagnosis'), lines: parsePrescription(v.fields), recommendations: value('plan') ?? value('gp.plan')
  };
}
