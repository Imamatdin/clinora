import test from 'node:test';
import assert from 'node:assert/strict';
import { registration } from '../src/web/i18n/registration.uz-Cyrl.js';
import { registrationUzLatn } from '../src/web/i18n/registration.uz-Latn.js';
import { registrationRu } from '../src/web/i18n/registration.ru.js';
import { SOURCES } from '../src/modules/registration/actions.js';
import { pickName, translator } from '../src/web/registration/i18n.js';

test('task 007 registration strings exist in all three languages with the same keys and placeholders', () => {
  const keys = Object.keys(registration).sort();
  const vars = (v: string) => [...v.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
  for (const [locale, dict, script] of [['uz-Latn', registrationUzLatn, /\p{Script=Latin}/u], ['ru', registrationRu, /\p{Script=Cyrillic}/u]] as const) {
    assert.deepEqual(Object.keys(dict).sort(), keys, locale);
    for (const key of keys) {
      const value = (dict as Record<string, string>)[key]!;
      assert.ok(value.trim().length > 0, `${locale} ${key}`);
      assert.deepEqual(vars(value), vars(registration[key as keyof typeof registration]), `${locale} ${key} placeholders`);
      if (/\p{L}{3,}/u.test(value)) assert.match(value, script, `${locale} ${key} script`);
      if (locale === 'uz-Latn') assert.doesNotMatch(value, /\p{Script=Cyrillic}/u, `${key} has no Cyrillic in Uzbek Latin`);
    }
  }
  for (const source of SOURCES) assert.ok(`registration.source.${source}` in registration, source);
});

test('translator fills placeholders and catalog names fall back to Uzbek Cyrillic', () => {
  assert.equal(translator('ru')('registration.waiting', { count: 3 }), 'В очереди: 3');
  assert.equal(pickName({ uzCyrl: 'Терапевт', uzLatn: null, ru: null }, 'uz-Latn'), 'Терапевт');
  assert.equal(pickName({ uzCyrl: 'Терапевт', uzLatn: 'Terapevt', ru: 'Терапевт' }, 'uz-Latn'), 'Terapevt');
});
