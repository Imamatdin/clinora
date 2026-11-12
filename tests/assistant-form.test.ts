import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { validateProposals, parseValue, displayValue, type SegmentRef } from '../src/modules/assistant/form.js';
import { aishaStt, geminiExtractor, simulatedExtractor, DEMO_TRANSCRIPT, extractionPrompt, providersFromEnv, ProviderError } from '../src/modules/assistant/providers.js';
import { assistantDictionaries } from '../src/web/assistant/i18n.js';

const seg = (speaker: SegmentRef['speaker'], text: string): SegmentRef => ({ id: randomUUID(), speaker, text });
const patient = seg('patient', 'Икки кундан бери йўтал'), doctor = seg('doctor', 'Ўпкада хириллаш йўқ, босим 120 га 80'), normal = seg('doctor', 'Томоқ норма');
const map = new Map([patient, doctor, normal].map(s => [s.id, s]));

test('validation rejects invented, foreign, malformed and ungrounded proposals', () => {
  const r = validateProposals({ proposals: [
    { field: 'complaints', value: 'Йўтал', category: 'reported', evidence: [patient.id] },
    { field: 'hpi', value: 'x', category: 'reported', evidence: [randomUUID()] },
    { field: 'pastHistory', value: 'x', category: 'history', evidence: [] },
    { field: 'examination', value: 'Норма', category: 'observed', evidence: [doctor.id] },
    { field: 'plan', value: 'Режим', category: 'clinician_instruction', evidence: [patient.id] },
    { field: 'labOrders', value: ['LAB-XYZ'], category: 'clinician_instruction', evidence: [doctor.id] },
    { field: 'diagnosis', value: { icd10: 'bad', text: 'x' }, category: 'assessment', evidence: [doctor.id] },
    { field: 'followUp', value: '2026-02-30', category: 'clinician_instruction', evidence: [doctor.id] },
    { field: 'complaints', value: 'again', category: 'reported', evidence: [patient.id] },
    { field: 'examination', value: null, category: 'observed', evidence: [doctor.id] },
    'garbage'
  ] }, map);
  assert.deepEqual(r.accepted.map(a => a.field), ['complaints']);
  assert.deepEqual(r.rejected.map(x => x.reason), ['foreign_evidence', 'missing_evidence', 'unsupported_normal', 'patient_only_evidence', 'unknown_lab', 'invalid_value', 'invalid_value', 'duplicate_field', 'empty_value', 'malformed_proposal']);
  assert.equal(validateProposals('not json', map).malformed, true);
  assert.equal(validateProposals({ proposals: [{ field: 'examination', value: 'Томоқ норма', category: 'observed', evidence: [normal.id] }] }, map).accepted.length, 1, 'a normal finding the doctor said is allowed');
});

test('not examined stays empty and categories stay distinct', () => {
  assert.deepEqual(parseValue('examination', null, 'not_examined'), { ok: true, value: null });
  assert.equal(parseValue('examination', 'норма', 'not_examined').ok, false);
  assert.equal(parseValue('complaints', 'x', 'observed').ok, false, 'complaints are reported, never observed');
  assert.equal(parseValue('diagnosis', { icd10: 'J06.9', text: 'ОРВИ' }, 'assessment').ok, true);
  assert.equal(displayValue('labOrders', ['LAB-CBC'], 'ru'), 'Общий анализ крови');
});

test('simulated extractor proposals are grounded in the demo transcript', async () => {
  const segments = DEMO_TRANSCRIPT.map(s => ({ id: randomUUID(), text: s.text, speaker: s.speaker }));
  const raw = await simulatedExtractor().extract({ segments, today: '2026-11-19' });
  const r = validateProposals(raw, new Map(segments.map(s => [s.id, s])));
  assert.deepEqual(r.rejected, []);
  assert.deepEqual(r.accepted.map(a => a.field).sort(), ['complaints', 'diagnosis', 'examination', 'followUp', 'hpi', 'labOrders', 'pastHistory', 'plan']);
  assert.equal(r.accepted.find(a => a.field === 'followUp')!.value, '2026-11-24');
  assert.match(extractionPrompt(segments, '2026-11-19'), /untrusted data/);
});

test('Aisha adapter sends multipart audio with the key header and parses offsets or plain text', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  let seen: { url: string; headers: Record<string, string>; form: FormData } | null = null;
  globalThis.fetch = (async (url: string, init: RequestInit) => { seen = { url, headers: init.headers as Record<string, string>, form: init.body as FormData };
    return new Response(JSON.stringify({ transcript: 'Бошим оғрияпти. Температура 38.' }), { status: 200 }); }) as typeof fetch;
  const out = await aishaStt('synthetic-key').transcribe({ audio: Buffer.from('OggS'), mimeType: 'audio/ogg' });
  assert.equal(seen!.url, 'https://back.aisha.group/api/v1/stt/post/');
  assert.equal(seen!.headers['X-Api-Key'], 'synthetic-key');
  assert.ok(seen!.form.get('audio') instanceof Blob); assert.equal(seen!.form.get('language'), 'uz');
  assert.deepEqual(out.segments.map(s => s.text), ['Бошим оғрияпти.', 'Температура 38.']);
  globalThis.fetch = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(aishaStt('k').transcribe({ audio: Buffer.from('x'), mimeType: 'audio/ogg' }), (e: unknown) => e instanceof ProviderError && e.code === 'PROVIDER_REJECTED');
});

test('Gemini adapter uses the express-mode key header and returns the raw JSON for validation', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  let url = '', headers: Record<string, string> = {};
  globalThis.fetch = (async (u: string, init: RequestInit) => { url = u; headers = init.headers as Record<string, string>;
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"proposals":[]}' }] } }] }), { status: 200 }); }) as typeof fetch;
  const raw = await geminiExtractor({ kind: 'api_key', key: 'synthetic' }, 'gemini-2.5-flash').extract({ segments: [], today: '2026-11-19' });
  assert.deepEqual(raw, { proposals: [] });
  assert.match(url, /aiplatform\.googleapis\.com\/v1\/publishers\/google\/models\/gemini-2\.5-flash:generateContent$/);
  assert.equal(headers['x-goog-api-key'], 'synthetic'); assert.equal(url.includes('synthetic'), false, 'key never in the URL');
});

test('environment selects real adapters only with keys; simulation only when asked', () => {
  assert.equal(providersFromEnv({}).stt.name, 'unavailable');
  assert.equal(providersFromEnv({ ASSISTANT_SIMULATION: 'true' }).stt.simulated, true);
  assert.equal(providersFromEnv({ AISHA_API_KEY: 'k', ASSISTANT_SIMULATION: 'true' }).stt.name, 'aisha');
  assert.equal(providersFromEnv({ VERTEX_API_KEY: 'k' }).extractor.name, 'gemini-vertex');
  assert.equal(providersFromEnv({ TELEGRAM_WEBHOOK_SECRET: 'short' }).webhookSecret, null);
});

test('assistant UI dictionaries: same keys in uz-Cyrl, uz-Latn and ru, none empty', () => {
  const [cyrl, latn, ru] = [assistantDictionaries['uz-Cyrl'], assistantDictionaries['uz-Latn'], assistantDictionaries.ru];
  assert.deepEqual(Object.keys(latn).sort(), Object.keys(cyrl).sort());
  assert.deepEqual(Object.keys(ru).sort(), Object.keys(cyrl).sort());
  for (const d of [cyrl, latn, ru]) for (const [k, v] of Object.entries(d)) assert.ok(String(v).trim(), k);
  for (const [k, v] of Object.entries(latn)) assert.doesNotMatch(String(v), /\p{Script=Cyrillic}/u, `uz-Latn ${k} has no Cyrillic`);
});
