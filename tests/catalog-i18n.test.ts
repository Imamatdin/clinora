import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogUzCyrl } from '../src/web/i18n/catalog.uz-Cyrl.js';
import { catalogUzLatn } from '../src/web/i18n/catalog.uz-Latn.js';
import { catalogRu } from '../src/web/i18n/catalog.ru.js';
import { REJECT_REASONS, SERVICE_KINDS } from '../src/modules/import1c/model.js';
import { pickName, translator } from '../src/web/catalog/i18n.js';
import { pages } from '../src/web/catalog/files.js';

test('task 005 catalog strings exist in all three languages with the same keys and placeholders', () => {
  const keys = Object.keys(catalogUzCyrl).sort();
  const vars = (v: string) => [...v.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
  for (const [key, value] of Object.entries(catalogUzCyrl)) if (/\p{L}{3,}/u.test(value)) assert.match(value, /\p{Script=Cyrillic}/u, key);
  for (const [locale, dict, script] of [['uz-Latn', catalogUzLatn, /\p{Script=Latin}/u], ['ru', catalogRu, /\p{Script=Cyrillic}/u]] as const) {
    assert.deepEqual(Object.keys(dict).sort(), keys, locale);
    for (const key of keys) {
      const value = (dict as Record<string, string>)[key]!;
      assert.ok(value.trim().length > 0, `${locale} ${key}`);
      assert.deepEqual(vars(value), vars(catalogUzCyrl[key as keyof typeof catalogUzCyrl]), `${locale} ${key} placeholders`);
      if (/\p{L}{3,}/u.test(value)) assert.match(value, script, `${locale} ${key} script`);
      if (locale === 'uz-Latn') assert.doesNotMatch(value, /\p{Script=Cyrillic}/u, `${key} has no Cyrillic in Uzbek Latin`);
    }
  }
  for (const kind of SERVICE_KINDS) assert.ok(`catalog.kind.${kind}` in catalogUzCyrl, kind);
  for (const reason of REJECT_REASONS) assert.ok(`catalog.reason.${reason}` in catalogUzCyrl, reason);
  for (const code of ['NOT_A_DT', 'CORRUPT', 'TRUNCATED', 'UNRECOGNIZED_LAYOUT', 'TOO_LARGE', 'NOT_A_TABLE', 'UNSUPPORTED_XLSX', 'EMPTY']) assert.ok(`catalog.err.${code}` in catalogUzCyrl, code);
  assert.equal(translator('ru')('catalog.import.records', { count: 3 }), '3 записей');
  assert.equal(pickName({ uzCyrl: 'Терапевт', uzLatn: null, ru: null }, 'ru'), 'Терапевт');
});

test('upload pages stay under the API body limit and keep row positions', () => {
  const rows = Array.from({ length: 1234 }, (_, i) => ({ object: 'service' as const, source: 'МУОЛАЖА', code: `МУОЛАЖА/${i}`, nameUzCyrl: 'Ҳ'.repeat(200), priceUzs: '1000' }));
  const out = pages(rows);
  assert.ok(out.every(p => new TextEncoder().encode(JSON.stringify({ offset: p.offset, rows: p.rows })).length < 100_000));
  assert.deepEqual(out.flatMap(p => p.rows), rows);
  out.forEach((p, i) => assert.equal(p.offset, out.slice(0, i).reduce((n, q) => n + q.rows.length, 0)));
});
