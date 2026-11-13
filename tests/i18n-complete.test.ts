import test from 'node:test';
import assert from 'node:assert/strict';
import { UZ_CYRL_PARTS, uzCyrl } from '../src/web/i18n/uz-Cyrl.js';
import { UZ_LATN_PARTS, uzLatn } from '../src/web/i18n/uz-Latn.js';
import { RU_PARTS, ru } from '../src/web/i18n/ru.js';

// Task 017 acceptance: every interface key exists in uz-Cyrl, uz-Latn and ru; a missing key fails here.
const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
// Product names, codes and formats that read the same in every script.
const NEUTRAL = new Set(['app.brand', 'auth.email', 'app.title', 'access.me.telegramTitle']);

test('every feature part ships the same keys and placeholders in all three languages', () => {
  assert.deepEqual(Object.keys(UZ_LATN_PARTS).sort(), Object.keys(UZ_CYRL_PARTS).sort());
  assert.deepEqual(Object.keys(RU_PARTS).sort(), Object.keys(UZ_CYRL_PARTS).sort());
  for (const [part, cyrl] of Object.entries(UZ_CYRL_PARTS) as [keyof typeof UZ_CYRL_PARTS, Record<string, string>][]) {
    const keys = Object.keys(cyrl).sort();
    for (const [locale, dict] of [['uz-Latn', UZ_LATN_PARTS[part]], ['ru', RU_PARTS[part]]] as const) {
      const have = Object.keys(dict).sort();
      assert.deepEqual(keys.filter(k => !have.includes(k)), [], `${locale} ${part}: missing keys`);
      assert.deepEqual(have.filter(k => !keys.includes(k)), [], `${locale} ${part}: extra keys`);
      for (const [key, value] of Object.entries(dict as Record<string, string>)) {
        assert.ok(value.trim().length > 0, `${locale} ${key} empty`);
        assert.deepEqual(vars(value), vars(cyrl[key]!), `${locale} ${key} placeholders`);
      }
    }
  }
  assert.deepEqual(Object.keys(uzLatn).sort(), Object.keys(uzCyrl).sort());
  assert.deepEqual(Object.keys(ru).sort(), Object.keys(uzCyrl).sort());
});

test('Uzbek Latin uses the official alphabet: no Cyrillic, oʻ and gʻ with the turned comma (U+02BB)', () => {
  const wrong: string[] = [];
  for (const [key, value] of Object.entries(uzLatn)) {
    if (/\p{Script=Cyrillic}/u.test(value)) wrong.push(`${key}: Cyrillic letters`);
    // o', o`, o‘, o’ and the same after g are the common wrong forms of oʻ / gʻ.
    if (/[OoGg]['`‘’´]/u.test(value)) wrong.push(`${key}: ${value.match(/[OoGg]['`‘’´]/u)![0]} instead of the turned comma ʻ`);
    // Russian-only letters never appear in the official Uzbek Latin alphabet (written as ts, shch, yo …).
    if (/[ÇçŞşĞğÖöÜü]/u.test(value)) wrong.push(`${key}: Turkish-style letter`);
  }
  assert.deepEqual(wrong, []);
});

test('Russian and Uzbek Cyrillic prose is in Cyrillic script', () => {
  for (const [locale, dict] of [['uz-Cyrl', uzCyrl], ['ru', ru]] as const) {
    for (const [key, value] of Object.entries(dict as Record<string, string>)) {
      if (NEUTRAL.has(key) || !/\p{L}{3,}/u.test(value.replace(/\{\w+\}/g, ''))) continue;
      assert.match(value, /\p{Script=Cyrillic}/u, `${locale} ${key}`);
    }
  }
  // Uzbek-only Cyrillic letters (ў қ ғ ҳ) never leak into Russian.
  const leaked = Object.entries(ru).filter(([, v]) => /[ўқғҳЎҚҒҲ]/u.test(v)).map(([k]) => k);
  assert.deepEqual(leaked, []);
});
