import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../identity/access.js';
import { Phone, type Role } from '../identity/roles.js';
import { QUEUE_TRANSITIONS, QueueTicketStatus } from '../../contracts/db/queue.js';
import { requireRole, type ClinicContext } from '../../server/roles.js';
import { withAudit } from '../../server/repo/audit.js';
import { nextPatientNo, nextQueueNumber } from '../../server/repo/counters.js';
import { priceAt } from '../../server/repo/prices.js';

/*
 * Registration, visits, routing and queue tickets (task 007, increment C4).
 * Every mutation is a typed server action: zod input, explicit roles rechecked here (not only by the
 * route), an idempotency key scoped to clinic + actor + operation, and an audit event in the same
 * transaction. The doctor assistant will call these same functions later.
 */

export const REGISTRARS = ['registrar', 'administrator', 'ceo'] as const satisfies readonly Role[];
/** Doctors manage their own queue; administrators and the CEO may manage any queue point. */
export const QUEUE_ROLES = ['doctor', 'administrator', 'ceo'] as const satisfies readonly Role[];
const QUEUE_MANAGERS: readonly Role[] = ['administrator', 'ceo'];
/** Patient acquisition source codes (patients.source). Labels live in the web dictionaries. */
export const SOURCES = ['walk_in', 'referral', 'advertisement', 'social', 'returning', 'other'] as const;

const fail = (code: ConstructorParameters<typeof DomainError>[0]): never => { throw new DomainError(code); };
const id = z.uuid();
export const Key = z.string().min(8).max(200);
const text = (max: number) => z.string().trim().min(1).max(max);
const birthDate = z.iso.date().refine(v => v >= '1900-01-01' && Date.parse(v) <= Date.now(), 'Birth date out of range');

export const SearchInput = z.object({ query: text(100) }).strict();
export const DuplicateInput = z.object({
  fullName: text(200), birthDate: birthDate.nullable().optional(), phone: Phone.nullable().optional(), excludePatientId: id.optional()
}).strict();
const patientFields = {
  fullName: text(200), birthDate, gender: z.enum(['male', 'female']), phone: Phone.nullable(),
  districtId: id.nullable(), mahallaId: id.nullable(), address: text(500).nullable(), source: z.enum(SOURCES).nullable()
};
export const PatientInput = z.object({ ...patientFields, duplicateReason: text(500).optional(), idempotencyKey: Key }).strict();
export const PatientUpdateInput = z.object({ ...patientFields, expectedRevision: z.number().int().positive(), idempotencyKey: Key }).strict();
export const VisitInput = z.object({
  patientId: id,
  points: z.array(z.object({ queuePointId: id, serviceIds: z.array(id).max(20) }).strict()).min(1).max(10),
  /** Task 017: the registrar marks an arrival for admission; inpatient staff can admit only inpatient visits. */
  type: z.enum(['outpatient', 'inpatient']).default('outpatient'),
  idempotencyKey: Key
}).strict();
export const OfflineInput = z.object({
  patient: PatientInput.omit({ idempotencyKey: true }).optional(), patientId: id.optional(),
  businessDayId: id, points: VisitInput.shape.points, idempotencyKey: Key,
  provisionalCode: z.string().regex(/^R[A-F0-9]{8}-\d{2,10}$/).optional()
}).strict().refine(v => !!v.patient !== !!v.patientId);

/** One transaction for registration plus routing. A failed route leaves no half-registered patient.
 * Replays resolve before day/catalog validation so a lost response remains recoverable after day close.
 */
export async function syncRegistration(ctx: ClinicContext, raw: z.input<typeof OfflineInput>) {
  ctx = await authorize(ctx, REGISTRARS);
  const input = OfflineInput.parse(raw);
  return once(ctx, 'registration.offline', input, async () => {
    const person = input.patient ? await registerPatient(ctx, { ...input.patient, idempotencyKey: input.idempotencyKey }) : null;
    const visit = await createVisit(ctx, { patientId: person?.id ?? input.patientId!, points: input.points, idempotencyKey: input.idempotencyKey }, input.businessDayId);
    return { ...visit, ...(input.provisionalCode ? { code: input.provisionalCode } : {}) };
  });
}
/** Non-clinical call list survives a page reload; no queued registration fields are retained locally. */
export async function offlineHistory(ctx: ClinicContext) {
  ctx = await authorize(ctx, REGISTRARS);
  const rows = (await ctx.tx.query(`SELECT response FROM idempotency_records
    WHERE clinic_id=$1 AND actor_id=$2 AND operation='registration.offline' AND response ? 'code'
      AND created_at>now()-interval '2 days' ORDER BY created_at DESC LIMIT 200`, [ctx.clinicId, ctx.actorId])).rows;
  return rows.reverse().map(({ response: r }) => ({ code: r.code, visitId: r.visitId, businessDate: r.businessDate, tickets: r.tickets }));
}
export const CallNextInput = z.object({ queuePointId: id.optional(), idempotencyKey: Key }).strict();
export const TicketStatusInput = z.object({ status: QueueTicketStatus, idempotencyKey: Key }).strict();

export type PatientSummary = { id: string; patientNo: number; fullName: string; birthDate: string | null; gender: 'male' | 'female' | null; phone: string | null };
export type TicketView = { id: string; queuePointId: string; number: number; status: string; names: Names };
type Names = { uzCyrl: string; uzLatn: string | null; ru: string | null };
const names = (r: { name_uz_cyrl: string; name_uz_latn: string | null; name_ru: string | null }): Names =>
  ({ uzCyrl: r.name_uz_cyrl, uzLatn: r.name_uz_latn, ru: r.name_ru });
const summary = (r: Record<string, any>): PatientSummary =>
  ({ id: r.id, patientNo: r.patient_no, fullName: r.full_name, birthDate: r.birth_date, gender: r.gender, phone: r.phone });

async function authorize(ctx: ClinicContext, roles: readonly Role[]): Promise<ClinicContext> {
  return requireRole(ctx.tx, ctx.actorId, ctx.clinicId, roles);
}
const stable = (value: unknown): string => JSON.stringify(value, (_k, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
/**
 * Replays a stored result for the same clinic, actor, operation and key; a different payload under the
 * same key is IDEMPOTENCY_CONFLICT. The advisory lock makes a concurrent duplicate wait for the first.
 */
async function once<T>(ctx: ClinicContext, operation: string, input: { idempotencyKey: string }, work: () => Promise<T>,
  /** Rechecks current access before a stored response is returned again (task 019). */ replay?: (stored: T) => Promise<T>): Promise<T> {
  const scope = [ctx.clinicId, ctx.actorId, operation, input.idempotencyKey];
  await ctx.tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(scope)]);
  const hash = createHash('sha256').update(stable(input)).digest('hex');
  const old = (await ctx.tx.query('SELECT payload_hash,response FROM idempotency_records WHERE clinic_id=$1 AND actor_id=$2 AND operation=$3 AND key=$4', scope)).rows[0];
  if (old) {
    if (old.payload_hash !== hash) return fail('IDEMPOTENCY_CONFLICT');
    return replay ? replay(old.response as T) : old.response as T;
  }
  const result = await work();
  await ctx.tx.query('INSERT INTO idempotency_records(clinic_id,actor_id,operation,key,payload_hash,response) VALUES($1,$2,$3,$4,$5,$6)', [...scope, hash, JSON.stringify(result)]);
  return result;
}
async function openDay(ctx: ClinicContext): Promise<{ id: string; business_date: string } | null> {
  return (await ctx.tx.query("SELECT id,business_date FROM business_days WHERE clinic_id=$1 AND status='open' FOR SHARE", [ctx.clinicId])).rows[0] ?? null;
}

// ---------------------------------------------------------------------------------------------
// Reads for the registrar screen
// ---------------------------------------------------------------------------------------------

/** Everything the registrar picks from: queue points with today's queue length and their priced services, districts, sources. */
export async function options(ctx: ClinicContext) {
  ctx = await authorize(ctx, REGISTRARS);
  const day = (await ctx.tx.query("SELECT id,business_date FROM business_days WHERE clinic_id=$1 AND status='open'", [ctx.clinicId])).rows[0] ?? null;
  const points = (await ctx.tx.query(`SELECT q.*, coalesce(w.waiting,0)::int waiting FROM queue_points q
      LEFT JOIN memberships m ON m.clinic_id=q.clinic_id AND m.user_id=q.user_id
      LEFT JOIN (SELECT queue_point_id, count(*) waiting FROM queue_tickets WHERE clinic_id=$1 AND business_day_id=$2 AND status IN ('waiting','called')
        GROUP BY queue_point_id) w ON w.queue_point_id=q.id
     WHERE q.clinic_id=$1 AND q.is_active AND (q.kind<>'doctor' OR m.status='active')
     ORDER BY q.kind='doctor' DESC, q.name_uz_cyrl, q.id`, [ctx.clinicId, day?.id ?? null])).rows;
  const services = (await ctx.tx.query(`SELECT q.id point_id, s.id, s.kind, s.name_uz_cyrl, s.name_uz_latn, s.name_ru,
      (SELECT price_uzs::text FROM service_prices p WHERE p.clinic_id=s.clinic_id AND p.service_id=s.id AND p.effective_from<=now() ORDER BY effective_from DESC LIMIT 1) price_uzs
    FROM queue_points q JOIN services s ON s.clinic_id=q.clinic_id AND s.is_active AND (
        (q.kind='doctor' AND EXISTS (SELECT 1 FROM doctor_services d WHERE d.clinic_id=q.clinic_id AND d.user_id=q.user_id AND d.service_id=s.id))
     OR (q.kind='service' AND s.group_id=q.service_group_id)
     OR (q.kind='department' AND s.department_id=q.department_id AND s.kind IN ('consultation','procedure','diagnostic','lab')))
    WHERE q.clinic_id=$1 AND q.is_active ORDER BY s.kind='consultation' DESC, s.name_uz_cyrl, s.id`, [ctx.clinicId])).rows;
  const districts = (await ctx.tx.query('SELECT id,name_uz_cyrl,name_uz_latn,name_ru FROM districts WHERE clinic_id=$1 ORDER BY name_uz_cyrl,id', [ctx.clinicId])).rows;
  const mahallas = (await ctx.tx.query('SELECT id,district_id,name_uz_cyrl,name_uz_latn,name_ru FROM mahallas WHERE clinic_id=$1 ORDER BY name_uz_cyrl,id', [ctx.clinicId])).rows;
  return {
    day: day ? { id: day.id, businessDate: day.business_date } : null,
    points: points.map(p => ({ id: p.id, kind: p.kind, names: names(p), waiting: p.waiting,
      services: services.filter(s => s.point_id === p.id).slice(0, 200).map(s => ({ id: s.id, kind: s.kind, names: names(s), priceUzs: s.price_uzs as string | null })) })),
    districts: districts.map(d => ({ id: d.id, names: names(d), mahallas: mahallas.filter(m => m.district_id === d.id).map(m => ({ id: m.id, names: names(m) })) })),
    sources: SOURCES
  };
}

/**
 * Finds patients by patient number (exact), the last 4+ digits of the phone (suffix match on digits),
 * or name in any script: every word of the query must occur in the folded name (registration_fold,
 * migration 015), so Cyrillic and Latin spellings find each other.
 */
export async function search(ctx: ClinicContext, input: z.infer<typeof SearchInput>): Promise<(PatientSummary & { lastVisit: string | null })[]> {
  ctx = await authorize(ctx, REGISTRARS);
  const raw = input.query, digits = raw.replace(/\D/g, ''), phoneLike = /^[\d\s()+-]+$/.test(raw);
  const rows = (await ctx.tx.query(`WITH q AS (SELECT registration_fold($2) folded)
    SELECT p.id,p.patient_no,p.full_name,p.birth_date,p.gender,p.phone,
      (SELECT max(d.business_date)::text FROM visits v JOIN business_days d ON d.clinic_id=v.clinic_id AND d.id=v.business_day_id
        WHERE v.clinic_id=p.clinic_id AND v.patient_id=p.id) last_visit
    FROM patients p, q WHERE p.clinic_id=$1 AND (
      ($3::int IS NOT NULL AND p.patient_no=$3)
      OR ($4::text IS NOT NULL AND regexp_replace(coalesce(p.phone,''),'[^0-9]','','g') LIKE '%' || $4)
      OR (length(replace(q.folded,' ',''))>=2 AND NOT EXISTS (SELECT 1 FROM unnest(string_to_array(q.folded,' ')) w
            WHERE position(w IN registration_fold(p.full_name))=0)))
    ORDER BY (p.patient_no=$3) DESC NULLS LAST, p.full_name, p.patient_no LIMIT 30`,
    [ctx.clinicId, phoneLike ? '' : raw, /^\d{1,9}$/.test(raw) ? Number(raw) : null, phoneLike && digits.length >= 4 ? digits : null])).rows;
  return rows.map(r => ({ ...summary(r), lastVisit: r.last_visit }));
}

/** Patients with the same phone, or the same name (any script) and birth date. */
export async function duplicates(ctx: ClinicContext, input: z.infer<typeof DuplicateInput>): Promise<PatientSummary[]> {
  ctx = await authorize(ctx, REGISTRARS);
  return (await ctx.tx.query(`SELECT id,patient_no,full_name,birth_date,gender,phone FROM patients
    WHERE clinic_id=$1 AND id IS DISTINCT FROM $5::uuid AND (($2::text IS NOT NULL AND phone=$2)
      OR ($3::date IS NOT NULL AND birth_date=$3 AND registration_fold(full_name)=registration_fold($4)))
    ORDER BY patient_no LIMIT 10`, [ctx.clinicId, input.phone ?? null, input.birthDate ?? null, input.fullName, input.excludePatientId ?? null])).rows.map(summary);
}

/** Registration details and visit history. No encounters, notes or results: those stay in the clinical workspace. */
export async function patient(ctx: ClinicContext, patientId: string) {
  ctx = await authorize(ctx, REGISTRARS);
  const row = (await ctx.tx.query('SELECT * FROM patients WHERE clinic_id=$1 AND id=$2', [ctx.clinicId, patientId])).rows[0];
  if (!row) return fail('NOT_FOUND');
  const visits = (await ctx.tx.query(`SELECT v.id,v.type,v.status,d.business_date,
      coalesce(json_agg(json_build_object('number',t.number,'status',t.status,'names',json_build_object('uzCyrl',q.name_uz_cyrl,'uzLatn',q.name_uz_latn,'ru',q.name_ru)) ORDER BY t.created_at)
        FILTER (WHERE t.id IS NOT NULL),'[]') tickets
    FROM visits v JOIN business_days d ON d.clinic_id=v.clinic_id AND d.id=v.business_day_id
    LEFT JOIN queue_tickets t ON t.clinic_id=v.clinic_id AND t.visit_id=v.id LEFT JOIN queue_points q ON q.clinic_id=t.clinic_id AND q.id=t.queue_point_id
    WHERE v.clinic_id=$1 AND v.patient_id=$2 GROUP BY v.id,d.business_date ORDER BY v.created_at DESC LIMIT 20`, [ctx.clinicId, patientId])).rows;
  return { patient: { ...summary(row), districtId: row.district_id, mahallaId: row.mahalla_id, address: row.address, source: row.source, revision: row.revision },
    visits: visits.map(v => ({ id: v.id, type: v.type, status: v.status, businessDate: v.business_date, tickets: v.tickets })) };
}

// ---------------------------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------------------------

async function checkAddress(ctx: ClinicContext, districtId: string | null, mahallaId: string | null) {
  if (mahallaId && !districtId) return fail('INVALID_INPUT');
  if (districtId && !(await ctx.tx.query('SELECT 1 FROM districts WHERE clinic_id=$1 AND id=$2', [ctx.clinicId, districtId])).rowCount) return fail('NOT_FOUND');
  if (mahallaId && !(await ctx.tx.query('SELECT 1 FROM mahallas WHERE clinic_id=$1 AND district_id=$2 AND id=$3', [ctx.clinicId, districtId, mahallaId])).rowCount) return fail('NOT_FOUND');
}

/**
 * Registers a new patient with the next clinic patient number. If a possible duplicate exists the
 * registrar must give a reason (stored in patient_duplicate_overrides, not in audit), otherwise
 * ALREADY_EXISTS and the screen shows the candidates from `duplicates`.
 */
export async function registerPatient(ctx: ClinicContext, raw: z.input<typeof PatientInput>): Promise<PatientSummary> {
  ctx = await authorize(ctx, REGISTRARS);
  const input = PatientInput.parse(raw);
  return once(ctx, 'registration.patient', input, async () => {
    await checkAddress(ctx, input.districtId, input.mahallaId);
    // Serialize duplicate checks per clinic so two desks cannot both miss each other's new patient.
    await ctx.tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['registration.patient:' + ctx.clinicId]);
    const matches = await duplicates(ctx, { fullName: input.fullName, birthDate: input.birthDate, phone: input.phone });
    if (matches.length && !input.duplicateReason) return fail('ALREADY_EXISTS');
    const patientId = randomUUID(), patientNo = await nextPatientNo(ctx.tx, ctx.clinicId);
    // full_name is canonical; display_name and date_of_birth mirror it for the task-002 notebook.
    const row = (await ctx.tx.query(`INSERT INTO patients(id,clinic_id,patient_no,full_name,display_name,birth_date,date_of_birth,gender,phone,
        district_id,mahalla_id,address,source,provenance) VALUES($1,$2,$3,$4,$4,$5,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [patientId, ctx.clinicId, patientNo, input.fullName, input.birthDate, input.gender, input.phone, input.districtId, input.mahallaId,
        input.address, input.source, { source: 'registration', externalReference: null }])).rows[0];
    if (matches.length) {
      await ctx.tx.query('INSERT INTO patient_duplicate_overrides(id,clinic_id,patient_id,matched_patient_ids,reason,created_by) VALUES($1,$2,$3,$4,$5,$6)',
        [randomUUID(), ctx.clinicId, patientId, matches.map(m => m.id), input.duplicateReason, ctx.actorId]);
    }
    await withAudit(ctx.tx, ctx, 'registration.patient_registered', patientId, { patientNo, duplicateMatches: matches.length });
    return summary(row);
  });
}

/** Edits registration details. Name changes write full_name and display_name together. Stale revisions are rejected. */
export async function updatePatient(ctx: ClinicContext, patientId: string, raw: z.input<typeof PatientUpdateInput>): Promise<PatientSummary & { revision: number }> {
  ctx = await authorize(ctx, REGISTRARS);
  const input = PatientUpdateInput.parse(raw);
  return once(ctx, `registration.patient_update:${patientId}`, input, async () => {
    const current = (await ctx.tx.query('SELECT revision FROM patients WHERE clinic_id=$1 AND id=$2 FOR UPDATE', [ctx.clinicId, patientId])).rows[0];
    if (!current) return fail('NOT_FOUND');
    if (current.revision !== input.expectedRevision) return fail('STALE_VERSION');
    await checkAddress(ctx, input.districtId, input.mahallaId);
    const row = (await ctx.tx.query(`UPDATE patients SET full_name=$3,display_name=$3,birth_date=$4,date_of_birth=$4,gender=$5,phone=$6,district_id=$7,
        mahalla_id=$8,address=$9,source=$10,revision=revision+1,updated_at=now() WHERE clinic_id=$1 AND id=$2 RETURNING *`,
      [ctx.clinicId, patientId, input.fullName, input.birthDate, input.gender, input.phone, input.districtId, input.mahallaId, input.address, input.source])).rows[0];
    await withAudit(ctx.tx, ctx, 'registration.patient_updated', patientId, { revision: row.revision });
    return { ...summary(row), revision: row.revision };
  });
}

type PointRow = { id: string; kind: 'doctor' | 'department' | 'service'; user_id: string | null; department_id: string | null; service_group_id: string | null;
  name_uz_cyrl: string; name_uz_latn: string | null; name_ru: string | null };

/**
 * Opens an outpatient visit in the open business day and routes it: one queue ticket per queue point
 * (numbers from nextQueueNumber, restarting each day), one ordered charge line per chosen service at the
 * price in force now, and a patient_assignments row for every routed doctor so the task-002
 * assigned-scope check lets that doctor, and only that doctor, read the patient.
 */
export async function createVisit(ctx: ClinicContext, raw: z.input<typeof VisitInput>, expectedBusinessDayId?: string) {
  ctx = await authorize(ctx, REGISTRARS);
  const input = VisitInput.parse(raw);
  return once(ctx, 'registration.visit', input, async () => {
    const day = await openDay(ctx);
    if (!day || (expectedBusinessDayId && day.id !== expectedBusinessDayId)) return fail('INVALID_TRANSITION');
    const person = (await ctx.tx.query('SELECT id,patient_no FROM patients WHERE clinic_id=$1 AND id=$2 FOR SHARE', [ctx.clinicId, input.patientId])).rows[0];
    if (!person) return fail('NOT_FOUND');
    const wanted = [...new Set(input.points.map(p => p.queuePointId))];
    if (wanted.length !== input.points.length) return fail('INVALID_INPUT');
    // Lock counters in a fixed order so two visits routed to the same points never deadlock.
    const routes = [...input.points].sort((a, b) => a.queuePointId.localeCompare(b.queuePointId));
    const points = new Map<string, PointRow>();
    for (const route of routes) {
      const point = (await ctx.tx.query(`SELECT q.* FROM queue_points q LEFT JOIN memberships m ON m.clinic_id=q.clinic_id AND m.user_id=q.user_id
        WHERE q.clinic_id=$1 AND q.id=$2 AND q.is_active AND (q.kind<>'doctor' OR m.status='active') FOR SHARE OF q`, [ctx.clinicId, route.queuePointId])).rows[0] as PointRow | undefined;
      if (!point) return fail('NOT_FOUND');
      if (new Set(route.serviceIds).size !== route.serviceIds.length) return fail('INVALID_INPUT');
      for (const serviceId of route.serviceIds) {
        const ok = (await ctx.tx.query(`SELECT 1 FROM services s WHERE s.clinic_id=$1 AND s.id=$2 AND s.is_active AND (
            ($3='doctor' AND EXISTS (SELECT 1 FROM doctor_services d WHERE d.clinic_id=s.clinic_id AND d.user_id=$4 AND d.service_id=s.id))
         OR ($3='service' AND s.group_id=$5) OR ($3='department' AND s.department_id=$6 AND s.kind IN ('consultation','procedure','diagnostic','lab')))`,
          [ctx.clinicId, serviceId, point.kind, point.user_id, point.service_group_id, point.department_id])).rowCount;
        if (!ok) return fail('NOT_FOUND');
      }
      points.set(point.id, point);
    }
    const at: Date = (await ctx.tx.query('SELECT now() at')).rows[0].at;
    const visitId = randomUUID();
    await ctx.tx.query('INSERT INTO visits(id,clinic_id,patient_id,business_day_id,type,created_by) VALUES($1,$2,$3,$4,$5,$6)',
      [visitId, ctx.clinicId, person.id, day.id, input.type, ctx.actorId]);
    const tickets: TicketView[] = []; let charges = 0;
    for (const route of routes) {
      const point = points.get(route.queuePointId)!;
      const number = await nextQueueNumber(ctx.tx, ctx.clinicId, day.id, point.id), ticketId = randomUUID();
      await ctx.tx.query('INSERT INTO queue_tickets(id,clinic_id,business_day_id,visit_id,queue_point_id,number) VALUES($1,$2,$3,$4,$5,$6)',
        [ticketId, ctx.clinicId, day.id, visitId, point.id, number]);
      for (const serviceId of route.serviceIds) {
        const price = await priceAt(ctx.tx, ctx.clinicId, serviceId, at);
        if (!price) return fail('INVALID_TRANSITION'); // Never charge an unpriced service as zero.
        await ctx.tx.query(`INSERT INTO charge_lines(id,clinic_id,visit_id,service_id,performer_user_id,queue_ticket_id,quantity,unit_price_uzs,status,source,created_by)
          VALUES($1,$2,$3,$4,$5,$6,1,$7,'ordered','registration',$8)`,
          [randomUUID(), ctx.clinicId, visitId, serviceId, point.kind === 'doctor' ? point.user_id : null, ticketId, price.priceUzs.toString(), ctx.actorId]);
        charges++;
      }
      if (point.kind === 'doctor')
        // Task 022: the grant belongs to this visit; re-routing an earlier patient moves it here and renews it.
        await ctx.tx.query(`INSERT INTO patient_assignments(clinic_id,patient_id,user_id,visit_id) VALUES($1,$2,$3,$4)
          ON CONFLICT (clinic_id,patient_id,user_id) DO UPDATE SET visit_id=EXCLUDED.visit_id, granted_at=now()`, [ctx.clinicId, person.id, point.user_id, visitId]);
      tickets.push({ id: ticketId, queuePointId: point.id, number, status: 'waiting', names: names(point) });
    }
    await withAudit(ctx.tx, ctx, 'registration.visit_created', visitId, { tickets: tickets.length, charges, businessDayId: day.id });
    return { visitId, patientId: person.id, patientNo: person.patient_no as number, businessDate: day.business_date, tickets };
  });
}

// ---------------------------------------------------------------------------------------------
// Queue board (doctor UI arrives in C6; the API is here)
// ---------------------------------------------------------------------------------------------

const TICKET_SELECT = `SELECT t.id,t.number,t.status,t.queue_point_id,t.called_at,t.started_at,t.completed_at,t.visit_id,
    q.name_uz_cyrl,q.name_uz_latn,q.name_ru,p.id patient_id,p.patient_no,p.full_name,p.birth_date,p.gender
  FROM queue_tickets t JOIN queue_points q ON q.clinic_id=t.clinic_id AND q.id=t.queue_point_id
  JOIN business_days d ON d.clinic_id=t.clinic_id AND d.id=t.business_day_id AND d.status='open'
  JOIN visits v ON v.clinic_id=t.clinic_id AND v.id=t.visit_id JOIN patients p ON p.clinic_id=v.clinic_id AND p.id=v.patient_id`;
/** A doctor sees a ticket only at their own point and only while the patient is still assigned to them. */
const OWN = `q.kind='doctor' AND q.user_id=$2 AND patient_access_active(p.clinic_id, p.id, $2)`;
const ticketView = (r: any) => ({ id: r.id, number: r.number, status: r.status, queuePointId: r.queue_point_id, names: names(r), visitId: r.visit_id,
  calledAt: r.called_at, startedAt: r.started_at, completedAt: r.completed_at,
  patient: { id: r.patient_id, patientNo: r.patient_no, fullName: r.full_name, birthDate: r.birth_date, gender: r.gender } });
const manager = (ctx: ClinicContext) => ctx.roles.some(r => QUEUE_MANAGERS.includes(r));

/** Today's tickets at the caller's own doctor queue points, in number order. */
export async function myQueue(ctx: ClinicContext) {
  ctx = await authorize(ctx, ['doctor']);
  const rows = (await ctx.tx.query(`${TICKET_SELECT} WHERE t.clinic_id=$1 AND ${OWN} ORDER BY q.name_uz_cyrl,t.number`, [ctx.clinicId, ctx.actorId])).rows;
  return rows.map(ticketView);
}

/**
 * Calls the lowest-numbered waiting ticket at the caller's point (or a given point for managers). Returns { ticket: null } when nobody waits.
 * One patient at a time (task 010): while a ticket at the same doctor (or non-doctor point) is called or in progress, that ticket is
 * returned with alreadyActive: true instead of calling another. A lock per doctor serializes two devices, or a manager and the
 * doctor, pressing "call next" together with different idempotency keys.
 */
export async function callNext(ctx: ClinicContext, raw: z.input<typeof CallNextInput>) {
  ctx = await authorize(ctx, QUEUE_ROLES);
  const input = CallNextInput.parse(raw);
  return once(ctx, 'queue.call_next', input, async () => {
    const forPoint = !!input.queuePointId && manager(ctx);
    const scope = forPoint ? '$2::uuid IS NOT NULL AND q.id=$3' : `${OWN} AND ($3::uuid IS NULL OR q.id=$3)`;
    if (input.queuePointId && !manager(ctx)
      && !(await ctx.tx.query("SELECT 1 FROM queue_points WHERE clinic_id=$1 AND id=$2 AND kind='doctor' AND user_id=$3", [ctx.clinicId, input.queuePointId, ctx.actorId])).rowCount)
      return fail('NOT_FOUND');
    const point = forPoint ? (await ctx.tx.query('SELECT kind, user_id FROM queue_points WHERE clinic_id=$1 AND id=$2', [ctx.clinicId, input.queuePointId])).rows[0] : null;
    if (forPoint && !point) return fail('NOT_FOUND');
    const lock = !forPoint ? `doctor:${ctx.actorId}` : point.kind === 'doctor' ? `doctor:${point.user_id}` : `point:${input.queuePointId}`;
    await ctx.tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`queue.call:${ctx.clinicId}:${lock}`]);
    // A doctor point's active ticket counts across all of that doctor's points; a non-doctor point counts only itself.
    const [activeScope, activeParam] = forPoint && point.kind !== 'doctor' ? ['q.id=$2', input.queuePointId] : [`q.kind='doctor' AND q.user_id=$2`, forPoint ? point.user_id : ctx.actorId];
    const active = (await ctx.tx.query(`${TICKET_SELECT} WHERE t.clinic_id=$1 AND t.status IN ('called','in_progress') AND ${activeScope}
      ORDER BY t.called_at NULLS LAST, t.number LIMIT 1`, [ctx.clinicId, activeParam])).rows[0];
    if (active) {
      // Task 019: the doctor's active ticket is shown only while its patient is still assigned to them.
      // A revoked assignment still holds the one-patient-at-a-time slot but discloses nothing.
      if (!forPoint && !await assigned(ctx, active.patient_id)) return { ticket: null, alreadyActive: true };
      return { ticket: ticketView(active), alreadyActive: true };
    }
    const next = (await ctx.tx.query(`${TICKET_SELECT} WHERE t.clinic_id=$1 AND t.status='waiting' AND ${scope}
      ORDER BY t.number, t.id LIMIT 1 FOR UPDATE OF t SKIP LOCKED`, [ctx.clinicId, ctx.actorId, input.queuePointId ?? null])).rows[0];
    if (!next) return { ticket: null, alreadyActive: false };
    await ctx.tx.query("UPDATE queue_tickets SET status='called',called_at=now() WHERE clinic_id=$1 AND id=$2", [ctx.clinicId, next.id]);
    await withAudit(ctx.tx, ctx, 'queue.ticket_called', next.id, { number: next.number });
    return { ticket: ticketView((await ctx.tx.query(`${TICKET_SELECT} WHERE t.clinic_id=$1 AND t.id=$2`, [ctx.clinicId, next.id])).rows[0]), alreadyActive: false };
  }, async stored => {
    // A replayed answer goes through the same rule as a fresh one: a doctor whose assignment was revoked gets no patient details.
    if (!stored.ticket || manager(ctx) || await assigned(ctx, stored.ticket.patient.id)) return stored;
    return { ticket: null, alreadyActive: stored.alreadyActive };
  });
}
async function assigned(ctx: ClinicContext, patientId: string): Promise<boolean> {
  return !!(await ctx.tx.query('SELECT 1 WHERE patient_access_active($1,$2,$3)', [ctx.clinicId, patientId, ctx.actorId])).rowCount;
}

/**
 * Moves a ticket along the queue status machine (contracts/db/queue.ts, enforced again by trigger):
 * called -> waiting is a missed call, waiting|called -> in_progress starts the consultation.
 * Only tickets of the open business day can change, so a ticket never carries over to another day.
 */
export async function setTicketStatus(ctx: ClinicContext, ticketId: string, raw: z.input<typeof TicketStatusInput>) {
  ctx = await authorize(ctx, QUEUE_ROLES);
  const input = TicketStatusInput.parse(raw);
  return once(ctx, `queue.status:${ticketId}`, input, async () => {
    const row = (await ctx.tx.query(`${TICKET_SELECT} WHERE t.clinic_id=$1 AND t.id=$3 AND (${manager(ctx) ? '$2::uuid IS NOT NULL' : OWN}) FOR UPDATE OF t`,
      [ctx.clinicId, ctx.actorId, ticketId])).rows[0];
    if (!row) return fail('NOT_FOUND');
    if (!QUEUE_TRANSITIONS[row.status as keyof typeof QUEUE_TRANSITIONS].includes(input.status)) return fail('INVALID_TRANSITION');
    await ctx.tx.query(`UPDATE queue_tickets SET status=$3,
        called_at=CASE WHEN $3='called' THEN now() ELSE called_at END,
        started_at=CASE WHEN $3='in_progress' THEN coalesce(started_at,now()) ELSE started_at END,
        completed_at=CASE WHEN $3 IN ('completed','cancelled') THEN now() ELSE completed_at END
      WHERE clinic_id=$1 AND id=$2`, [ctx.clinicId, ticketId, input.status]);
    await withAudit(ctx.tx, ctx, 'queue.ticket_status', ticketId, { from: row.status, to: input.status });
    return ticketView((await ctx.tx.query(`${TICKET_SELECT} WHERE t.clinic_id=$1 AND t.id=$2`, [ctx.clinicId, ticketId])).rows[0]);
  });
}
