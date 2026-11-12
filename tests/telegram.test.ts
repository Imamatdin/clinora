import test from 'node:test';
import assert from 'node:assert/strict';
import { NOTICE_TEMPLATES, notifyStaff, renderNotice, type NoticeTemplate } from '../src/modules/telegram/notify.js';
import { BOT_LOCALES, BOT_TEXT } from '../src/modules/telegram/messages.js';
import { signInitData, verifyInitData } from '../src/modules/telegram/init-data.js';
import { recordingTelegramApi, telegramConfigFromEnv } from '../src/modules/telegram/api.js';
import { webhookSecretMatches } from '../src/modules/telegram/webhook.js';
import { weakPin } from '../src/modules/devices/actions.js';

const TOKEN = '123456789:TEST_synthetic_bot_token_not_real_000000';
const APP = 'https://clinic.example.test/';
// Field names and values that must never reach a Telegram message.
const FORBIDDEN_KEYS = /patient|name|full_?name|diagnos|result|phone|birth|address|mrn|note|test|amount|price/i;
const SAMPLE_PATIENT = ['Алиев Валижон', 'Aliyev Valijon', '+998901234567', 'Гипертония', 'гемоглобин 92', 'I10'];

test('notice templates accept only small integers, never patient fields', () => {
  for (const [id, template] of Object.entries(NOTICE_TEMPLATES)) {
    const shape = (template.params as unknown as { shape: Record<string, unknown> }).shape;
    for (const key of Object.keys(shape)) assert.doesNotMatch(key, FORBIDDEN_KEYS, `${id}.${key}`);
    for (const extra of [{ patientName: 'Алиев Валижон' }, { diagnosis: 'I10' }, { result: 'positive' }, { phone: '+998901234567' }])
      assert.throws(() => renderNotice(id as NoticeTemplate, extra as never, 'uz-Cyrl', APP), `${id} accepts ${Object.keys(extra)[0]}`);
    assert.throws(() => renderNotice(id as NoticeTemplate, { count: 'Алиев Валижон' } as never, 'uz-Cyrl', APP), `${id} accepts text in a parameter`);
  }
});

test('every rendered notice is fixed text plus one button into the app, in all three languages', () => {
  for (const id of Object.keys(NOTICE_TEMPLATES) as NoticeTemplate[]) for (const locale of BOT_LOCALES) {
    const params = (id==='day.closed'?{collected:'15000000',refunds:'50000',cashOuts:'20000'}:'count' in (NOTICE_TEMPLATES[id].params as unknown as { shape: object }).shape ? { count: 7 } : {}) as never;
    const message = renderNotice(id, params, locale, APP);
    assert.deepEqual(Object.keys(message).sort(), ['reply_markup', 'text']);
    assert.ok(message.text.length > 10 && !/\{\w+\}/.test(message.text), `${id}/${locale} filled`);
    const serialized = JSON.stringify(message);
    for (const value of SAMPLE_PATIENT) assert.ok(!serialized.includes(value));
    assert.deepEqual(message.reply_markup.inline_keyboard.flat().map(b => b.web_app.url), [APP]);
  }
});

test('notifyStaff refuses forbidden parameters before any lookup or send', async () => {
  const api = recordingTelegramApi();
  const pool = { query: async () => { throw new Error('must not query'); } } as never;
  await assert.rejects(notifyStaff(pool, { botToken: TOKEN, webhookSecret: 'x'.repeat(32), botUsername: 'clinora_bot', api }, APP,
    { clinicId: '00000000-0000-4000-8000-000000000000', to: { role: 'doctor' }, template: 'queue.new_patient', params: { patientName: 'Алиев' } as never }));
  assert.equal(api.calls.length, 0);
});

test('bot text exists for every key in all three languages', () => {
  const keys = Object.keys(BOT_TEXT['uz-Cyrl']).sort();
  for (const locale of BOT_LOCALES) {
    assert.deepEqual(Object.keys(BOT_TEXT[locale]).sort(), keys, locale);
    for (const value of Object.values(BOT_TEXT[locale])) assert.ok(value.trim().length > 0);
  }
});

test('init data verification: exact algorithm, freshness window, malformed input', () => {
  const t0 = 1_800_000_000;
  const fields = { auth_date: String(t0), query_id: 'AAHdF6IQAAAAAN0XohDhrOrc', user: JSON.stringify({ id: 279058397, first_name: 'Vladislav', language_code: 'ru' }) };
  const raw = signInitData(fields, TOKEN);
  const ok = verifyInitData(raw, TOKEN, t0 + 3599);
  assert.ok(ok.ok); assert.equal(ok.ok && ok.value.telegramUserId, 279058397);
  assert.deepEqual(verifyInitData(raw, TOKEN, t0 + 3601), { ok: false, reason: 'expired' });
  assert.deepEqual(verifyInitData(raw, TOKEN, t0 - 120), { ok: false, reason: 'future' });
  assert.deepEqual(verifyInitData(raw, TOKEN.replace('TEST', 'TOST'), t0), { ok: false, reason: 'bad_hash' });
  // Field order in the query string does not matter; the check string is sorted.
  const reordered = new URLSearchParams([...new URLSearchParams(raw)].reverse()).toString();
  assert.ok(verifyInitData(reordered, TOKEN, t0).ok);
  // Task 019: the replay fingerprint is canonical, so a reordered or re-encoded copy is the same init data.
  const fp = (s: string) => { const r = verifyInitData(s, TOKEN, t0); assert.ok(r.ok); return r.ok ? r.value.fingerprint : ''; };
  const reencoded = raw.split('&').map(pair => pair.replace(/%7B/g, '%7b').replace(/%22/g, '%22')).join('&').replace('auth_date=', 'auth%5Fdate=');
  assert.equal(fp(reordered), fp(raw));
  assert.equal(fp(reencoded), fp(raw));
  assert.notEqual(fp(signInitData({ ...fields, query_id: 'other' }, TOKEN)), fp(raw));
  for (const bad of ['', 'hash=zz', 'auth_date=1&hash=' + 'a'.repeat(64), raw + '&hash=' + 'b'.repeat(64), 'x'.repeat(9000)])
    assert.equal(verifyInitData(bad, TOKEN, t0).ok, false);
  const noUser = signInitData({ auth_date: String(t0) }, TOKEN);
  assert.deepEqual(verifyInitData(noUser, TOKEN, t0), { ok: false, reason: 'no_user' });
});

test('webhook secret compare and Telegram environment validation', () => {
  assert.equal(webhookSecretMatches('a'.repeat(40), 'a'.repeat(40)), true);
  for (const given of [undefined, '', 'a'.repeat(39), ['a'.repeat(40)]]) assert.equal(webhookSecretMatches(given, 'a'.repeat(40)), false);
  assert.equal(telegramConfigFromEnv({}), undefined);
  const env = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: 's'.repeat(32), TELEGRAM_BOT_USERNAME: 'clinora_clinic_bot' };
  assert.equal(telegramConfigFromEnv(env)?.botUsername, 'clinora_clinic_bot');
  assert.throws(() => telegramConfigFromEnv({ ...env, TELEGRAM_WEBHOOK_SECRET: 'short' }));
  assert.throws(() => telegramConfigFromEnv({ ...env, TELEGRAM_BOT_TOKEN: 'not-a-token' }));
  assert.throws(() => telegramConfigFromEnv({ TELEGRAM_BOT_TOKEN: TOKEN }), 'partial configuration fails startup');
});

test('weak PINs are recognised', () => {
  for (const pin of ['0000', '1111', '1234', '4321', '123456', '987654', '0123']) assert.equal(weakPin(pin), true, pin);
  for (const pin of ['2580', '1397', '204060', '1243', '9870']) assert.equal(weakPin(pin), false, pin);
});
