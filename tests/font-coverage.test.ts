import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { brotliDecompressSync } from 'node:zlib';
import { join } from 'node:path';

/*
 * Task 026: every character in the interface dictionaries must be drawn by the bundled Onest font, in every
 * weight we ship. The browser picks a @font-face by unicode-range, so each character is checked against the
 * one subset file whose range covers it; a character outside every range would silently fall back to a
 * system font, so that fails too.
 */

/** Reads a WOFF2 file and returns the set of code points its cmap maps to a real glyph. */
export function woff2Codepoints(file: Buffer): Set<number> {
  assert.equal(file.toString('latin1', 0, 4), 'wOF2', 'not a WOFF2 file');
  const numTables = file.readUInt16BE(12), compressedSize = file.readUInt32BE(20);
  let p = 48;
  const base128 = () => { let v = 0; for (let i = 0; i < 5; i++) { const b = file[p++]!; v = v * 128 + (b & 0x7f); if (!(b & 0x80)) return v; } throw new Error('bad UIntBase128'); };
  const tables: { tag: string; length: number }[] = [];
  for (let i = 0; i < numTables; i++) {
    const flags = file[p++]!, index = flags & 0x3f, version = flags >> 6;
    const tag = index === 63 ? file.toString('latin1', p, (p += 4)) : index === 0 ? 'cmap' : index === 10 ? 'glyf' : index === 11 ? 'loca' : `#${index}`;
    const original = base128();
    const transformed = tag === 'glyf' || tag === 'loca' ? version === 0 : version !== 0;
    tables.push({ tag, length: transformed ? base128() : original });
  }
  const data = brotliDecompressSync(file.subarray(p, p + compressedSize));
  let offset = 0;
  const at = tables.find(t => { if (t.tag === 'cmap') return true; offset += t.length; return false; });
  assert.ok(at, 'font has no cmap');
  const cmap = data.subarray(offset, offset + at.length), points = new Set<number>();
  for (let i = 0, n = cmap.readUInt16BE(2); i < n; i++) {
    const sub = cmap.readUInt32BE(4 + i * 8 + 4), format = cmap.readUInt16BE(sub);
    if (format === 4) {
      const segs = cmap.readUInt16BE(sub + 6) / 2, ends = sub + 14, starts = ends + segs * 2 + 2, deltas = starts + segs * 2, ranges = deltas + segs * 2;
      for (let s = 0; s < segs; s++) {
        const end = cmap.readUInt16BE(ends + s * 2), start = cmap.readUInt16BE(starts + s * 2), delta = cmap.readInt16BE(deltas + s * 2), range = cmap.readUInt16BE(ranges + s * 2);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          const glyph = range === 0 ? (c + delta) & 0xffff : (() => { const g = cmap.readUInt16BE(ranges + s * 2 + range + (c - start) * 2); return g === 0 ? 0 : (g + delta) & 0xffff; })();
          if (glyph) points.add(c);
        }
      }
    } else if (format === 12) {
      for (let g = 0, groups = cmap.readUInt32BE(sub + 12); g < groups; g++) {
        const q = sub + 16 + g * 12, start = cmap.readUInt32BE(q), end = cmap.readUInt32BE(q + 4), glyph = cmap.readUInt32BE(q + 8);
        for (let c = start; c <= end; c++) if (glyph + (c - start)) points.add(c);
      }
    }
  }
  return points;
}

type Face = { weight: number; file: string; ranges: [number, number][] };
async function faces(): Promise<Face[]> {
  const css = await readFile('src/web/fonts.css', 'utf8'), out: Face[] = [];
  for (const block of css.match(/@font-face\{[^}]+\}/g) ?? []) {
    const weight = Number(/font-weight:(\d+)/.exec(block)![1]), file = /url\("([^"]+)"\)/.exec(block)![1]!;
    const ranges = /unicode-range:([^;}]+)/.exec(block)![1]!.split(',').map(r => {
      const [a, b] = r.trim().replace(/^U\+/, '').split('-');
      return [parseInt(a!, 16), parseInt(b ?? a!, 16)] as [number, number];
    });
    out.push({ weight, file: join('src/web', file), ranges });
  }
  return out;
}

async function dictionaryText(): Promise<Map<number, string>> {
  const files = (await readdir('src/web/i18n')).filter(f => f.endsWith('.ts')).map(f => join('src/web/i18n', f));
  for (const dir of await readdir('src/web', { withFileTypes: true }))
    if (dir.isDirectory()) for (const f of await readdir(join('src/web', dir.name))) if (f === 'i18n.ts') files.push(join('src/web', dir.name, f));
  const chars = new Map<number, string>();
  for (const f of files) for (const ch of await readFile(f, 'utf8')) {
    const c = ch.codePointAt(0)!;
    if (c > 0x20 && c !== 0x7f && !chars.has(c)) chars.set(c, f);
  }
  return chars;
}

test('bundled Onest draws every character of the uz-Cyrl, uz-Latn and ru dictionaries in every weight', async () => {
  const all = await faces(), chars = await dictionaryText();
  assert.deepEqual([...new Set(all.map(f => f.weight))].sort(), [400, 500, 700]);
  // The letters the brief names, so a narrowed dictionary cannot make this test pass vacuously.
  for (const ch of 'ўқғҳʻ') assert.ok(chars.has(ch.codePointAt(0)!), `dictionaries should contain ${ch}`);
  // Capitals and the other apostrophe forms appear in patient names and catalog data, not only in dictionaries.
  for (const ch of 'ЎҚҒҲЁʼ’№') if (!chars.has(ch.codePointAt(0)!)) chars.set(ch.codePointAt(0)!, 'names and catalog data');
  const missing: string[] = [];
  for (const weight of [400, 500, 700]) {
    const set = all.filter(f => f.weight === weight), mapped = new Map<string, Set<number>>();
    for (const f of set) mapped.set(f.file, woff2Codepoints(await readFile(f.file)));
    for (const [c, source] of chars) {
      const face = set.find(f => f.ranges.some(([a, b]) => c >= a && c <= b));
      if (!face || !mapped.get(face.file)!.has(c)) missing.push(`U+${c.toString(16).toUpperCase().padStart(4, '0')} ${String.fromCodePoint(c)} (${weight}, ${source}${face ? '' : ', no subset range'})`);
    }
  }
  assert.deepEqual(missing, []);
});

test('the parser reads real cmaps: Latin has A, Cyrillic has Ж, neither has a made-up code point', async () => {
  const dir = 'node_modules/@fontsource/onest/files';
  const latin = woff2Codepoints(await readFile(`${dir}/onest-latin-400-normal.woff2`));
  const cyr = woff2Codepoints(await readFile(`${dir}/onest-cyrillic-400-normal.woff2`));
  assert.ok(latin.has(0x41) && !latin.has(0x416));
  assert.ok(cyr.has(0x416) && !cyr.has(0x10ffff));
});
