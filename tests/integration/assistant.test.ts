import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { httpFixture, patientInput, encounterInput, key } from './fixture.js';
import { simulatedExtractor, simulatedStt, type AssistantProviders, type NoteExtractor, type SpeechToText, type TelegramBot } from '../../src/modules/assistant/providers.js';
import { BOT_TEXT, drainJobs } from '../../src/modules/assistant/service.js';

type Fixture = Awaited<ReturnType<typeof httpFixture>>;
type Client = ReturnType<Fixture['client']>;
const SECRET = 'synthetic-webhook-secret-0123456789';

function fakeBot() {
  const sent: { chatId: number; text: string; button?: { text: string; url: string } }[] = [];
  const bot: TelegramBot = { username: 'clinora_synthetic_bot',
    async sendMessage(chatId, text, button) { sent.push({ chatId, text, ...(button ? { button } : {}) }); },
    async downloadVoice() { return { data: Buffer.concat([Buffer.from('OggS'), Buffer.alloc(64, 1)]), mimeType: 'audio/ogg' }; } };
  return { bot, sent };
}
function providers(over: Partial<AssistantProviders> = {}): AssistantProviders {
  return { stt: simulatedStt(), extractor: simulatedExtractor(), telegram: fakeBot().bot, webhookSecret: SECRET, ...over };
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
  const p = providers(over); (f.config as Record<string, unknown>).assistant = p;
  const owner = await signIn(f, 'owner@example.test', f.password);
  const C = f.owner.clinicId;
  const doctor = async (login: string) => {
    const r = await owner.request(`/api/clinics/${C}/staff`, { fullName: 'Синтетик Шифокор ' + login, login, phone: null, roles: ['doctor'] });
    assert.equal(r.status, 201); const s = await r.json();
    return { client: await signIn(f, login, s.temporaryPassword), userId: s.staff.userId as string };
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
  assert.equal((await A.client.request(A1.base + '/approve', { expectedDraftRevision: v.draft.revision, fieldRevisions: revisions(v) })).status, 409);
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

  const stale = await A.client.request(A1.base + '/approve', { expectedDraftRevision: v.draft.revision - 1, fieldRevisions: revisions(v) });
  assert.equal(stale.status, 409, 'approving a stale draft revision is rejected');
  const wrongField = await A.client.request(A1.base + '/approve', { expectedDraftRevision: v.draft.revision, fieldRevisions: { ...revisions(v), plan: 1 } });
  assert.equal(wrongField.status, 409, 'approving unseen field versions is rejected');
  assert.equal((await B.client.request(A1.base + '/approve', { expectedDraftRevision: v.draft.revision, fieldRevisions: revisions(v) })).status, 404, 'doctor B cannot approve A\'s patient');
  const ok = await A.client.request(A1.base + '/approve', { expectedDraftRevision: v.draft.revision, fieldRevisions: revisions(v) });
  assert.equal(ok.status, 200); const approved = await ok.json();
  const again = await A.client.request(A1.base + '/approve', { expectedDraftRevision: v.draft.revision, fieldRevisions: revisions(v) });
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
  const ok = await A.client.request(A1.base + '/approve', { expectedDraftRevision: v.draft.revision, fieldRevisions: revisions(v) });
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

test('Telegram: secret-checked webhook, confirmed linking, deduplicated voice, confirmed attach, no patient data in bot messages', async t => {
  const { bot, sent } = fakeBot();
  const s = await setup({ telegram: bot }); t.after(() => s.f.close());
  const { A, B, A1, B1, C, f } = s;
  const hook = (body: unknown, secret = SECRET) => fetch(f.config.origin + '/api/assistant/telegram/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify(body) });
  assert.equal((await hook({ update_id: 1 }, 'wrong-secret-wrong-secret-wrong')).status, 401);
  assert.equal(Number((await f.pool.query('SELECT count(*) n FROM assistant_telegram_updates')).rows[0].n), 0, 'forged webhook does nothing');
  const from = { id: 777001, first_name: 'Synthetic' }, chat = { id: 777001, type: 'private' };
  const voice = (update: number, message: number) => hook({ update_id: update, message: { message_id: message, chat, from, voice: { file_id: 'synthetic-file-' + message, duration: 20 } } });

  assert.equal((await voice(10, 100)).status, 200);
  assert.equal(sent.at(-1)!.text, BOT_TEXT.notLinked, 'unlinked Telegram user gets no access');
  const link = await (await A.client.request(`/api/clinics/${C}/assistant/telegram/link-code`, {})).json();
  const code = new URL(link.link).searchParams.get('start')!;
  assert.equal((await hook({ update_id: 11, message: { message_id: 101, chat, from, text: '/start ' + code } })).status, 200);
  assert.equal((await (await A.client.request(`/api/clinics/${C}/assistant/telegram/link`)).json()).status, 'pending', 'link waits for confirmation in the app');
  // The same code cannot link a second Telegram identity.
  await hook({ update_id: 12, message: { message_id: 1, chat: { id: 888, type: 'private' }, from: { id: 888 }, text: '/start ' + code } });
  assert.equal(sent.at(-1)!.text, BOT_TEXT.linkInvalid);
  assert.equal((await B.client.request(`/api/clinics/${C}/assistant/telegram/link/confirm`, {})).status, 409, 'B cannot confirm A\'s link');
  assert.equal((await A.client.request(`/api/clinics/${C}/assistant/telegram/link/confirm`, {})).status, 200);

  assert.equal((await voice(20, 200)).status, 200);
  assert.equal((await voice(20, 200)).status, 200, 'redelivered update');
  assert.equal((await voice(21, 200)).status, 200, 'same message, new update id');
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

  const patient = (await f.pool.query('SELECT display_name,id FROM patients WHERE id=$1', [A1.patientId])).rows[0];
  for (const m of sent) {
    assert.ok(Object.values(BOT_TEXT).includes(m.text as never), 'bot text is a fixed notice');
    const raw = JSON.stringify(m);
    for (const forbidden of [patient.display_name, patient.id, A1.encounterId, 'Fictional']) assert.equal(raw.includes(forbidden), false);
  }
  // Blocking the doctor's role stops new voice captures.
  await f.pool.query("DELETE FROM membership_roles WHERE user_id=$1 AND role='doctor'", [A.userId]);
  await voice(30, 300);
  assert.equal(sent.at(-1)!.text, BOT_TEXT.notLinked);
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
  assert.equal((await cashier.request(`/api/clinics/${C}/assistant/telegram/link-code`, {})).status, 403);
  const otherOwner = await signIn(f, 'other@example.test', f.password);
  assert.equal((await otherOwner.request(A1.base)).status, 404);
  const noCsrf = await fetch(f.config.origin + A1.base + '/simulated-capture', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: f.config.origin, Cookie: (s.A.client as unknown as { cookie: string }).cookie }, body: JSON.stringify({ clientKey: key() }) });
  assert.equal(noCsrf.status, 403);
});
