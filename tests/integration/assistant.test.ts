import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { makePool, migrate } from '../../src/server/database.js';
import { provisionOwner } from '../../src/server/provision.js';
import { httpFixture, patientInput, encounterInput, key, TEST_BOT } from './fixture.js';
import { simulatedExtractor, simulatedStt, type AssistantProviders, type NoteExtractor, type SpeechToText, type TelegramVoice } from '../../src/modules/assistant/providers.js';
import { drainJobs } from '../../src/modules/assistant/service.js';
import { BOT_TEXT, botText } from '../../src/modules/telegram/messages.js';
import { setAssistantProviders } from '../../src/modules/assistant/runtime.js';
import { registeredRoutes } from '../../src/server/routes/index.js';
import { isAssistantPath } from '../../src/server/assistant.js';

type Fixture = Awaited<ReturnType<typeof httpFixture>>;
type Client = ReturnType<Fixture['client']>;
const fakeVoice = (): TelegramVoice => ({ async downloadVoice() { return { data: Buffer.concat([Buffer.from('OggS'), Buffer.alloc(64, 1)]), mimeType: 'audio/ogg' }; } });
function providers(over: Partial<AssistantProviders> = {}): AssistantProviders {
  return { stt: simulatedStt(), extractor: simulatedExtractor(), telegram: fakeVoice(), ...over };
}
async function signIn(f: Fixture, identifier: string, password: string): Promise<Client> {
  const client = f.client();
  assert.equal((await client.request('/api/auth/login', { identifier, password })).status, 200);
  let me = await (await client.request('/api/auth/me')).json();
  const wrap = (csrf: string): Client => Object.assign(Object.create(client), {
    request: (path: string, body?: unknown, extra: Record<string, string> = {}) => client.request(path, body, { 'X-CSRF-Token': csrf, ...extra }) });
  if (me.mustChangePassword) {
    assert.equal((await wrap(me.csrf).request('/api/auth/password', { currentPassword: password, newPassword: 'Changed-' + randomUUID() })).status, 200);
    me = await (await client.request('/api/auth/me')).json();
  }
  return wrap(me.csrf);
}
async function setup(over: Partial<AssistantProviders> = {}) {
  const f = await httpFixture();
  const p = providers(over); setAssistantProviders(p);
  const owner = await signIn(f, 'owner@example.test', f.password);
  const C = f.owner.clinicId;
  const doctor = async (login: string) => {
    const r = await owner.request(`/api/clinics/${C}/staff`, { fullName: 'Синтетик Шифокор ' + login, login, phone: null, roles: ['doctor'] });
    assert.equal(r.status, 201); const s = await r.json();
    return { client: await signIn(f, login, s.temporaryPassword), userId: s.staff.userId as string, login };
  };
  const A = await doctor('doctor.a'), B = await doctor('doctor.b');
  const visit = async (c: Client) => {
    const pr = await c.request(`/api/clinics/${C}/patients`, patientInput, { 'Idempotency-Key': key() }); assert.equal(pr.status, 201);
    const patient = await pr.json();
    const er = await c.request(`/api/clinics/${C}/patients/${patient.id}/encounters`, encounterInput, { 'Idempotency-Key': key() }); assert.equal(er.status, 201);
    const enc = await er.json();
    return { patientId: patient.id as string, encounterId: enc.encounter.id as string, base: `/api/clinics/${C}/assistant/patients/${patient.id}/encounters/${enc.encounter.id}` };
  };
  return { f, p, owner, C, A, B, visit, A1: await visit(A.client), B1: await visit(B.client) };
}
const view = async (c: Client, base: string) => { const r = await c.request(base); assert.equal(r.status, 200); return r.json(); };
const revisions = (v: { fields: { key: string; fieldRevision: number }[] }) => Object.fromEntries(v.fields.map(x => [x.key, x.fieldRevision]));
const docVersions = async (f: Fixture, encounterId: string) =>
  Number((await f.pool.query('SELECT count(*) n FROM document_versions v JOIN documents d ON d.id=v.document_id WHERE d.encounter_id=$1', [encounterId])).rows[0].n);

test('simulated capture drafts grounded proposals; review field by field; approval writes one immutable version', async t => {
  const s = await setup(); t.after(() => s.f.close());
  const { A, B, A1, f } = s;
  const cap = await A.client.request(A1.base + '/simulated-capture', { clientKey: key() });
  assert.equal(cap.status, 201); await drainJobs();
  let v = await view(A.client, A1.base);
  assert.equal(v.transcripts.length, 1); assert.equal(v.transcripts[0].simulated, true);
  const segIds = new Set(v.segments.map((x: { id: string }) => x.id));
  const proposed = v.fields.filter((x: { status: string }) => x.status === 'proposed');
  assert.ok(proposed.length >= 6, 'most GP fields proposed from the demo transcript');
  for (const p of proposed) assert.ok(p.evidence.length && p.evidence.every((id: string) => segIds.has(id)), `${p.key} cites this encounter's segments`);
  assert.deepEqual(v.fields.find((x: { key: string }) => x.key === 'diagnosis').value.icd10, 'J02.9');
  assert.deepEqual(v.fields.find((x: { key: string }) => x.key === 'labOrders').value, ['LAB-CBC', 'LAB-CRP']);
  assert.equal(await docVersions(f, A1.encounterId), 0, 'unapproved proposals change nothing in the record');

  // Approval is blocked while any proposal is untouched.
  assert.equal((await A.client.request(A1.base + '/approve', { expectedDraftRevision: v.draft.revision, expectedDocumentRevision: v.documentRevision, fieldRevisions: revisions(v) })).status, 409);
  // Doctor edits complaints, clears HPI, accepts the rest.
  const act = async (field: string, body: Record<string, unknown>) => {
    const cur = v.fields.find((x: { key: string }) => x.key === field);
    const r = await A.client.request(`${A1.base}/fields/${field}`, { expectedFieldRevision: cur.fieldRevision, ...body });
    assert.equal(r.status, 200, field); return r.json();
  };
  await act('complaints', { action: 'edit', value: 'Бош оғриғи, томоқ оғриғи, қуруқ йўтал, 3 кун (шифокор таҳрири).', category: 'reported' });
  await act('hpi', { action: 'clear' });
  for (const x of v.fields.filter((y: { key: string; status: string }) => y.status === 'proposed' && !['complaints', 'hpi'].includes(y.key))) await act(x.key, { action: 'accept', proposalId: null });
  // A stale field revision is rejected.
  assert.equal((await A.client.request(`${A1.base}/fields/plan`, { action: 'clear', expectedFieldRevision: 0 })).status, 409);

  // A later recording re-runs extraction; the doctor's edit survives and the new proposal is held.
  assert.equal((await A.client.request(A1.base + '/simulated-capture', { clientKey: key() })).status, 201); await drainJobs();
  v = await view(A.client, A1.base);
  const complaints = v.fields.find((x: { key: string }) => x.key === 'complaints');
  assert.equal(complaints.status, 'edited'); assert.match(complaints.value, /шифокор таҳрири/);
  assert.ok(complaints.held, 'new proposal is offered, not applied');
  assert.equal(v.fields.find((x: { key: string }) => x.key === 'hpi').status, 'cleared');

  const stale = await A.client.request(A1.base + '/approve', { expectedDraftRevision: v.draft.revision - 1, expectedDocumentRevision: v.documentRevision, fieldRevisions: revisions(v) });
  assert.equal(stale.status, 409, 'approving a stale draft revision is rejected');
  const wrongField = await A.client.request(A1.base + '/approve', { expectedDraftRevision: v.draft.revision, expectedDocumentRevision: v.documentRevision, fieldRevisions: { ...revisions(v), plan: 1 } });
  assert.equal(wrongField.status, 409, 'approving unseen field versions is rejected');
  assert.equal((await B.client.request(A1.base + '/approve', { expectedDraftRevision: v.draft.revision, expectedDocumentRevision: v.documentRevision, fieldRevisions: revisions(v) })).status, 404, 'doctor B cannot approve A\'s patient');
  const ok = await A.client.request(A1.base + '/approve', { expectedDraftRevision: v.draft.revision, expectedDocumentRevision: v.documentRevision, fieldRevisions: revisions(v) });
  assert.equal(ok.status, 200); const approved = await ok.json();
  const again = await A.client.request(A1.base + '/approve', { expectedDraftRevision: v.draft.revision, expectedDocumentRevision: v.documentRevision, fieldRevisions: revisions(v) });
  assert.deepEqual(await again.json(), approved, 'a retried approval returns the same version');
  assert.equal(await docVersions(f, A1.encounterId), 1);
  const stored = (await f.pool.query('SELECT data FROM document_versions WHERE id=$1', [approved.versionId])).rows[0].data;
  assert.equal(stored.templateId, 'gp-assistant-v1');
  assert.ok(stored.fields.every((x: { status: string; editedBy: string }) => x.status === 'clinician_confirmed' && x.editedBy === A.userId));
  assert.equal(stored.fields.some((x: { key: string }) => x.key === 'gp.hpi'), false, 'a cleared field stays empty');
  const fv = (await f.pool.query('SELECT field_versions FROM assistant_approvals WHERE version_id=$1', [approved.versionId])).rows[0].field_versions;
  assert.equal(fv.complaints.revision, revisions(v).complaints, 'approval references the exact field versions');
  await assert.rejects(f.pool.query('UPDATE document_versions SET data=data WHERE id=$1', [approved.versionId]));
  await assert.rejects(f.pool.query('DELETE FROM assistant_approvals'));

  // After approval: no edits, and late extraction changes nothing.
  const after = await view(A.client, A1.base);
  assert.equal((await A.client.request(`${A1.base}/fields/plan`, { action: 'clear', expectedFieldRevision: revisions(after).plan })).status, 409);
  assert.equal((await A.client.request(A1.base + '/simulated-capture', { clientKey: key() })).status, 201); await drainJobs();
  assert.equal(await docVersions(f, A1.encounterId), 1);
  assert.equal((await view(A.client, A1.base)).lastRun.errorCode, 'DRAFT_APPROVED');

  const pdf = await A.client.request(A1.base + '/approved.pdf');
  assert.equal(pdf.status, 200); assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  assert.equal((await B.client.request(A1.base + '/approved.pdf')).status, 404);
  assert.equal((await B.client.request(A1.base)).status, 404, 'doctor B cannot read doctor A\'s patient draft');
});

test('approval carries forward manual notebook fields and rx.lines, and a manual save in between is rejected as stale (task 019)', async t => {
  const s = await setup(); t.after(() => s.f.close());
  const { A, A1, C, f } = s;
  assert.equal((await A.client.request(A1.base + '/simulated-capture', { clientKey: key() })).status, 201); await drainJobs();
  let v = await view(A.client, A1.base);
  assert.equal(v.documentRevision, 0);
  for (const x of v.fields.filter((y: { status: string }) => y.status === 'proposed'))
    assert.equal((await A.client.request(`${A1.base}/fields/${x.key}`, { action: 'accept', proposalId: null, expectedFieldRevision: x.fieldRevision })).status, 200);
  v = await view(A.client, A1.base);
  // Meanwhile the doctor saves the visit note by hand (task-002 notebook route).
  const note = { reported: 'Қўлда ёзилган шикоят (синтетик).', observed: '', assessment: 'Қўлда баҳо.', plan: '' };
  const saved = await A.client.request(`/api/clinics/${C}/patients/${A1.patientId}/encounters/${A1.encounterId}/draft`,
    { expectedRevision: 0, note, templateId: 'clinora-visit-v1' }, { 'Idempotency-Key': key() });
  assert.equal(saved.status, 200);
  const stale = await A.client.request(A1.base + '/approve', { expectedDraftRevision: v.draft.revision, expectedDocumentRevision: v.documentRevision, fieldRevisions: revisions(v) });
  assert.equal(stale.status, 409, 'approval made against the note before the manual save is stale');
  assert.equal((await stale.json()).error.code, 'STALE_VERSION');
  assert.equal(await docVersions(f, A1.encounterId), 1, 'nothing written by the stale approval');
  // A prescription saved in the doctor workspace (task 010 writes rx.lines next to the note fields).
  const doc = (await f.pool.query('SELECT id, current_version_id FROM documents WHERE encounter_id=$1', [A1.encounterId])).rows[0];
  const prev = (await f.pool.query('SELECT data FROM document_versions WHERE id=$1', [doc.current_version_id])).rows[0].data;
  const rx = JSON.stringify([{ medicine: 'Парацетамол', dose: '500 мг', frequency: 'кунига 3 марта', duration: '3 кун', notes: '' }]);
  const v2 = { ...prev, id: randomUUID(), revision: 2, parentVersionId: prev.id, fields: [...prev.fields.map((x: Record<string, unknown>) => ({ ...x, revision: 2 })),
    { key: 'rx.lines', value: rx, category: 'clinician_instruction', status: 'proposed', origin: 'clinician', revision: 2, evidence: [], editedBy: A.userId, unresolvedConflict: null }] };
  await f.pool.query('INSERT INTO document_versions(id,document_id,clinic_id,patient_id,revision,created_by,data) VALUES($1,$2,$3,$4,2,$5,$6)', [v2.id, doc.id, C, A1.patientId, A.userId, v2]);
  await f.pool.query('UPDATE documents SET current_revision=2,current_version_id=$1 WHERE id=$2', [v2.id, doc.id]);

  v = await view(A.client, A1.base);
  assert.equal(v.documentRevision, 2);
  const ok = await A.client.request(A1.base + '/approve', { expectedDraftRevision: v.draft.revision, expectedDocumentRevision: v.documentRevision, fieldRevisions: revisions(v) });
  assert.equal(ok.status, 200);
  const approved = await ok.json();
  assert.equal(approved.revision, 3);
  const stored = (await f.pool.query('SELECT data FROM document_versions WHERE id=$1', [approved.versionId])).rows[0].data;
  const byKey = new Map(stored.fields.map((x: { key: string }) => [x.key, x]));
  assert.equal((byKey.get('reported') as { value: string }).value, note.reported, 'manual note survives approval');
  assert.equal((byKey.get('assessment') as { value: string }).value, note.assessment);
  assert.equal((byKey.get('rx.lines') as { value: string }).value, rx, 'prescription survives approval');
  assert.ok(byKey.has('gp.complaints') && byKey.has('gp.diagnosis'), 'assistant fields are in the same version');
  assert.equal(stored.parentVersionId, v2.id);
  assert.ok(stored.fields.every((x: { status: string }) => x.status === 'clinician_confirmed'));
});

test('browser chunk upload: retries are idempotent, gaps rejected, one transcript per capture', async t => {
  const s = await setup(); t.after(() => s.f.close());
  const { A, B, A1, C, f } = s;
  const clientKey = key();
  const c1 = await (await A.client.request(A1.base + '/captures', { clientKey, mimeType: 'audio/webm;codecs=opus' })).json();
  const c2 = await (await A.client.request(A1.base + '/captures', { clientKey, mimeType: 'audio/webm;codecs=opus' })).json();
  assert.equal(c1.id, c2.id, 'create retry returns the same capture');
  const chunk = async (client: Client, seq: number, data: Buffer, sum = createHash('sha256').update(data).digest('hex')) =>
    fetch(f.config.origin + `/api/clinics/${C}/assistant/captures/${c1.id}/chunks/${seq}`, {
      method: 'POST', body: new Uint8Array(data), headers: { 'Content-Type': 'audio/webm', 'X-Chunk-Sha256': sum, Origin: f.config.origin, Cookie: (client as unknown as { cookie: string }).cookie, 'X-CSRF-Token': await csrf(client) } });
  const csrf = async (client: Client) => (await (await client.request('/api/auth/me')).json()).csrf;
  const a = Buffer.from('chunk-zero-synthetic'), b = Buffer.from('chunk-one-synthetic'), d = Buffer.from('chunk-three');
  assert.equal((await chunk(A.client, 0, a)).status, 200);
  const dup = await chunk(A.client, 0, a); assert.equal(dup.status, 200); assert.equal((await dup.json()).duplicate, true);
  assert.equal((await chunk(A.client, 0, b)).status, 409, 'a different body for the same chunk conflicts');
  assert.equal((await chunk(A.client, 1, b, 'f'.repeat(64))).status, 422, 'checksum mismatch rejected');
  assert.equal((await chunk(B.client, 1, b)).status, 404, 'doctor B cannot upload into A\'s capture');
  assert.equal((await chunk(A.client, 1, b)).status, 200);
  assert.equal((await chunk(A.client, 3, d)).status, 200);
  const fin = (n: number) => A.client.request(`/api/clinics/${C}/assistant/captures/${c1.id}/finish`, { chunkCount: n });
  assert.equal((await fin(3)).status, 409, 'a gap (missing chunk 2) is reported, not transcribed');
  assert.equal((await chunk(A.client, 2, d)).status, 200);
  assert.equal((await fin(4)).status, 202);
  assert.equal((await fin(4)).status, 202, 'finish retry');
  await drainJobs();
  const status = await (await A.client.request(`/api/clinics/${C}/assistant/captures/${c1.id}`)).json();
  assert.equal(status.status, 'done');
  assert.equal(Number((await f.pool.query('SELECT count(*) n FROM assistant_transcripts WHERE capture_id=$1', [c1.id])).rows[0].n), 1);
  assert.equal((await chunk(A.client, 4, d)).status, 409, 'no chunks after finish');
});

test('provider failure leaves a usable manual note; extraction failure keeps the transcript', async t => {
  const s = await setup({ stt: simulatedStt(true) }); t.after(() => s.f.close());
  const { A, A1, f, p } = s;
  const cap = await (await A.client.request(A1.base + '/simulated-capture', { clientKey: key() })).json(); await drainJobs();
  const failed = await (await A.client.request(`/api/clinics/${s.C}/assistant/captures/${cap.id}`)).json();
  assert.equal(failed.status, 'failed'); assert.equal(failed.errorCode, 'PROVIDER_UNAVAILABLE');
  let v = await view(A.client, A1.base);
  for (const [field, value, category] of [['complaints', 'Бош оғриғи', 'reported'], ['examination', null, 'not_examined'], ['diagnosis', { icd10: 'R51', text: 'Бош оғриғи' }, 'assessment'], ['labOrders', ['LAB-CBC'], 'clinician_instruction']] as const) {
    const r = await A.client.request(`${A1.base}/fields/${field}`, { action: 'edit', expectedFieldRevision: 0, value, category }); assert.equal(r.status, 200, field);
  }
  assert.equal((await A.client.request(`${A1.base}/fields/examination`, { action: 'edit', expectedFieldRevision: 1, value: 'норма', category: 'not_examined' })).status, 422, 'not examined cannot carry a finding');
  assert.equal((await A.client.request(`${A1.base}/fields/labOrders`, { action: 'edit', expectedFieldRevision: 1, value: ['LAB-NOPE'], category: 'clinician_instruction' })).status, 422);
  v = await view(A.client, A1.base);
  const ok = await A.client.request(A1.base + '/approve', { expectedDraftRevision: v.draft.revision, expectedDocumentRevision: v.documentRevision, fieldRevisions: revisions(v) });
  assert.equal(ok.status, 200, 'manual note approves without any provider');
  const data = (await f.pool.query('SELECT data FROM document_versions WHERE id=$1', [(await ok.json()).versionId])).rows[0].data;
  assert.ok(data.fields.some((x: { key: string; value: unknown }) => x.key === 'gp.examination.notExamined' && x.value === true));
  assert.ok(data.fields.some((x: { key: string; value: unknown }) => x.key === 'gp.examination' && x.value === null), 'not examined is not turned into a normal finding');

  // Extraction failure: transcript stored, no proposals, clear status.
  p.stt = simulatedStt(); p.extractor = simulatedExtractor(true);
  const B2 = await s.visit(A.client);
  await A.client.request(B2.base + '/simulated-capture', { clientKey: key() }); await drainJobs();
  const v2 = await view(A.client, B2.base);
  assert.equal(v2.transcripts.length, 1); assert.equal(v2.captures[0].errorCode, 'EXTRACTION_FAILED');
  assert.ok(v2.fields.every((x: { status: string }) => x.status === 'empty'));
});

test('proposals citing another encounter\'s segments or asserting unsupported normal findings are rejected', async t => {
  const s = await setup(); t.after(() => s.f.close());
  const { A, B, A1, B1, f, p } = s;
  await B.client.request(B1.base + '/simulated-capture', { clientKey: key() }); await drainJobs();
  const foreign = (await f.pool.query('SELECT id FROM assistant_segments WHERE encounter_id=$1 LIMIT 1', [B1.encounterId])).rows[0].id;
  const hostile: NoteExtractor = { name: 'hostile-test', model: null, simulated: true, async extract({ segments }) {
    const own = segments[1]!.id, doctor = segments.find(x => x.speaker === 'doctor')!.id;
    return { proposals: [
      { field: 'complaints', value: 'Чужие данные', category: 'reported', evidence: [foreign] },
      { field: 'examination', value: 'Норма, патологии нет', category: 'observed', evidence: [doctor] },
      { field: 'diagnosis', value: { icd10: 'I10', text: 'Гипертония' }, category: 'assessment', evidence: [own] },
      { field: 'hpi', value: 'Уч кун', category: 'reported', evidence: [own] },
      { field: 'role', value: 'ceo', category: 'reported', evidence: [own] }
    ] };
  } };
  p.extractor = hostile;
  await A.client.request(A1.base + '/simulated-capture', { clientKey: key() }); await drainJobs();
  const v = await view(A.client, A1.base);
  assert.equal(v.fields.find((x: { key: string }) => x.key === 'complaints').status, 'empty', 'foreign citation rejected');
  assert.equal(v.fields.find((x: { key: string }) => x.key === 'examination').status, 'empty', 'unsupported normal rejected');
  assert.equal(v.fields.find((x: { key: string }) => x.key === 'diagnosis').status, 'empty', 'patient words alone do not make a diagnosis');
  assert.equal(v.fields.find((x: { key: string }) => x.key === 'hpi').status, 'proposed');
  const reasons = (await f.pool.query("SELECT field_key,reject_reason FROM assistant_proposals WHERE disposition='rejected' ORDER BY field_key")).rows.map(r => `${r.field_key}:${r.reject_reason}`);
  assert.deepEqual(reasons, ['complaints:foreign_evidence', 'diagnosis:patient_only_evidence', 'examination:unsupported_normal', 'role:unknown_field']);
});

// Task 015: voice notes reach the assistant only through task 004's clinic bot, its single webhook and its links.
test('Telegram: one webhook and one link; deduplicated voice, confirmed attach, blocked or unlinked staff rejected, no patient data in bot messages', async t => {
  const s = await setup(); t.after(() => s.f.close());
  const { A, B, A1, B1, C, f, owner } = s;
  let updateId = 0;
  const hook = (body: unknown, secret = TEST_BOT.webhookSecret) => fetch(f.config.origin + '/api/telegram/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify(body) });
  const tg = 777001, from = { id: tg, first_name: 'Synthetic', is_bot: false }, chat = { id: tg, type: 'private' };
  const voice = (update: number, message: number) => hook({ update_id: update, message: { message_id: message, date: 1, chat, from, voice: { file_id: 'synthetic-file-' + message, duration: 20 } } });
  const sent = () => f.telegramApi.calls.filter(c => c.method === 'sendMessage').map(c => c.payload as { chat_id: number; text: string });
  const last = () => sent().at(-1)!.text;
  const captures = async () => Number((await f.pool.query("SELECT count(*) n FROM assistant_captures WHERE source='telegram'")).rows[0].n);
  const notice = (key: keyof typeof BOT_TEXT['uz-Cyrl']) => botText('uz-Cyrl', key);

  assert.equal((await hook({ update_id: 1 }, 'wrong-secret-wrong-secret-wrong-secret')).status, 401);
  assert.equal(Number((await f.pool.query('SELECT count(*) n FROM telegram_updates')).rows[0].n), 0, 'forged webhook does nothing');
  const oldHook = await fetch(f.config.origin + '/api/assistant/telegram/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': TEST_BOT.webhookSecret }, body: JSON.stringify({ update_id: 2 }) });
  assert.notEqual(oldHook.status, 200, 'the 003C webhook is gone');
  assert.equal((await A.client.request(`/api/clinics/${C}/assistant/telegram/link-code`, {})).status, 404, 'the 003C linking routes are gone');
  const tables = (await f.pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_name LIKE '%telegram%' ORDER BY 1")).rows.map(r => r.table_name);
  assert.deepEqual(tables, ['telegram_init_data_uses', 'telegram_invites', 'telegram_links', 'telegram_updates'], 'one link table and one update log');

  assert.equal((await voice(10, 100)).status, 200);
  assert.equal(last(), notice('notLinked'), 'unlinked Telegram user gets the standard notice');
  assert.equal(await captures(), 0, 'nothing stored for an unlinked sender');

  // Task 004's invite: the owner invites doctor A, A confirms in Telegram.
  const inv = await (await owner.request(`/api/clinics/${C}/staff/${A.userId}/telegram-invite`, {})).json() as { link: string };
  const token = inv.link.split('start=')[1]!;
  await hook({ update_id: ++updateId + 10, message: { message_id: 101, date: 1, chat, from, text: '/start ' + token } });
  await hook({ update_id: ++updateId + 10, callback_query: { id: 'cb1', data: 'link:' + token, from, message: { message_id: 102, date: 1, chat } } });
  assert.equal(last(), notice('linked'));
  const cfg = await (await A.client.request(`/api/clinics/${C}/assistant/config`)).json();
  assert.deepEqual(cfg.telegram, { available: true, linked: true }, 'panel sees the 004 link');
  assert.deepEqual((await (await B.client.request(`/api/clinics/${C}/assistant/config`)).json()).telegram, { available: true, linked: false });

  const before = sent().length;
  assert.equal((await voice(20, 200)).status, 200);
  assert.equal(last(), notice('voiceReceived'));
  assert.equal((await voice(20, 200)).status, 200, 'redelivered update');
  assert.equal((await voice(21, 200)).status, 200, 'same message, new update id');
  assert.equal(sent().length, before + 1, 'one reply for repeated deliveries');
  const pending = await (await A.client.request(`/api/clinics/${C}/assistant/captures/pending`)).json();
  assert.equal(pending.length, 1, 'one capture for repeated updates');
  assert.deepEqual(await (await B.client.request(`/api/clinics/${C}/assistant/captures/pending`)).json(), []);
  const capId = pending[0].id, attach = (c: Client, target: { patientId: string; encounterId: string }) =>
    c.request(`/api/clinics/${C}/assistant/captures/${capId}/attach`, { patientId: target.patientId, encounterId: target.encounterId });
  assert.equal((await attach(B.client, B1)).status, 404, 'B cannot attach A\'s voice message');
  assert.equal((await attach(A.client, B1)).status, 404, 'A cannot attach audio to B\'s patient');
  assert.equal((await attach(A.client, A1)).status, 200);
  assert.equal((await attach(A.client, A1)).status, 200, 'attach retry');
  const A2 = await s.visit(A.client);
  assert.equal((await attach(A.client, A2)).status, 409, 'no second attachment');
  await drainJobs();
  assert.equal(Number((await f.pool.query('SELECT count(*) n FROM assistant_transcripts WHERE capture_id=$1', [capId])).rows[0].n), 1);
  assert.equal((await view(A.client, A1.base)).transcripts.length, 1);

  // Too long: refused before anything is stored.
  await hook({ update_id: 40, message: { message_id: 400, date: 1, chat, from, voice: { file_id: 'synthetic-long', duration: 16 * 60 } } });
  assert.equal(last(), notice('voiceTooLong'));
  // A linked member without the doctor role is told the assistant is for doctors.
  await f.pool.query("DELETE FROM membership_roles WHERE user_id=$1 AND role='doctor'", [A.userId]);
  await voice(41, 401);
  assert.equal(last(), notice('voiceNotDoctor'));
  await f.pool.query("INSERT INTO membership_roles(clinic_id,user_id,role,granted_by) VALUES($1,$2,'doctor',$3)", [C, A.userId, f.owner.userId]);
  // Blocking the staff member cuts voice capture at once, through the same link.
  assert.equal((await owner.request(`/api/clinics/${C}/staff/${A.userId}/status`, { status: 'blocked' })).status, 200);
  await voice(42, 402);
  assert.equal(last(), notice('notLinked'), 'blocked staff get the standard notice');
  assert.equal((await owner.request(`/api/clinics/${C}/staff/${A.userId}/status`, { status: 'active' })).status, 200);
  await voice(43, 403);
  assert.equal(last(), notice('voiceReceived'), 'unblocked staff are accepted again');
  // Unlinking through task 004 ends it too.
  assert.equal((await owner.request(`/api/clinics/${C}/staff/${A.userId}/telegram-unlink`, {})).status, 200);
  await voice(44, 404);
  assert.equal(last(), notice('notLinked'));
  assert.equal(await captures(), 2, 'only accepted voice notes were stored');

  const patient = (await f.pool.query('SELECT display_name,id FROM patients WHERE id=$1', [A1.patientId])).rows[0];
  const fixed = Object.values(BOT_TEXT).flatMap(Object.values);
  for (const m of sent()) {
    assert.ok(fixed.includes(m.text) || m.text.startsWith(notice('confirmQuestion').slice(0, 4)), 'bot text is a fixed notice');
    const raw = JSON.stringify(m);
    for (const forbidden of [patient.display_name, patient.id, A1.encounterId, 'Fictional']) assert.equal(raw.includes(forbidden), false);
  }
});

test('migration 019 moves confirmed 003C links into task 004 links without overriding them, then drops the 003C tables', async t => {
  const url = process.env.TEST_DATABASE_URL!;
  const schema = 'clinora_test_' + randomUUID().replaceAll('-', '');
  const admin = makePool(url); await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = makePool(url, schema);
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); });
  // Bring the schema to the state before task 015, recording each file so migrate() later applies only 019 onwards.
  await pool.query('CREATE TABLE schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
  for (const name of (await readdir('db/migrations')).filter(n => /^\d+.*\.sql$/.test(n) && n < '019').sort()) {
    const sql = await readFile('db/migrations/' + name, 'utf8');
    await pool.query(sql);
    await pool.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)', [name, createHash('sha256').update(sql).digest('hex')]);
  }
  const owner = await provisionOwner(pool, { email: 'owner@example.test', password: 'Synthetic-' + randomUUID(), name: 'Synthetic Owner', clinic: 'Synthetic Clinic', clinicalAccess: true });
  const C = owner.clinicId;
  const person = async (login: string, status = 'active') => {
    const id = randomUUID();
    await pool.query("INSERT INTO accounts(id,login,display_name,password_hash,status,managed_by_clinic_id) VALUES($1,$2,$3,'x',$4,$5)", [id, login, 'Синтетик ' + login, status, C]);
    await pool.query("INSERT INTO memberships(id,clinic_id,user_id,status,granted_by) VALUES($1,$2,$3,'active',$4)", [randomUUID(), C, id, owner.userId]);
    return id;
  };
  const [moved, pendingOnly, has004, tgTaken, blocked] = [await person('moved'), await person('pending'), await person('has004'), await person('taken'), await person('blocked', 'blocked')];
  const link003 = async (user: string, tgId: number, status: string) => {
    const code = randomUUID();
    await pool.query("INSERT INTO assistant_telegram_link_codes(id,clinic_id,user_id,code_hash,expires_at) VALUES($1,$2,$3,$4,now())", [code, C, user, createHash('sha256').update(code).digest('hex')]);
    await pool.query('INSERT INTO assistant_telegram_links(id,clinic_id,user_id,telegram_user_id,telegram_chat_id,code_id,status,confirmed_at) VALUES($1,$2,$3,$4,$4,$5,$6,$7)',
      [randomUUID(), C, user, tgId, code, status, status === 'active' ? new Date() : null]);
  };
  await pool.query('INSERT INTO telegram_links(account_id,telegram_user_id,clinic_id) VALUES($1,1001,$3),($2,1004,$3)', [has004, owner.userId, C]);
  await link003(moved, 2001, 'active');
  await link003(pendingOnly, 2002, 'pending');
  await link003(has004, 2003, 'active');     // account already linked through 004: 004 wins
  await link003(tgTaken, 1004, 'active');    // Telegram user already linked to another account: 004 wins
  await link003(blocked, 2005, 'active');    // blocked account: not carried over
  await pool.query('INSERT INTO assistant_telegram_updates(update_id) VALUES(1)');
  await migrate(pool);
  const links = Object.fromEntries((await pool.query('SELECT account_id,telegram_user_id FROM telegram_links')).rows.map(r => [r.account_id, Number(r.telegram_user_id)]));
  assert.deepEqual(links, { [has004]: 1001, [owner.userId]: 1004, [moved]: 2001 });
  const left = (await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_name LIKE 'assistant_telegram%'", [schema])).rows;
  assert.deepEqual(left, [], '003C link, code and update tables dropped');
  assert.ok(pendingOnly && tgTaken && blocked);
});

test('revocation or discard while the provider runs publishes nothing', async t => {
  const s = await setup(); t.after(() => s.f.close());
  const { A, A1, f, p } = s;
  let onTranscribe: () => Promise<void> = async () => {};
  const stt: SpeechToText = { name: 'hook', simulated: true, async transcribe(i) { await onTranscribe(); return simulatedStt().transcribe(i); } };
  p.stt = stt;
  onTranscribe = async () => { await f.pool.query('DELETE FROM patient_assignments WHERE user_id=$1', [A.userId]); };
  const c1 = await (await A.client.request(A1.base + '/simulated-capture', { clientKey: key() })).json(); await drainJobs();
  assert.equal((await f.pool.query('SELECT status,error_code FROM assistant_captures WHERE id=$1', [c1.id])).rows[0].error_code, 'FORBIDDEN');
  assert.equal(Number((await f.pool.query('SELECT count(*) n FROM assistant_transcripts')).rows[0].n), 0);

  const A2 = await s.visit(A.client);
  let captureId = '';
  onTranscribe = async () => { await f.pool.query("UPDATE assistant_captures SET status='discarded', lease_token=NULL WHERE id=$1", [captureId]); };
  captureId = (await (await A.client.request(A2.base + '/simulated-capture', { clientKey: key() })).json()).id; await drainJobs();
  assert.equal((await f.pool.query('SELECT status FROM assistant_captures WHERE id=$1', [captureId])).rows[0].status, 'discarded');
  assert.equal(Number((await f.pool.query('SELECT count(*) n FROM assistant_transcripts WHERE capture_id=$1', [captureId])).rows[0].n), 0, 'late completion after discard is dropped');
});

test('assistant routes: unauthenticated 401, non-doctor 403, other clinic 404, CSRF enforced', async t => {
  const s = await setup(); t.after(() => s.f.close());
  const { f, owner, C, A1 } = s;
  const r = await owner.request(`/api/clinics/${C}/staff`, { fullName: 'Синтетик Кассир', login: 'cashier.x', phone: null, roles: ['cashier'] });
  const cashier = await signIn(f, 'cashier.x', (await r.json()).temporaryPassword);
  const anon = f.client();
  assert.equal((await anon.request(A1.base)).status, 401);
  assert.equal((await cashier.request(A1.base)).status, 403);
  assert.equal((await cashier.request(`/api/clinics/${C}/assistant/config`)).status, 403);
  const otherOwner = await signIn(f, 'other@example.test', f.password);
  assert.equal((await otherOwner.request(A1.base)).status, 404);
  const noCsrf = await fetch(f.config.origin + A1.base + '/simulated-capture', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: f.config.origin, Cookie: (s.A.client as unknown as { cookie: string }).cookie }, body: JSON.stringify({ clientKey: key() }) });
  assert.equal(noCsrf.status, 403);
  // JSON routes sit on the shared registry; transport routes (upload, PDF, approve, job start) on the assistant handler. Both enforce the doctor role.
  const assistantRoutes = registeredRoutes().filter(r => r.feature === 'assistant');
  assert.ok(assistantRoutes.length >= 13 && assistantRoutes.every(r => r.roles.join() === 'doctor'));
  assert.equal(isAssistantPath(`/api/clinics/${C}/assistant/config`, 'GET'), false);
  assert.equal(isAssistantPath(`${A1.base}/approve`, 'POST'), true);
  assert.equal((await cashier.request(`${A1.base}/approve`, { expectedDraftRevision: 0, expectedDocumentRevision: 0, fieldRevisions: {} })).status, 403);
  assert.equal((await cashier.request(`${A1.base}/approved.pdf`)).status, 403);
  assert.equal((await anon.request(`${A1.base}/approved.pdf`)).status, 401);
});
