import type { ImportRow, ServiceKind } from './model.js';
import { parseBinary, scalar, list, type BinaryNode } from './binary.js';

export type DtErrorCode = 'NOT_A_DT' | 'CORRUPT' | 'TRUNCATED' | 'UNRECOGNIZED_LAYOUT' | 'TOO_LARGE';
export class DtError extends Error {
  constructor(public readonly code: DtErrorCode, public readonly offset?: number, public readonly tag?: number) {
    super(`${code}${offset === undefined ? '' : ` at offset ${offset}`}${tag === undefined ? '' : ` tag 0x${tag.toString(16)}`}`);
  }
}
export const DT_SIGNATURE = '1CIBDmpF';
export const DT_PAYLOAD_OFFSET = 9;
export type Inflater = (compressed: AsyncIterable<Uint8Array>) => AsyncIterable<Uint8Array>;
export type ObjectReport = { name: string; mode: 'catalog' | 'price-register' | 'structure' | 'skipped'; records?: number; fields?: string[] };
export type StructureReport = { name: string; records: number; fields: { name: string; kinds: string[] }[] };
export type DtExtract = { version: string; inflatedBytes: number; objects: ObjectReport[]; priceSources: string[]; structure: StructureReport[]; rows: ImportRow[] };
const lower = (s: string) => s.toLocaleLowerCase('ru');
/** Whole UZS from a 1C number ("150000", "150000.00", "150 000,00"). */
export function parsePrice(text: string): { priceUzs: string } | { rejected: 'BAD_PRICE' | 'FRACTIONAL_PRICE' } {
  const t = text.replace(/[\s ]/g, '').replace(',', '.');
  const m = /^(\d{1,15})(?:\.(\d+))?$/.exec(t);
  if (!m) return { rejected: 'BAD_PRICE' };
  if (m[2] && /[1-9]/.test(m[2])) return { rejected: 'FRACTIONAL_PRICE' };
  return { priceUzs: String(BigInt(m[1]!)) };
}
/** 1C period values: "20240115000000", ISO dates, or DD.MM.YYYY. */
export function parsePeriod(text: string): string | null {
  let m = /^(\d{4})(\d{2})(\d{2})\d{0,6}$/.exec(text);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{2})\.(\d{2})\.(\d{4})/.exec(text); if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}
/** Kind for a МУОЛАЖА row, from its names. Kind is fixed once saved, so the preview shows it. */
export function inferKind(names: string): ServiceKind {
  const s = lower(names);
  if (/операц|эктоми|резекц|amaliyot/.test(s)) return 'surgery';
  if (/узи|утт|ультразвук|ultratovush|рентген|rentgen|экг|ekg|эхо|exo|мскт|мрт|mrt|диагност|diagnost|доплер|dopler/.test(s)) return 'diagnostic';
  if (/кўри[гк]|кури[гк]|маслаҳат|консультац|ko.rik|qabul|қабул|приём|прием/.test(s)) return 'consultation';
  return 'procedure';
}

async function* afterHeader(source: AsyncIterable<Uint8Array>, header: (h: Uint8Array) => void): AsyncIterable<Uint8Array> {
  let head = new Uint8Array(0), done = false;
  for await (const chunk of source) {
    if (done) { yield chunk; continue; }
    const joined = new Uint8Array(head.length + chunk.length); joined.set(head); joined.set(chunk, head.length); head = joined;
    if (head.length < DT_PAYLOAD_OFFSET) continue;
    header(head.subarray(0, DT_PAYLOAD_OFFSET)); done = true;
    if (head.length > DT_PAYLOAD_OFFSET) yield head.subarray(DT_PAYLOAD_OFFSET);
  }
  if (!done) header(head);
}

/** Checks the 9-byte header. Returns the dump format version digit. */
export function checkHeader(head: Uint8Array): string {
  if (head.length < DT_PAYLOAD_OFFSET) throw new DtError('NOT_A_DT');
  const sig = String.fromCharCode(...head.subarray(0, 8)), version = String.fromCharCode(head[8]!);
  if (sig !== DT_SIGNATURE || !/^[0-9]$/.test(version)) throw new DtError('NOT_A_DT');
  return version;
}

export type ReadOptions = { maxInflatedBytes?: number; maxRecords?: number };
const ALLOWED = new Set(['МУОЛАЖА', 'Анализ', 'БУЛИМ', 'ВРАЧЛАР', 'МИХИЛАР', 'ХоналарТипи', 'Туман', 'МФЙ', 'Дорилар', 'Товары', 'Расходлар']);
const SECRET = /^(ПАРОЛ|Телефон)$/i;

async function collect(source: AsyncIterable<Uint8Array>, max: number): Promise<Uint8Array> {
  const parts: Uint8Array[] = []; let size = 0;
  for await (const part of source) { size += part.length; if (size > max) throw new DtError('TOO_LARGE'); parts.push(part); }
  const out = new Uint8Array(size); let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}
async function unpack(data: Uint8Array, inflate: Inflater, max: number) {
  try { return await collect(inflate((async function* () { yield data; })()), max); }
  catch (e) { if (e instanceof DtError) throw e; return data; } // reference: folder entries may be uncompressed
}
async function folder(node: BinaryNode | undefined, inflate: Inflater, max: number) {
  const files = new Map<string, Uint8Array>(); let size = 0;
  for (const e of list(node)) {
    const entry = list(e); if (entry.length <= 11) continue;
    const name = scalar(entry[1]); if (!name) continue;
    const parts: Uint8Array[] = [];
    const walk = (n: BinaryNode) => { if (Array.isArray(n)) n.forEach(walk); else if (typeof n === 'object' && n.kind === 'bytes') parts.push(n.bytes); };
    entry.slice(11).forEach(walk);
    const blob = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0;
    for (const p of parts) { blob.set(p, at); at += p.length; }
    const decoded = await unpack(blob, inflate, max - size); size += decoded.length;
    files.set(name, decoded);
  }
  return files;
}

/** Port of scripts/reference/dt_reference.py. Binary scalars stay byte spans until explicitly selected.
 * This is deliberate: patient/caretaker lists and unapproved attributes never enter a text decoder.
 * Bounded inflated input (real dumps are 4–5 MiB) is indexed once; nested metadata uses the same browser inflater.
 */
async function extractDt(source: AsyncIterable<Uint8Array>, inflate: Inflater, options: ReadOptions = {}): Promise<DtExtract> {
  const max = options.maxInflatedBytes ?? 64 * 1024 ** 2;
  let version = '', data: Uint8Array;
  try { data = await collect(inflate(afterHeader(source, h => { version = checkHeader(h); })), max); }
  catch (e) { if (e instanceof DtError) throw e; throw new DtError('CORRUPT'); }
  if (!version) throw new DtError('NOT_A_DT');
  if (version !== '3') throw new DtError('UNRECOGNIZED_LAYOUT');
  const top = parseBinary(data);
  const sections = new Map<string, BinaryNode[]>();
  for (const n of top) { const a = list(n); const key = scalar(a[0]); if (key) sections.set(key === 'Folder' ? scalar(a[1]) ?? '' : key, a); }
  const db = list(sections.get('DataBase')?.[1]);
  if (!sections.has('Config') || !sections.has('Params') || !db.length) throw new DtError('UNRECOGNIZED_LAYOUT');
  const config = await folder(sections.get('Config')?.[2], inflate, max);
  const params = await folder(sections.get('Params')?.[2], inflate, max);
  const names = new TextDecoder().decode(params.get('DBNames'));
  const mappings = [...names.matchAll(/\{([0-9a-f-]{36}),"(\w+)",(\d+)\}/g)];
  const fields = new Map(mappings.filter(m => m[2] === 'Fld').map(m => [m[1]!, `Fld${m[3]}`]));
  const catalogs = new Map<string, { name: string; attrs: Map<string, string> }>();
  for (const m of mappings) {
    if (m[2] !== 'Reference' || !config.has(m[1]!)) continue;
    const txt = new TextDecoder().decode(config.get(m[1]!)!);
    const name = new RegExp('\\{0,0,' + m[1] + '\\},"([^"]+)"').exec(txt)?.[1]
      ?? /"([А-ЯЁЎҚҒҲа-яёўқғҳA-Za-z_][^"]{1,60})"/.exec(txt)?.[1];
    if (!name) continue;
    const attrs = new Map<string, string>();
    for (const a of txt.matchAll(/([0-9a-f-]{36})\},"([^"]+)",\s*\{1,"ru"/g)) {
      const field = fields.get(a[1]!); if (field) attrs.set(field, a[2]!);
    }
    catalogs.set(`Reference${m[3]}`, { name, attrs });
  }
  const schema = list(list(db[0])[1]);
  const order: { table: string; descriptor: BinaryNode[] }[] = [];
  for (const n of schema.slice(1)) {
    const t = list(n), table = scalar(t[0]); if (!table) throw new DtError('UNRECOGNIZED_LAYOUT');
    order.push({ table, descriptor: t });
    for (const st of list(t[5]).slice(1)) { const s = list(st); if (s.length) order.push({ table: `${table}.${scalar(s[0])}`, descriptor: s }); }
  }
  if (db.length !== order.length + 1) throw new DtError('UNRECOGNIZED_LAYOUT');
  type RecordRow = { source: string; code: string | null; ref: string | null; values: Map<string, string | null> };
  const records: RecordRow[] = [], objects: ObjectReport[] = [], structure: StructureReport[] = [];
  let count = 0;
  for (const [i, { table, descriptor }] of order.entries()) {
    const catalog = catalogs.get(table), rows = list(db[i + 1]);
    if (!catalog) continue;
    const { name, attrs } = catalog;
    if (!ALLOWED.has(name)) { objects.push({ name: `Справочник.${name}`, mode: 'skipped' }); continue; }
    const columns = list(descriptor[4]).slice(1).map(list).filter(f => scalar(list(list(f[2])[1])[0]) !== '86').map(f => scalar(f[0])!);
    const safeNames = columns.map(c => attrs.get(c) ?? c).filter(c => !SECRET.test(c));
    objects.push({ name, mode: 'catalog', records: rows.length - 1, fields: safeNames });
    for (const n of rows.slice(1)) {
      if (++count > (options.maxRecords ?? 200_000)) throw new DtError('TOO_LARGE');
      const row = list(n), values = new Map<string, string | null>(); let k = 0;
      for (const col of columns) {
        const flag = scalar(row[k++]); if (flag !== '0' && flag !== '1') throw new DtError('UNRECOGNIZED_LAYOUT');
        const value = flag === '1' ? row[k++] : undefined;
        if (flag === '1' && value === undefined) throw new DtError('TRUNCATED');
        const attr = attrs.get(col) ?? col;
        // Decode only mapped reference fields. Credentials and phone values remain raw byte spans.
        if (!SECRET.test(attr) && SAFE_FIELDS.has(attr)) values.set(attr, scalar(value));
      }
      if (k !== row.length) throw new DtError('UNRECOGNIZED_LAYOUT');
      const ref = values.get('ID') ?? values.get('Ref') ?? null;
      const code = values.get('Code')?.trim() || ref;
      records.push({ source: name, code: code ? `${name}/${code}` : null, ref, values });
    }
  }
  if (!catalogs.size || !order.length) throw new DtError('UNRECOGNIZED_LAYOUT');
  const refs = new Map(records.filter(r => r.ref).map(r => [r.ref!, r]));
  const rows: ImportRow[] = [], priceSources = new Set<string>();
  for (const r of records) {
    const v = r.values, get = (...keys: string[]) => keys.map(k => v.get(k)).find(x => x != null && x !== '') ?? null;
    if (r.source === 'МИХИЛАР') continue; // tax classifier, never a specialty/service group
    const name = get('Description'), parent = refs.get(get('ParentID', 'Parent', 'Туман') ?? '');
    const group = r.source === 'Анализ' && get('Folder') === '0';
    const base: ImportRow = { object: 'service', source: r.source, code: r.code, nameUzCyrl: name,
      nameUzLatn: get('НаименованиеЛат'), nameRu: get('НаименованиеРус'),
      rejected: get('Marked', 'DeletionMark') === '1' ? 'DELETED' : !name ? 'NO_NAME' : !r.code ? 'NO_CODE' : null };
    if (r.source === 'БУЛИМ') base.object = 'department';
    else if (r.source === 'ВРАЧЛАР') { base.object = 'doctor'; base.doctorRoles = { 'Кабул': get('Кабул') === '1', 'Стационар': get('Стационар') === '1', 'Лабаратория': get('Лабаратория') === '1', 'УЗИ': get('УЗИ') === '1' }; }
    else if (r.source === 'Туман') base.object = 'district';
    else if (r.source === 'МФЙ') { base.object = 'mahalla'; base.district = parent?.source === 'Туман' ? parent.code : null; }
    else if (r.source === 'Расходлар') base.object = 'expenseType';
    else if (r.source === 'ХоналарТипи') base.object = 'roomType';
    else if (group) base.object = 'serviceGroup';
    if (base.object === 'service') {
      base.kind = r.source === 'Анализ' ? 'lab' : r.source === 'Дорилар' ? 'medicine' : r.source === 'Товары' ? 'good' : inferKind(name ?? '');
      base.trackStock = ['medicine', 'good'].includes(base.kind);
      base.unit = get('УлБир', 'ЕдиницаИзмерения');
      base.referenceRange = get('Норма');
      base.group = parent?.source === 'Анализ' && parent.values.get('Folder') === '0' ? parent.code : null;
      const dep = refs.get(get('БУЛИМ', 'Булим') ?? ''); base.department = dep?.source === 'БУЛИМ' ? dep.code : null;
      const mxik = get('МИХИ'); base.mxikCode = refs.get(mxik ?? '')?.values.get('Description') ?? mxik;
    }
    const priceKey = r.source === 'МУОЛАЖА' ? 'НАРХИ' : r.source === 'Анализ' && !group ? 'Цена' : r.source === 'ХоналарТипи' ? 'КунликЁтокПули' : r.source === 'Товары' ? 'СотувНархи' : null;
    const price = priceKey ? get(priceKey) : null;
    if (price !== null) {
      priceSources.add(`${r.source}.${priceKey}`); const parsed = parsePrice(price);
      if ('rejected' in parsed) base.rejected ??= parsed.rejected; else base.priceUzs = parsed.priceUzs;
    }
    if (get('Folder') === '0' && !group) base.rejected ??= 'FOLDER';
    rows.push(base);
    if (base.object === 'roomType' && base.priceUzs && !base.rejected) rows.push({ ...base, object: 'service', code: `${base.code}/bed`, kind: 'bed' });
  }
  return { version, inflatedBytes: data.length, objects, structure, rows, priceSources: [...priceSources] };
}
const SAFE_FIELDS = new Set(['ID', 'Ref', 'Code', 'Description', 'Folder', 'DeletionMark', 'Parent', 'ParentID', 'Marked', 'БУЛИМ', 'Булим', 'МИХИ', 'УлБир', 'НАРХИ', 'Цена', 'Норма', 'КунликЁтокПули', 'СотувНархи', 'КиримНархи', 'Туман', 'Кабул', 'Стационар', 'Лабаратория', 'УЗИ', 'НаименованиеЛат', 'НаименованиеРус', 'ЕдиницаИзмерения']);

/** No platform decoder/inflater exception can expose a partially extracted result. */
export async function readDt(source: AsyncIterable<Uint8Array>, inflate: Inflater, options: ReadOptions = {}): Promise<DtExtract> {
  try { return await extractDt(source, inflate, options); }
  catch (error) { if (error instanceof DtError) throw error; throw new DtError('CORRUPT'); }
}
