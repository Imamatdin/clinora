import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';
import { uzCyrl } from '../src/web/i18n/uz-Cyrl.js';
import { accessUzCyrl } from '../src/web/i18n/access.uz-Cyrl.js';
import { accessUzLatn } from '../src/web/i18n/access.uz-Latn.js';
import { accessRu } from '../src/web/i18n/access.ru.js';

// Gate for increment C1: no hardcoded user-visible strings in the web client.
const VISIBLE_ATTRIBUTES = new Set(['placeholder', 'aria-label', 'title', 'alt', 'label']);
const words = /\p{L}{2,}/u; // Two letters in a row; lets technical examples such as "+05:00" or "T" pass.

async function tsxFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await tsxFiles(path));
    else if (entry.name.endsWith('.tsx')) out.push(path);
  }
  return out;
}

test('web client has no hardcoded visible strings; everything goes through t()', async () => {
  const violations: string[] = [];
  const files = await tsxFiles('src/web');
  assert.ok(files.length >= 4, 'scanner found the web sources');
  for (const file of files) {
    const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const report = (node: ts.Node, text: string) => violations.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${JSON.stringify(text.trim())}`);
    const visit = (node: ts.Node) => {
      if (ts.isJsxText(node) && words.test(node.text)) report(node, node.text);
      if (ts.isJsxAttribute(node) && VISIBLE_ATTRIBUTES.has(node.name.getText(source)) && node.initializer && ts.isStringLiteral(node.initializer) && words.test(node.initializer.text)) report(node, node.initializer.text);
      if (ts.isJsxExpression(node) && node.expression && (ts.isStringLiteral(node.expression) || ts.isNoSubstitutionTemplateLiteral(node.expression)) && words.test(node.expression.text)
        && !ts.isJsxAttribute(node.parent)) report(node, node.expression.text);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.deepEqual(violations, []);
});

test('uz-Cyrl dictionary entries are non-empty and Cyrillic where they are prose', () => {
  for (const [key, value] of Object.entries(uzCyrl)) {
    assert.ok(value.trim().length > 0, key);
    if (!['app.brand', 'auth.email', 'app.title', 'access.me.telegramTitle'].includes(key) && /\p{L}{3,}/u.test(value)) assert.match(value, /\p{Script=Cyrillic}/u, key);
  }
});

test('task 004 access strings exist in all three languages with the same keys and placeholders', () => {
  const keys = Object.keys(accessUzCyrl).sort();
  const vars = (v: string) => [...v.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
  for (const [locale, dict, script] of [['uz-Latn', accessUzLatn, /\p{Script=Latin}/u], ['ru', accessRu, /\p{Script=Cyrillic}/u]] as const) {
    assert.deepEqual(Object.keys(dict).sort(), keys, locale);
    for (const key of keys) {
      const value = (dict as Record<string, string>)[key]!;
      assert.ok(value.trim().length > 0, `${locale} ${key}`);
      assert.deepEqual(vars(value), vars(accessUzCyrl[key as keyof typeof accessUzCyrl]), `${locale} ${key} placeholders`);
      if (key !== 'access.me.telegramTitle' && /\p{L}{3,}/u.test(value)) assert.match(value, script, `${locale} ${key} script`);
      if (locale === 'uz-Latn') assert.doesNotMatch(value, /\p{Script=Cyrillic}/u, `${key} has no Cyrillic in Uzbek Latin`);
    }
    assert.ok(Object.keys(dict).every(k => k.startsWith('access.')), 'feature keys carry the access. prefix');
  }
});

test('per-feature dictionaries merge without collisions and feature keys carry their prefix', async () => {
  const { UZ_CYRL_PARTS } = await import('../src/web/i18n/uz-Cyrl.js');
  const seen = new Map<string, string>();
  for (const [part, dict] of Object.entries(UZ_CYRL_PARTS)) {
    for (const key of Object.keys(dict)) {
      assert.ok(!seen.has(key), `${key} defined by ${seen.get(key)} and ${part}`);
      seen.set(key, part);
      if (part !== 'core') assert.ok(key.startsWith(part + '.'), `${part} key ${key} must start with "${part}."`);
    }
  }
  assert.equal(Object.keys(uzCyrl).length, seen.size);
});
