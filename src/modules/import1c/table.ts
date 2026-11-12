import { parsePrice } from './dt.js';
import { SERVICE_KINDS, type ImportObject, type ImportRow, type ServiceKind } from './model.js';

/*
 * Spreadsheet import for clinics without a readable .dt: 1C list exports saved as .xlsx or .csv.
 * Parsing runs in the administrator's browser (and in tests); the result is the same ImportRow shape
 * the .dt reader produces, so both paths share one staging, preview and commit flow on the server.
 */

export class TableError extends Error { constructor(public readonly code: 'NOT_A_TABLE' | 'UNSUPPORTED_XLSX' | 'TOO_LARGE' | 'EMPTY') { super(code); } }
export const MAX_TABLE_ROWS = 50_000;
const MAX_COLUMNS = 60;

/** CSV with automatic delimiter (comma, semicolon or tab), quoted fields and a UTF-8 BOM. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.slice(0, src.search(/\r?\n|$/));
  const delimiter = [';', '\t', ','].map(d => [d, firstLine.split(d).length] as const).sort((a, b) => b[1] - a[1])[0]![0];
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += ch;
      continue;
    }
    if (ch === '"' && cell === '') quoted = true;
    else if (ch === delimiter) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = ''; rows.push(row); row = [];
      if (rows.length > MAX_TABLE_ROWS + 1) throw new TableError('TOO_LARGE');
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return clean(rows);
}

function clean(rows: string[][]): string[][] {
  const out = rows.map(r => r.slice(0, MAX_COLUMNS).map(c => c.trim())).filter(r => r.some(c => c !== ''));
  if (!out.length) throw new TableError('EMPTY');
  if (out.length > MAX_TABLE_ROWS + 1) throw new TableError('TOO_LARGE');
  return out;
}

export type InflateRaw = (data: Uint8Array) => Promise<Uint8Array>;
type ZipEntry = { name: string; method: number; compressed: number; offset: number };

function zipEntries(zip: Uint8Array): ZipEntry[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65535); i--) if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new TableError('NOT_A_TABLE');
  const count = view.getUint16(eocd + 10, true), cdOffset = view.getUint32(eocd + 16, true);
  if (cdOffset === 0xffffffff) throw new TableError('UNSUPPORTED_XLSX');
  const entries: ZipEntry[] = [], decoder = new TextDecoder();
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > zip.length || view.getUint32(p, true) !== 0x02014b50) throw new TableError('NOT_A_TABLE');
    const method = view.getUint16(p + 10, true), compressed = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true), extraLen = view.getUint16(p + 30, true), commentLen = view.getUint16(p + 32, true);
    const offset = view.getUint32(p + 42, true);
    entries.push({ name: decoder.decode(zip.subarray(p + 46, p + 46 + nameLen)), method, compressed, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
async function entryText(zip: Uint8Array, entry: ZipEntry, inflate: InflateRaw): Promise<string> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  if (view.getUint32(entry.offset, true) !== 0x04034b50) throw new TableError('NOT_A_TABLE');
  const start = entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true);
  const data = zip.subarray(start, start + entry.compressed);
  if (entry.method === 0) return new TextDecoder().decode(data);
  if (entry.method !== 8) throw new TableError('UNSUPPORTED_XLSX');
  return new TextDecoder().decode(await inflate(data));
}
const unescapeXml = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_m, e: string) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
    : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[e.toLowerCase()]!);
const textOf = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(m => unescapeXml(m[1]!)).join('');
const column = (ref: string) => { let n = 0; for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };

/** First worksheet of an .xlsx as rows of cell text. Numbers keep the text Excel stored. */
export async function readXlsx(zip: Uint8Array, inflate: InflateRaw): Promise<string[][]> {
  const entries = zipEntries(zip);
  const find = (name: string) => entries.find(e => e.name === name);
  const shared: string[] = [];
  const sst = find('xl/sharedStrings.xml');
  if (sst) for (const m of (await entryText(zip, sst, inflate)).matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(textOf(m[1]!));
  let sheetPath = 'xl/worksheets/sheet1.xml';
  const workbook = find('xl/workbook.xml'), rels = find('xl/_rels/workbook.xml.rels');
  if (workbook && rels) {
    const rid = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(await entryText(zip, workbook, inflate))?.[1];
    const target = rid ? new RegExp(`<Relationship\\b[^>]*Id="${rid}"[^>]*Target="([^"]+)"`).exec(await entryText(zip, rels, inflate))?.[1]
      ?? new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${rid}"`).exec(await entryText(zip, rels, inflate))?.[1] : undefined;
    if (target) sheetPath = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
  }
  const sheet = find(sheetPath);
  if (!sheet) throw new TableError('NOT_A_TABLE');
  const xml = await entryText(zip, sheet, inflate);
  const rows: string[][] = [];
  for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: string[] = [];
    for (const c of r[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1]!, body = c[2] ?? '', ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1], type = /\bt="(\w+)"/.exec(attrs)?.[1];
      const idx = ref ? column(ref) : row.length;
      if (idx >= MAX_COLUMNS) continue;
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      const value = type === 's' ? shared[Number(v)] ?? '' : type === 'inlineStr' ? textOf(body) : v !== undefined ? unescapeXml(v) : '';
      while (row.length < idx) row.push('');
      row[idx] = value;
    }
    rows.push(row);
    if (rows.length > MAX_TABLE_ROWS + 1) throw new TableError('TOO_LARGE');
  }
  return clean(rows);
}

export const MAPPABLE = ['code', 'nameUzCyrl', 'nameUzLatn', 'nameRu', 'priceUzs', 'department', 'group', 'district', 'unit', 'kind', 'specialty'] as const;
export type Mappable = (typeof MAPPABLE)[number];
export type ColumnMapping = Partial<Record<Mappable, number>>;
/** Which fields make sense for each list. The mapping screen offers only these. */
export const FIELDS_FOR: Record<Exclude<ImportObject, 'price'>, readonly Mappable[]> = {
  service: ['code', 'nameUzCyrl', 'nameUzLatn', 'nameRu', 'priceUzs', 'kind', 'group', 'department', 'unit'],
  department: ['code', 'nameUzCyrl', 'nameUzLatn', 'nameRu'],
  serviceGroup: ['code', 'nameUzCyrl', 'nameUzLatn', 'nameRu', 'department'],
  doctor: ['code', 'nameUzCyrl', 'specialty', 'department'],
  district: ['code', 'nameUzCyrl', 'nameUzLatn', 'nameRu'],
  mahalla: ['code', 'nameUzCyrl', 'nameUzLatn', 'nameRu', 'district'],
  roomType: ['code', 'nameUzCyrl', 'nameUzLatn', 'nameRu'],
  expenseType: ['code', 'nameUzCyrl', 'nameUzLatn', 'nameRu']
};

/** Guesses a mapping from header names in Uzbek, Russian or English. The administrator confirms it. */
export function guessMapping(header: string[]): ColumnMapping {
  const rules: [Mappable, RegExp][] = [
    ['code', /^(код|code|kod|№)$/i], ['nameUzLatn', /лат|lotin|latin/i], ['nameRu', /рус|russ|ru$/i],
    ['priceUzs', /нарх|narx|цена|price|сумма/i], ['group', /михил|группа|guruh|group/i], ['department', /булим|бўлим|bo.lim|отдел|department/i],
    ['district', /туман|район|tuman|district/i], ['unit', /бирлик|ед\.|единиц|birlik|unit/i], ['kind', /тур|вид|kind|type/i],
    ['specialty', /мутахассис|специальн|mutaxassis|specialty/i], ['nameUzCyrl', /наимен|номи|nomi|name|исм|ф\.?и\.?о/i]
  ];
  const out: ColumnMapping = {};
  header.forEach((h, i) => { const rule = rules.find(([field, re]) => re.test(h.trim()) && out[field] === undefined); if (rule) out[rule[0]] = i; });
  return out;
}

/** Turns spreadsheet rows into import rows. `kind` is the default service kind for rows without a kind column. */
export function rowsFromTable(table: string[][], object: Exclude<ImportObject, 'price'>, mapping: ColumnMapping,
  options: { headerRow: boolean; kind?: ServiceKind; trackStock?: boolean; source: string }): ImportRow[] {
  const body = options.headerRow ? table.slice(1) : table;
  if (body.length > MAX_TABLE_ROWS) throw new TableError('TOO_LARGE');
  const allowed = new Set(FIELDS_FOR[object]);
  const get = (row: string[], field: Mappable) => { const i = mapping[field]; return i === undefined || !allowed.has(field) ? null : row[i]?.trim() || null; };
  return body.map(row => {
    const out: ImportRow = { object, source: options.source.slice(0, 80), code: get(row, 'code'), nameUzCyrl: get(row, 'nameUzCyrl'),
      nameUzLatn: get(row, 'nameUzLatn'), nameRu: get(row, 'nameRu'), department: get(row, 'department'), group: get(row, 'group'),
      district: get(row, 'district'), unit: get(row, 'unit'), specialty: get(row, 'specialty'), rejected: null };
    let rejected: string | null = !out.nameUzCyrl ? 'NO_NAME' : null;
    if (object === 'service') {
      const k = get(row, 'kind');
      out.kind = k && (SERVICE_KINDS as readonly string[]).includes(k) ? k as ServiceKind : options.kind ?? 'procedure';
      out.trackStock = options.trackStock ?? (out.kind === 'medicine' || out.kind === 'good');
      const price = get(row, 'priceUzs');
      if (price) { const p = parsePrice(price); if ('rejected' in p) rejected ??= p.rejected; else out.priceUzs = p.priceUzs; }
    }
    if (out.unit) out.unit = out.unit.slice(0, 40);
    out.rejected = rejected;
    return out;
  });
}
