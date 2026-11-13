import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/*
 * Task 026 design rules that a stylesheet can break silently. Raised surfaces (box-shadow) are allowed only on
 * modals and the two popup menus (phone header menu, "More" tabs menu); everything else gets its structure from
 * type, spacing and hairline rules. Purple and gradients are not in the palette.
 */
const RAISED = /\.(modal|header-menu-panel|tabs-menu)\b/;

async function files(dir: string, ext: RegExp): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await files(path, ext)); else if (ext.test(entry.name)) out.push(path);
  }
  return out;
}

/** Flat list of [selector, declarations] for every rule, including rules nested in @media and @supports. */
export function rules(css: string): [string, string][] {
  const out: [string, string][] = [], stack: string[] = [];
  let text = '';
  for (const ch of css.replace(/\/\*[\s\S]*?\*\//g, '')) {
    if (ch === '{') { stack.push(text.trim()); text = ''; }
    else if (ch === '}') { const selector = stack.pop() ?? ''; if (!selector.startsWith('@') && text.trim()) out.push([selector, text]); text = ''; }
    else if (ch === ';' && stack.length && !stack[stack.length - 1]!.startsWith('@')) text += ch;
    else text += ch;
  }
  return out;
}

test('box-shadow only on modals and the popup menus', async () => {
  const offenders: string[] = [];
  for (const file of await files('src/web', /\.css$/)) {
    for (const [selector, body] of rules(await readFile(file, 'utf8'))) {
      const shadow = /box-shadow\s*:\s*([^;]+)/.exec(body);
      if (!shadow || /^\s*none\s*(!important)?\s*$/.test(shadow[1]!)) continue;
      if (selector.split(',').some(part => !RAISED.test(part))) offenders.push(`${file}: ${selector}`);
    }
  }
  for (const file of await files('src/web', /\.tsx$/)) if (/boxShadow/.test(await readFile(file, 'utf8'))) offenders.push(`${file}: inline boxShadow`);
  assert.deepEqual(offenders, []);
});

test('no gradients and no purple in the stylesheets', async () => {
  const offenders: string[] = [];
  for (const file of await files('src/web', /\.css$/)) {
    const css = (await readFile(file, 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
    if (/gradient\s*\(/.test(css)) offenders.push(`${file}: gradient`);
    for (const [hex] of css.matchAll(/#[0-9a-fA-F]{6}\b/g)) {
      const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
      // Purple: red and blue both clearly above green (hue roughly 260-320 degrees) and saturated enough to read as color.
      if (r - g > 40 && b - g > 40 && Math.max(r, g, b) - Math.min(r, g, b) > 60) offenders.push(`${file}: ${hex}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('the rule parser sees nested selectors', () => {
  const parsed = rules('@media(max-width:600px){.a{box-shadow:0 0 1px red}.modal{color:red}} .b{x:1}');
  assert.deepEqual(parsed.map(r => r[0]), ['.a', '.modal', '.b']);
});
