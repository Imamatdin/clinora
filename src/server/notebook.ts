import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import type pg from 'pg';
import { DocumentVersion, Encounter, Id, Revision, type Membership, type Principal } from '../contracts/index.js';
import { AcceptInviteInput, DraftInput, EncounterInput, InviteInput, LoginInput, PatientInput, SignupInput, type PatientView, type VisitView } from '../contracts/notebook.js';
import { DomainError, requireClinicalAccess } from '../modules/identity/access.js';
import { transaction, type Tx } from './database.js';
import { digest, dummyHash, passwordHash, passwordMatches, same, token } from './security.js';
import { sortVisits } from '../contracts/timeline.js';
import { PasswordChangeInput } from '../contracts/clinic.js';
import { identifierKind } from '../modules/identity/roles.js';
import { clinicRoute } from './clinic-routes.js';
import type { TelegramConfig } from '../modules/telegram/api.js';
import { createSession, deviceFromRequest, publicAccessRoute, readCookie, sessionAccessRoute, sessionCookie, webhookRoute, type SessionVia } from './access.js';
import { DEVICE_IDLE_MINUTES } from '../modules/devices/actions.js';
import { accountLimitKey, passwordLogin } from '../modules/login/actions.js';
import { clientIp } from './client-ip.js';
import { carriedFields, currentVersion, latestApproval, nextDraftKind } from '../modules/documents/approvals.js';

/** Note fields the notebook editor writes; other fields of the current version are carried into each new version. */
const NOTEBOOK_FIELDS: ReadonlySet<string> = new Set(['reported', 'observed', 'assessment', 'plan']);

const fail = (code: ConstructorParameters<typeof DomainError>[0]): never => { throw new DomainError(code); };
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => { const result = schema.safeParse(value); return result.success ? result.data : fail('INVALID_INPUT'); };
const iso = (value: Date) => value.toISOString();
type Actor = { userId: string; sessionId: string; email: string | null; login: string | null; phone: string | null; name: string; csrf: string; verification: unknown; mustChangePassword: boolean; principal: Principal;
  via: SessionVia; deviceClinicId: string | null; deviceId: string | null; deviceLabel: string | null };
type Access = { actor: Actor; member: Membership; owner: boolean };
export type ApiConfig = { pool: pg.Pool; origin: string; secureCookies: boolean; telegram?: TelegramConfig | undefined; trustProxyHops?: number };
/** A clinic route result (JSON, HTML or file) plus an optional session cookie. */
export type ApiResult = import('./routes/types.js').RouteResult & { cookie?: string | string[] };
const jsonBody = async (req: IncomingMessage): Promise<unknown> => {
  if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') return fail('INVALID_INPUT');
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { size += chunk.length; if (size > 100000) return fail('INVALID_INPUT'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return fail('INVALID_INPUT'); }
};
const audit = (tx: Tx, actor: string, clinic: string | null, action: string, resource: string) =>
  tx.query('INSERT INTO audit_events(id,actor_id,clinic_id,action,resource_id) VALUES($1,$2,$3,$4,$5)', [randomUUID(), actor, clinic, action, resource]);

export async function actorFor(tx: Tx, req: IncomingMessage): Promise<Actor> {
  // No bearer fallback: an explicit unsupported bearer cannot override browser identity.
  if (req.headers.authorization) return fail('UNAUTHENTICATED');
  const raw = readCookie(req, 'clinora_session') ?? '';
  if (!/^[a-f0-9]{64}$/.test(raw)) return fail('UNAUTHENTICATED');
  const deviceRaw = readCookie(req, 'clinora_device');
  // A shared-PC session stays alive only while used: bump it first (row lock, so concurrent
  // requests of one session serialize instead of deadlocking), then require it fresh below.
  await tx.query(`UPDATE sessions SET last_seen_at=now() WHERE token_hash=$1 AND via='device' AND last_seen_at>now()-make_interval(mins => $2)`, [digest(raw), DEVICE_IDLE_MINUTES]);
  const row = (await tx.query(`SELECT s.id,s.user_id,s.expires_at,s.via,a.email,a.login,a.phone,a.must_change_password,a.display_name,a.professional_verification,
      d.clinic_id device_clinic_id, d.id device_id, d.label device_label
    FROM sessions s JOIN accounts a ON a.id=s.user_id LEFT JOIN devices d ON d.id=s.device_id
    WHERE s.token_hash=$1 AND s.expires_at>now() AND a.status='active'
      AND (s.via<>'device' OR (d.revoked_at IS NULL AND d.token_hash=$2 AND s.last_seen_at>now()-make_interval(mins => $3)))
    FOR SHARE OF s,a`, [digest(raw), deviceRaw && /^[a-f0-9]{64}$/.test(deviceRaw) ? digest(deviceRaw) : '', DEVICE_IDLE_MINUTES])).rows[0];
  if (!row) return fail('UNAUTHENTICATED');
  return { userId: row.user_id, sessionId: row.id, email: row.email, login: row.login, phone: row.phone, name: row.display_name, csrf: digest('csrf:' + raw),
    verification: row.professional_verification, mustChangePassword: row.must_change_password,
    principal: { userId: row.user_id, sessionId: row.id, expiresAt: iso(row.expires_at), accountStatus: 'active' },
    via: row.via, deviceId: row.device_id ?? null, deviceClinicId: row.device_clinic_id ?? null, deviceLabel: row.device_label ?? null };
}
async function accessFor(tx: Tx, actor: Actor, clinic: string): Promise<Access> {
  const row = (await tx.query('SELECT * FROM memberships WHERE clinic_id=$1 AND user_id=$2 AND status=\'active\' FOR SHARE', [clinic, actor.userId])).rows[0];
  if (!row) return fail('FORBIDDEN');
  // An owner/admin role does not itself grant clinical access.
  const member: Membership = { id: row.id, userId: actor.userId, clinicId: clinic,
    role: row.clinical_access ? 'clinician' : 'administrator', status: 'active', revision: row.revision,
    grant: { by: row.granted_by, at: iso(row.granted_at) }, patientScope: row.patient_scope === 'clinic' ? { kind: 'clinic' } : {
      kind: 'assigned', patientIds: (await tx.query('SELECT patient_id FROM patient_assignments WHERE clinic_id=$1 AND user_id=$2 FOR SHARE', [clinic, actor.userId])).rows.map(r => r.patient_id)
    } };
  return { actor, member, owner: row.is_owner };
}
function clinical(access: Access, patient: string) {
  requireClinicalAccess(access.actor.principal, access.member, { clinicId: access.member.clinicId, patientId: patient }, new Date());
}
async function allowedPatient(tx: Tx, access: Access, id: string): Promise<PatientView> {
  // Uniform not-found for missing/out-of-scope records; no existence-based response changes.
  try { clinical(access, id); } catch { return fail('NOT_FOUND'); }
  const row = (await tx.query('SELECT * FROM patients WHERE clinic_id=$1 AND id=$2', [access.member.clinicId, id])).rows[0];
  if (!row) return fail('NOT_FOUND');
  return patientView(row);
}
function patientView(row: pg.QueryResultRow): PatientView {
  return { id: row.id, clinicId: row.clinic_id, displayName: row.display_name, mrn: row.mrn, dateOfBirth: row.date_of_birth,
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), revision: row.revision, provenance: row.provenance };
}
async function visits(tx: Tx, clinic: string, patient: string): Promise<VisitView[]> {
  // Approval from either the doctor workspace (note_approvals) or the assistant (assistant_approvals), latest first.
  const rows = (await tx.query(`SELECT e.data,a.display_name,d.id document_id,d.current_revision,d.current_version_id,v.data version,
      ap.id approval_id, ap.version_id approval_version_id, ap.revision approval_revision, ap.approved_at
    FROM encounters e
    JOIN accounts a ON a.id=e.clinician_id JOIN documents d ON d.encounter_id=e.id LEFT JOIN document_versions v ON v.id=d.current_version_id
    LEFT JOIN LATERAL (SELECT id, version_id, revision, approved_at FROM (
        SELECT id, version_id, revision, approved_at FROM note_approvals WHERE document_id=d.id
        UNION ALL SELECT id, version_id, revision, approved_at FROM assistant_approvals WHERE document_id=d.id) x
      ORDER BY revision DESC LIMIT 1) ap ON true
    WHERE e.clinic_id=$1 AND e.patient_id=$2 ORDER BY e.created_at,e.id`, [clinic, patient])).rows;
  const result: VisitView[] = rows.map(r => ({ encounter: r.data, clinicianName: r.display_name, documentId: r.document_id, revision: r.current_revision, version: r.version,
    approval: r.approval_id ? { id: r.approval_id, versionId: r.approval_version_id, revision: r.approval_revision, approvedAt: iso(r.approved_at), current: r.approval_version_id === r.current_version_id } : null }));
  // Known dates descending, date-only explicitly preserved; undated visits last, newest entry first.
  return sortVisits(result);
}
async function allowedReplayDocument(tx: Tx, clinic: string, patient: string, encounter: string, document: string,
  version?: { id: string; revision: number }): Promise<void> {
  // Composite foreign keys bind this document to its real clinic/patient/encounter.
  // Acquire this lock only AFTER the replay-key lock, just like the write path.
  const row = (await tx.query(`SELECT d.id FROM documents d
    WHERE d.clinic_id=$1 AND d.patient_id=$2 AND d.encounter_id=$3 AND d.id=$4
      AND ($5::uuid IS NULL OR EXISTS(SELECT 1 FROM document_versions v
        WHERE v.id=$5 AND v.document_id=d.id AND v.clinic_id=d.clinic_id AND v.patient_id=d.patient_id AND v.revision=$6))
    FOR KEY SHARE OF d`, [clinic, patient, encounter, document, version?.id ?? null, version?.revision ?? null])).rows[0];
  if (!row) return fail('NOT_FOUND');
}
async function idempotent(tx: Tx, access: Access, operation: string, key: unknown, payload: unknown,
  work: () => Promise<unknown>, authorizeReplay: (cached: unknown) => Promise<void>) {
  if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(key)) return fail('INVALID_INPUT');
  const scope = [access.member.clinicId, access.actor.userId, operation, key];
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [scope.join(':')]);
  const hash = digest(JSON.stringify(payload));
  const old = (await tx.query('SELECT payload_hash,response FROM idempotency_records WHERE clinic_id=$1 AND actor_id=$2 AND operation=$3 AND key=$4', scope)).rows[0];
  if (old) {
    // A key identifies a result; it never grants access to that result's resource.
    await authorizeReplay(old.response);
    return old.payload_hash === hash ? old.response : fail('IDEMPOTENCY_CONFLICT');
  }
  const result = await work();
  await tx.query('INSERT INTO idempotency_records(clinic_id,actor_id,operation,key,payload_hash,response) VALUES($1,$2,$3,$4,$5,$6)', [...scope, hash, JSON.stringify(result)]);
  return result;
}
async function throttle(pool: pg.Pool, identity: string, ip: string) {
  // TCP peer, or the proxy-appended X-Forwarded-For entry when TRUST_PROXY_HOPS is set (client-ip.ts).
  await transaction(pool, async tx => {
    for (const [key, limit] of [[digest('ip:' + ip), 40], [digest('id:' + identity), 8]] as const) {
      const row = (await tx.query(`INSERT INTO login_limits(key,attempts,reset_at) VALUES($1,1,now()+interval '15 minutes')
        ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN login_limits.reset_at<now() THEN 1 ELSE login_limits.attempts+1 END,
        reset_at=CASE WHEN login_limits.reset_at<now() THEN now()+interval '15 minutes' ELSE login_limits.reset_at END RETURNING attempts`, [key])).rows[0];
      if (row.attempts > limit) { // Commit the limit update even when rate-limited.
        return false;
      }
    }
    return true;
  }).then(ok => { if (!ok) fail('RATE_LIMITED'); });
}

export async function api(req: IncomingMessage, config: ApiConfig): Promise<ApiResult> {
  const url = new URL(req.url ?? '/', config.origin), path = url.pathname, method = req.method ?? 'GET';
  const mutation = !['GET','HEAD'].includes(method);
  const webhook = await webhookRoute(req, config, path, method, jsonBody);
  if (webhook) return webhook;
  if (mutation && req.headers.origin !== config.origin) return fail('FORBIDDEN');
  const publicAccess = await publicAccessRoute(req, config, path, method, jsonBody);
  if (publicAccess) return publicAccess;
  if (path === '/api/auth/register' && method === 'POST') {
    const input = parse(SignupInput, await jsonBody(req));
    await throttle(config.pool, input.email.toLowerCase(), clientIp(req, config.trustProxyHops));
    const hash = await passwordHash(input.password);
    await config.pool.query('INSERT INTO accounts(id,email,display_name,password_hash) VALUES($1,$2,$3,$4) ON CONFLICT(email) DO NOTHING', [randomUUID(), input.email.toLowerCase(), input.displayName, hash]);
    return { status: 202, body: { message: 'If this address is available, an unprivileged account has been created. Sign in to continue.' } };
  }
  if (path === '/api/auth/login' && method === 'POST') {
    const input = parse(LoginInput, await jsonBody(req));
    const who = identifierKind('identifier' in input ? input.identifier : input.email);
    const account = who ? (await config.pool.query(`SELECT id FROM accounts WHERE ${who.column}=$1`, [who.value])).rows[0] : undefined;
    const key = account ? accountLimitKey(account.id) : digest('password-identifier:' + (who ? `${who.column}:${who.value}` : ('identifier' in input ? input.identifier : input.email).trim().toLowerCase()));
    const raw = await passwordLogin(config.pool, key, clientIp(req, config.trustProxyHops), async tx => {
      // Re-read under the limiter lock: a reset, block or concurrent attempt may have completed while waiting.
      const current = account ? (await tx.query('SELECT * FROM accounts WHERE id=$1', [account.id])).rows[0] : undefined;
      const matches = await passwordMatches(input.password, current?.password_hash ?? dummyHash);
      if (!matches || !current || current.status !== 'active') return { ok: false };
      const device = await deviceFromRequest(tx, req);
      if (device && !(await tx.query("SELECT 1 FROM memberships WHERE clinic_id=$1 AND user_id=$2 AND status='active'", [device.clinicId, current.id])).rows[0]) return { ok: false };
      const via: SessionVia = device ? 'device' : 'password';
      const raw = await createSession(tx, current.id, via, device?.id ?? null);
      return { ok: true, value: { raw, via } };
    });
    return { body: { ok: true }, cookie: sessionCookie(raw.raw, raw.via, config.secureCookies) };
  }
  return transaction(config.pool, async tx => {
    const actor = await actorFor(tx, req);
    if (mutation && !same(String(req.headers['x-csrf-token'] ?? ''), actor.csrf)) return fail('FORBIDDEN');
    if (path === '/api/auth/me' && method === 'GET') {
      // Roles are display hints for navigation only; every route rechecks them in the database.
      const memberships = (await tx.query(`SELECT m.clinic_id id,c.name,m.is_owner "isOwner",m.clinical_access "clinicalAccess",m.patient_scope "patientScope",
          coalesce((SELECT array_agg(r.role ORDER BY r.role) FROM membership_roles r WHERE r.clinic_id=m.clinic_id AND r.user_id=m.user_id),'{}') roles
        FROM memberships m JOIN clinics c ON c.id=m.clinic_id WHERE m.user_id=$1 AND m.status='active' AND ($2::uuid IS NULL OR m.clinic_id=$2) ORDER BY c.name`,
        [actor.userId, actor.deviceClinicId])).rows;
      return { body: { id: actor.userId, name: actor.name, email: actor.email, login: actor.login, phone: actor.phone, csrf: actor.csrf,
        mustChangePassword: actor.mustChangePassword, professionalVerification: actor.verification, clinics: memberships,
        session: { via: actor.via, deviceId: actor.deviceId, deviceLabel: actor.deviceLabel, idleMinutes: actor.via === 'device' ? DEVICE_IDLE_MINUTES : null } } };
    }
    if (path === '/api/auth/logout' && method === 'POST') {
      await tx.query('DELETE FROM sessions WHERE id=$1', [actor.sessionId]);
      return { body: { ok: true }, cookie: `clinora_session=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0${config.secureCookies ? '; Secure' : ''}` };
    }
    if (path === '/api/auth/password' && method === 'POST') {
      await throttle(config.pool, `password:${actor.userId}`, clientIp(req, config.trustProxyHops));
      const input = parse(PasswordChangeInput, await jsonBody(req));
      const account = (await tx.query('SELECT password_hash FROM accounts WHERE id=$1 FOR UPDATE', [actor.userId])).rows[0];
      if (!account || !await passwordMatches(input.currentPassword, account.password_hash)) return fail('FORBIDDEN');
      await tx.query('UPDATE accounts SET password_hash=$2, must_change_password=false WHERE id=$1', [actor.userId, await passwordHash(input.newPassword)]);
      // Other devices signed in with the old password are signed out; this session continues.
      await tx.query('DELETE FROM sessions WHERE user_id=$1 AND id<>$2', [actor.userId, actor.sessionId]);
      await audit(tx, actor.userId, null, 'account.password_changed', actor.userId);
      return { body: { ok: true } };
    }
    // A temporary password only unlocks changing it. Enforced here, not just in the interface.
    if (actor.mustChangePassword) return fail('PASSWORD_CHANGE_REQUIRED');
    // A shared-PC session reaches only the device's own clinic.
    const clinicPart = /^\/api\/clinics\/([^/]+)/.exec(path)?.[1];
    if (actor.deviceClinicId && clinicPart !== undefined && clinicPart !== actor.deviceClinicId) return fail('NOT_FOUND');
    const sessionAccess = await sessionAccessRoute(tx, req, config, actor, path, method, jsonBody);
    if (sessionAccess) return sessionAccess;
    if (path === '/api/invitations/accept' && method === 'POST') {
      const input = parse(AcceptInviteInput, await jsonBody(req));
      const invite = (await tx.query('SELECT * FROM invitations WHERE token_hash=$1 AND email=$2 AND expires_at>now() AND consumed_at IS NULL AND revoked_at IS NULL FOR UPDATE', [digest(input.token), actor.email])).rows[0];
      if (!invite) return fail('FORBIDDEN');
      // A revoked invitation issuer cannot activate pending invitations.
      const issuer = (await tx.query("SELECT id FROM memberships WHERE clinic_id=$1 AND user_id=$2 AND status='active' AND is_owner=true FOR SHARE", [invite.clinic_id, invite.created_by])).rows[0];
      if (!issuer) return fail('FORBIDDEN');
      const prior = (await tx.query('SELECT id FROM memberships WHERE clinic_id=$1 AND user_id=$2', [invite.clinic_id, actor.userId])).rows[0];
      if (prior) return fail('FORBIDDEN'); // Reinstatement of a revoked clinician requires a separate owner workflow.
      await tx.query("INSERT INTO memberships(id,clinic_id,user_id,role,clinical_access,status,granted_by) VALUES($1,$2,$3,'clinician',true,'active',$4)", [randomUUID(), invite.clinic_id, actor.userId, invite.created_by]);
      await tx.query("INSERT INTO membership_roles(clinic_id,user_id,role,granted_by) VALUES($1,$2,'doctor',$3)", [invite.clinic_id, actor.userId, invite.created_by]);
      await tx.query('UPDATE invitations SET consumed_at=now() WHERE id=$1', [invite.id]);
      await audit(tx, actor.userId, invite.clinic_id, 'membership.accepted', invite.id);
      return { body: { ok: true } };
    }
    const parts = path.split('/').filter(Boolean);
    if (parts[0] !== 'api' || parts[1] !== 'clinics' || !Id.safeParse(parts[2]).success) return fail('NOT_FOUND');
    const clinic = parts[2]!;
    // Offline replay is limited to a currently enrolled shared PC, never a phone/password session.
    if (parts.slice(3).join('/') === 'registration/offline' && actor.via !== 'device') return fail('FORBIDDEN');
    const routed = await clinicRoute(tx, actor.userId, clinic, parts.slice(3).join('/'), method, req, jsonBody);
    if (routed) return routed;
    const access = await accessFor(tx, actor, clinic);
    if (parts[3] === 'invitations' && parts.length === 4 && method === 'POST') {
      if (!access.owner) return fail('FORBIDDEN');
      const input = parse(InviteInput, await jsonBody(req)), raw = token();
      await tx.query('INSERT INTO invitations(id,clinic_id,email,token_hash,created_by,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval \'48 hours\')', [randomUUID(), clinic, input.email.toLowerCase(), digest(raw), actor.userId]);
      return { status: 201, body: { link: `${config.origin}/#invite=${raw}`, expiresInHours: 48 } };
    }
    if (parts[3] !== 'patients') return fail('NOT_FOUND');
    if (parts.length === 4 && method === 'GET') {
      if (access.member.role !== 'clinician') return fail('FORBIDDEN');
      const q = url.searchParams.get('q') ?? ''; if (q.length>200) return fail('INVALID_INPUT');
      const rows = (await tx.query(`SELECT p.* FROM patients p WHERE p.clinic_id=$1 AND ($2 OR EXISTS(
        SELECT 1 FROM patient_assignments a WHERE a.clinic_id=p.clinic_id AND a.patient_id=p.id AND a.user_id=$3))
        AND (position(lower($4) in lower(p.display_name))>0 OR position(lower($4) in lower(coalesce(p.mrn,'')))>0)
        ORDER BY p.created_at DESC,p.id LIMIT 100`, [clinic, access.member.patientScope.kind === 'clinic', actor.userId, q])).rows;
      return { body: rows.map(patientView) };
    }
    if (parts.length === 4 && method === 'POST') {
      if (access.member.role !== 'clinician') return fail('FORBIDDEN');
      const input = parse(PatientInput, await jsonBody(req));
      const body = await idempotent(tx, access, 'patient.create', req.headers['idempotency-key'], input, async () => {
        const id = randomUUID();
        const row = (await tx.query('INSERT INTO patients(id,clinic_id,display_name,mrn,date_of_birth,provenance) VALUES($1,$2,$3,$4,$5,$6) RETURNING *', [id, clinic, input.displayName, input.mrn, input.dateOfBirth, { source: 'manual', externalReference: null }])).rows[0];
        await tx.query('INSERT INTO patient_assignments(clinic_id,patient_id,user_id) VALUES($1,$2,$3)', [clinic, id, actor.userId]);
        await audit(tx, actor.userId, clinic, 'patient.created', id);
        return patientView(row);
      }, async cached => {
        const stored = parse(z.object({ id: Id, clinicId: Id }), cached);
        if (stored.clinicId !== clinic) return fail('NOT_FOUND');
        // A simultaneous creator may commit this assignment while this request
        // waits for the same replay key. Read and pin that specific current grant.
        let replayAccess = access;
        if (access.member.patientScope.kind === 'assigned') {
          const rows = (await tx.query('SELECT patient_id FROM patient_assignments WHERE clinic_id=$1 AND patient_id=$2 AND user_id=$3 FOR SHARE',
            [clinic, stored.id, actor.userId])).rows;
          replayAccess = { ...access, member: { ...access.member, patientScope: { kind: 'assigned', patientIds: rows.map(r => r.patient_id) } } };
        }
        await allowedPatient(tx, replayAccess, stored.id);
      });
      return { status: 201, body };
    }
    const patientId = parts[4]; if (!Id.safeParse(patientId).success) return fail('NOT_FOUND');
    const patient = await allowedPatient(tx, access, patientId!);
    if (parts.length === 5 && method === 'GET') return { body: { patient, visits: await visits(tx, clinic, patientId!) } };
    if (parts[5] !== 'encounters') return fail('NOT_FOUND');
    if (parts.length === 6 && method === 'POST') {
      const input = parse(EncounterInput, await jsonBody(req));
      const body = await idempotent(tx, access, `encounter.create:${patientId}`, req.headers['idempotency-key'], input, async () => {
        const id = randomUUID(), documentId = randomUUID(), stamp = new Date().toISOString();
        const encounter = Encounter.parse({ id, patientId, clinicId: clinic, clinicianId: actor.userId, location: { id: null, label: input.location }, specialty: input.specialty,
          occurrence: input.occurrence, status: 'draft', createdAt: stamp, updatedAt: stamp, revision: 1, provenance: { source: 'manual', externalReference: null } });
        await tx.query('INSERT INTO encounters(id,clinic_id,patient_id,clinician_id,data) VALUES($1,$2,$3,$4,$5)', [id, clinic, patientId, actor.userId, encounter]);
        await tx.query('INSERT INTO documents(id,clinic_id,patient_id,encounter_id) VALUES($1,$2,$3,$4)', [documentId, clinic, patientId, id]);
        await audit(tx, actor.userId, clinic, 'encounter.created', id);
        return { encounter, documentId, revision: 0, version: null, clinicianName: actor.name };
      }, async cached => {
        const stored = parse(z.object({ encounter: Encounter, documentId: Id }), cached);
        if (stored.encounter.clinicId !== clinic || stored.encounter.patientId !== patientId) return fail('NOT_FOUND');
        await allowedReplayDocument(tx, clinic, patientId!, stored.encounter.id, stored.documentId);
      });
      return { status: 201, body };
    }
    const encounterId = parts[6]; if (!Id.safeParse(encounterId).success) return fail('NOT_FOUND');
    if (parts.length === 8 && parts[7] === 'draft' && method === 'POST') {
      const input = parse(DraftInput, await jsonBody(req));
      const body = await idempotent(tx, access, `draft.save:${encounterId}`, req.headers['idempotency-key'], input, async () => {
        const doc = (await tx.query('SELECT * FROM documents WHERE clinic_id=$1 AND patient_id=$2 AND encounter_id=$3 FOR UPDATE', [clinic, patientId, encounterId])).rows[0];
        if (!doc) return fail('NOT_FOUND');
        if (doc.current_revision !== input.expectedRevision) return fail('STALE_VERSION');
        // Task 010: an approved note is never silently replaced. After an approval the new version is an
        // explicit amendment naming that approval; fields written by other editors (assistant gp.*, prescription) are kept.
        const approval = await latestApproval(tx, doc.id), current = await currentVersion(tx, doc);
        const kind = nextDraftKind(approval, current, input.amendmentReason);
        const version = DocumentVersion.parse({ id: randomUUID(), documentId: doc.id, encounterId, clinicId: clinic, patientId,
          revision: doc.current_revision+1, parentVersionId: doc.current_version_id, ...kind,
          templateId: input.templateId, fields: [...Object.entries(input.note).map(([key,value]) => ({ key, value: value.trim() || null,
            category: ({reported:'reported',observed:'observed',assessment:'assessment',plan:'clinician_instruction'} as const)[key as keyof typeof input.note],
            status: 'proposed', origin: 'clinician', revision: doc.current_revision+1, evidence: [], editedBy: actor.userId, unresolvedConflict: null })),
            ...carriedFields(current, NOTEBOOK_FIELDS)],
          createdBy: actor.userId, createdAt: new Date().toISOString() });
        await tx.query('INSERT INTO document_versions(id,document_id,clinic_id,patient_id,revision,created_by,data) VALUES($1,$2,$3,$4,$5,$6,$7)', [version.id, doc.id, clinic, patientId, version.revision, actor.userId, version]);
        await tx.query('UPDATE documents SET current_revision=$1,current_version_id=$2 WHERE id=$3', [version.revision, version.id, doc.id]);
        await audit(tx, actor.userId, clinic, 'draft.saved', version.id);
        return { revision: version.revision, version, approval: approval ? { id: approval.id, versionId: approval.versionId, revision: approval.revision, approvedAt: approval.approvedAt, current: false } : null };
      }, async cached => {
        const stored = parse(z.object({ revision: Revision, version: DocumentVersion }), cached);
        if (stored.version.clinicId !== clinic || stored.version.patientId !== patientId ||
          stored.version.encounterId !== encounterId || stored.revision !== stored.version.revision) return fail('NOT_FOUND');
        await allowedReplayDocument(tx, clinic, patientId!, encounterId!, stored.version.documentId,
          { id: stored.version.id, revision: stored.revision });
        // Do not compare the document's CURRENT revision here: a legitimate retry
        // must recover its original snapshot even after newer versions are saved.
      });
      return { body };
    }
    return fail('NOT_FOUND');
  });
}
