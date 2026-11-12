import type { ImportRow, ServiceKind } from './model.js';
import { TokenError, Tokenizer, type TokenSink } from './tokenizer.js';

/*
 * Reader for 1C:Enterprise infobase dumps (.dt) of the Gʻofurov klinikasi configuration.
 *
 * Container (confirmed by the planner on the real files): 8-byte signature `1CIBDmpF`, one ASCII
 * version digit, then a raw deflate stream (wbits -15) from byte 9.
 *
 * Inflated layout (ASSUMPTION, to be confirmed by `scripts/inspect-1c-dump.ts` on the real files): a
 * sequence of top-level brace lists, one per metadata object. The first string directly inside a
 * list is the object's full name (`Справочник.МУОЛАЖА`); every nested list after it is one record;
 * a record is a list of `{field name, value}` pairs; a reference value is a UUID atom or a list that
 * contains one. See README.md in this folder.
 *
 * Only allowlisted catalog objects are decoded. Every other object (БЕМОРЛАР, all documents,
 * registers other than prices) is skipped by the tokenizer without decoding a single value.
 */

export type DtErrorCode = 'NOT_A_DT' | 'CORRUPT' | 'TRUNCATED' | 'UNRECOGNIZED_LAYOUT' | 'TOO_LARGE';
export class DtError extends Error { constructor(public readonly code: DtErrorCode) { super(code); } }

export const DT_SIGNATURE = '1CIBDmpF';
export const DT_PAYLOAD_OFFSET = 9;
/** Turns the compressed stream (raw deflate) into inflated chunks. Node: zlib; browser: DecompressionStream. */
export type Inflater = (compressed: AsyncIterable<Uint8Array>) => AsyncIterable<Uint8Array>;

type Target =
  | { object: 'department' } | { object: 'serviceGroup' } | { object: 'doctor' } | { object: 'district' } | { object: 'mahalla' }
  | { object: 'roomType' } | { object: 'service'; kind: ServiceKind | 'infer'; trackStock: boolean };

/** Catalogs the brief allows us to extract, by 1C name (compared case-insensitively). */
export const CATALOG_TARGETS: Record<string, Target> = {
  'БУЛИМ': { object: 'department' },
  'ВРАЧЛАР': { object: 'doctor' },
  'МИХИЛАР': { object: 'serviceGroup' },
  'МУОЛАЖА': { object: 'service', kind: 'infer', trackStock: false },
  'Анализ': { object: 'service', kind: 'lab', trackStock: false },
  'ЛАБАРАТОРИЯ': { object: 'service', kind: 'lab', trackStock: false },
  'ХоналарТипи': { object: 'roomType' },
  'Туман': { object: 'district' },
  'МФЙ': { object: 'mahalla' },
  'Дорилар': { object: 'service', kind: 'medicine', trackStock: true },
  'Товары': { object: 'service', kind: 'good', trackStock: true }
};
/** Catalogs whose structure (field names, value kinds, record count) is reported, never their values. */
export const STRUCTURE_ONLY = ['Мумкун', 'Каровчи'];
/** Information registers whose name looks like a price list are read as price history. */
const PRICE_REGISTER = /нарх|narx|цен|price|прайс/i;

const lower = (s: string) => s.toLocaleLowerCase('ru');
const targetByName = new Map(Object.entries(CATALOG_TARGETS).map(([k, v]) => [lower(k), { name: k, target: v }]));
const structureByName = new Map(STRUCTURE_ONLY.map(k => [lower(k), k]));

/** Field names we understand, normalized (lower case, no spaces, underscores or dots). */
const ALIASES = {
  code: ['код', 'code', 'kod'],
  ref: ['ссылка', 'ref', 'uuid'],
  nameUzCyrl: ['наименование', 'description', 'номи', 'номиузб', 'наименованиеузб', 'nomi'],
  nameUzLatn: ['наименованиелат', 'наименованиелотин', 'номилотин', 'лотин', 'лотинча', 'nomilotin', 'namelatn', 'наименованиеlat'],
  nameRu: ['наименованиерус', 'наименованиеру', 'номирус', 'русча', 'nameru', 'наименованиеrus'],
  price: ['нархи', 'нарх', 'нархсумма', 'цена', 'narxi', 'narx', 'price', 'сумма', 'суммаси'],
  folder: ['этогруппа', 'isfolder'],
  deleted: ['пометкаудаления', 'deletionmark'],
  unit: ['единицаизмерения', 'бирлик', 'улчовбирлиги', 'ўлчовбирлиги', 'unit'],
  specialty: ['мутахассислик', 'специальность', 'лавозим', 'должность', 'specialty'],
  period: ['период', 'period', 'сана', 'дата', 'date']
} as const;
const norm = (s: string) => lower(s).replace(/[\s_.\-]/g, '');
const aliasOf = new Map<string, keyof typeof ALIASES>();
for (const [field, names] of Object.entries(ALIASES)) for (const n of names) aliasOf.set(norm(n), field as keyof typeof ALIASES);

type Atom = { atom: string };
type Node = string | Atom | null | Node[];
type RawRecord = { source: string; target: Target | 'price'; fields: Map<string, Node>; fieldNames: string[] };

export type ObjectReport = { name: string; mode: 'catalog' | 'price-register' | 'structure' | 'skipped'; records?: number; fields?: string[] };
export type StructureReport = { name: string; records: number; fields: { name: string; kinds: string[] }[] };
export type DtExtract = {
  version: string;
  inflatedBytes: number;
  /** Every top-level object seen, in order. Skipped objects carry their name only. */
  objects: ObjectReport[];
  /** Where prices were found: "<object>.<field>" for item fields, "<register>" for price registers. */
  priceSources: string[];
  structure: StructureReport[];
  rows: ImportRow[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isAtom = (n: Node): n is Atom => !!n && typeof n === 'object' && !Array.isArray(n);
const scalar = (n: Node | undefined): string | null => typeof n === 'string' ? n : n && isAtom(n) ? n.atom : null;
function refOf(n: Node | undefined, depth = 0): string | null {
  const s = scalar(n);
  if (s !== null) return UUID.test(s) ? lower(s) : null;
  if (Array.isArray(n) && depth < 4) for (let i = n.length - 1; i >= 0; i--) { const r = refOf(n[i], depth + 1); if (r) return r; }
  return null;
}
const truthy = (n: Node | undefined) => ['1', 'true', 'истина', 'да', 'ha'].includes(lower(scalar(n) ?? ''));

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

type Section = { name: string | null; mode: 'pending' | 'catalog' | 'price' | 'structure' | 'skip'; target?: Target; records: number;
  fieldNames: Set<string>; structureFields: Map<string, Set<string>> };

class Extractor implements TokenSink {
  depth = 0;
  section: Section | null = null;
  stack: Node[][] = [];
  records: RawRecord[] = [];
  objects: ObjectReport[] = [];
  structure: StructureReport[] = [];
  private keyPending = false;

  want(): boolean {
    const s = this.section;
    if (!s) return false;
    if (this.depth === 1) return s.name === null;
    if (s.mode === 'catalog' || s.mode === 'price') return true;
    // Structure-only: decode the field name (first value of a pair at depth 3), never the value.
    return s.mode === 'structure' && this.depth === 3 && this.keyPending;
  }
  open(): void {
    this.depth++;
    if (this.depth === 1) { this.section = { name: null, mode: 'pending', records: 0, fieldNames: new Set(), structureFields: new Map() }; return; }
    const s = this.section!;
    if (this.depth === 2 && s.mode === 'pending') s.mode = 'skip'; // a record before any name: unknown object
    if (s.mode === 'skip') return;
    if (this.depth === 2) { s.records++; this.stack = [[]]; return; }
    if (this.stack.length) { const list: Node[] = []; this.stack[this.stack.length - 1]!.push(list); this.stack.push(list); }
    if (this.depth === 3) this.keyPending = true;
  }
  close(): void {
    const s = this.section!;
    if (this.depth === 1) { this.finishSection(s); this.section = null; }
    else if (s.mode !== 'skip' && this.stack.length) {
      const done = this.stack.pop()!;
      if (this.depth === 2) this.finishRecord(s, done);
    }
    if (this.depth === 3) this.keyPending = false;
    this.depth--;
  }
  string(value: string | null): void { this.value(value); }
  atom(value: string | null): void { this.value(value === null ? null : { atom: value }); }

  private value(v: Node): void {
    const s = this.section;
    if (!s) return;
    if (this.depth === 1) { if (s.name === null && typeof v === 'string') this.name(s, v); return; }
    if (s.mode === 'skip' || !this.stack.length) return;
    this.stack[this.stack.length - 1]!.push(v);
    if (this.depth === 3) this.keyPending = false;
  }
  private name(s: Section, full: string) {
    s.name = full;
    const m = /^(?:Справочник|Catalog)\.(.+)$/u.exec(full), r = /^(?:РегистрСведений|InformationRegister)\.(.+)$/u.exec(full);
    const catalog = m ? targetByName.get(lower(m[1]!)) : undefined;
    if (catalog) { s.mode = 'catalog'; s.target = catalog.target; s.name = catalog.name; }
    else if (m && structureByName.has(lower(m[1]!))) { s.mode = 'structure'; s.name = structureByName.get(lower(m[1]!))!; }
    else if (r && PRICE_REGISTER.test(r[1]!)) { s.mode = 'price'; s.name = full; }
    else s.mode = 'skip';
  }
  private finishRecord(s: Section, record: Node[]) {
    const fields = new Map<string, Node>(), names: string[] = [];
    for (const pair of record) {
      if (!Array.isArray(pair) || typeof pair[0] !== 'string') continue;
      const key = pair[0]; names.push(key); s.fieldNames.add(key);
      if (s.mode === 'structure') {
        // Values were never decoded; only their shape (string / atom / list) is known.
        const value = pair[1], kind = value === null ? 'value' : Array.isArray(value) ? 'list' : 'value';
        const set = s.structureFields.get(key) ?? new Set<string>(); set.add(kind); s.structureFields.set(key, set);
        continue;
      }
      fields.set(norm(key), pair.length > 2 ? pair.slice(1) : pair[1] ?? null);
    }
    if (s.mode === 'catalog') this.records.push({ source: s.name!, target: s.target!, fields, fieldNames: names });
    if (s.mode === 'price') this.records.push({ source: s.name!, target: 'price', fields, fieldNames: names });
  }
  private finishSection(s: Section) {
    if (s.name === null) return;
    if (s.mode === 'skip') { this.objects.push({ name: s.name, mode: 'skipped' }); return; }
    if (s.mode === 'structure') {
      this.structure.push({ name: s.name, records: s.records, fields: [...s.structureFields].map(([name, kinds]) => ({ name, kinds: [...kinds].sort() })) });
      this.objects.push({ name: s.name, mode: 'structure', records: s.records });
      return;
    }
    this.objects.push({ name: s.name, mode: s.mode === 'price' ? 'price-register' : 'catalog', records: s.records, fields: [...s.fieldNames] });
  }
}

function field(r: RawRecord, name: keyof typeof ALIASES): Node | undefined {
  for (const [key, value] of r.fields) if (aliasOf.get(key) === name) return value;
  return undefined;
}
function fieldName(r: RawRecord, name: keyof typeof ALIASES): string | null {
  return r.fieldNames.find(n => aliasOf.get(norm(n)) === name) ?? null;
}

/** Turns raw catalog records into import rows: resolves references by target object, maps names and prices. */
export function rowsFrom(records: RawRecord[]): { rows: ImportRow[]; priceSources: string[] } {
  const byRef = new Map<string, { target: Target; code: string }>();
  const codeOf = (r: RawRecord): string | null => {
    const code = scalar(field(r, 'code'))?.trim(), ref = refOf(field(r, 'ref'));
    return code ? `${r.source}/${code}` : ref ? `${r.source}/${ref}` : null;
  };
  for (const r of records) {
    if (r.target === 'price') continue;
    const ref = refOf(field(r, 'ref')), code = codeOf(r);
    if (ref && code) byRef.set(ref, { target: r.target, code });
  }
  const rows: ImportRow[] = [], priceSources = new Set<string>();
  for (const r of records) {
    const parents: { department?: string; group?: string; district?: string; service?: string } = {};
    const ownRef = refOf(field(r, 'ref'));
    for (const value of r.fields.values()) {
      const ref = refOf(value); if (!ref || ref === ownRef) continue;
      const hit = byRef.get(ref); if (!hit) continue;
      if (hit.target.object === 'department') parents.department ??= hit.code;
      else if (hit.target.object === 'serviceGroup') parents.group ??= hit.code;
      else if (hit.target.object === 'district') parents.district ??= hit.code;
      else if (hit.target.object === 'service') parents.service ??= hit.code;
    }
    if (r.target === 'price') {
      const priceText = scalar(field(r, 'price')), period = scalar(field(r, 'period'));
      const priced = priceText === null ? { rejected: 'BAD_PRICE' as const } : parsePrice(priceText);
      const effectiveFrom = period ? parsePeriod(period) : null;
      const rejected = !parents.service ? 'UNKNOWN_SERVICE' : 'rejected' in priced ? priced.rejected : !effectiveFrom ? 'NO_PRICE_DATE' : null;
      priceSources.add(r.source);
      rows.push({ object: 'price', source: r.source, service: parents.service ?? null, priceUzs: 'priceUzs' in priced ? priced.priceUzs : null,
        effectiveFrom, rejected });
      continue;
    }
    const cyrl = scalar(field(r, 'nameUzCyrl'))?.trim() || null, latn = scalar(field(r, 'nameUzLatn'))?.trim() || null, ru = scalar(field(r, 'nameRu'))?.trim() || null;
    const code = codeOf(r);
    const base = { source: r.source, code, nameUzCyrl: cyrl ?? ru ?? latn, nameUzLatn: latn, nameRu: ru, department: parents.department ?? null };
    let rejected: string | null = truthy(field(r, 'deleted')) ? 'DELETED' : truthy(field(r, 'folder')) ? 'FOLDER' : !base.nameUzCyrl ? 'NO_NAME' : !code ? 'NO_CODE' : null;
    const priceText = scalar(field(r, 'price'));
    let priceUzs: string | null = null;
    if (priceText !== null && priceText.trim() !== '') {
      priceSources.add(`${r.source}.${fieldName(r, 'price')}`);
      const p = parsePrice(priceText);
      if ('rejected' in p) rejected ??= p.rejected; else priceUzs = p.priceUzs;
    }
    const t = r.target;
    if (t.object === 'service') {
      const unit = scalar(field(r, 'unit'));
      rows.push({ ...base, object: 'service', group: parents.group ?? null, kind: t.kind === 'infer' ? inferKind(`${cyrl ?? ''} ${latn ?? ''} ${ru ?? ''}`) : t.kind,
        trackStock: t.trackStock, unit: unit && !UUID.test(unit) ? unit.slice(0, 40) : null, priceUzs, rejected });
    } else if (t.object === 'doctor') {
      const specialty = scalar(field(r, 'specialty'));
      rows.push({ ...base, object: 'doctor', specialty: specialty && !UUID.test(specialty) ? specialty : null, rejected });
    } else if (t.object === 'mahalla') {
      rows.push({ ...base, object: 'mahalla', district: parents.district ?? null, rejected: rejected ?? (parents.district ? null : 'NO_DISTRICT') });
    } else if (t.object === 'roomType') {
      rows.push({ ...base, object: 'roomType', rejected });
      // A room type with a price is a daily bed price: it becomes a service of kind bed.
      if (priceUzs !== null && !rejected) rows.push({ ...base, object: 'service', code: `${code}/bed`, kind: 'bed', priceUzs, rejected: null });
    } else {
      rows.push({ ...base, object: t.object, rejected });
    }
  }
  return { rows, priceSources: [...priceSources] };
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

/**
 * Reads a .dt stream and returns the catalog import rows plus a structure report. Throws DtError with a
 * clear code on a wrong file, a corrupt or truncated stream, or a layout this reader does not know.
 * Pure: writes nothing anywhere, so a failure can never leave partial data behind.
 */
export async function readDt(source: AsyncIterable<Uint8Array>, inflate: Inflater, options: ReadOptions = {}): Promise<DtExtract> {
  const maxBytes = options.maxInflatedBytes ?? 4 * 1024 ** 3, maxRecords = options.maxRecords ?? 200_000;
  let version = '';
  const sink = new Extractor(), tokens = new Tokenizer(sink);
  let inflated = 0;
  try {
    for await (const chunk of inflate(afterHeader(source, h => { version = checkHeader(h); }))) {
      inflated += chunk.length;
      if (inflated > maxBytes) throw new DtError('TOO_LARGE');
      tokens.push(chunk);
      if (sink.records.length > maxRecords) throw new DtError('TOO_LARGE');
    }
    if (!version) throw new DtError('NOT_A_DT');
    tokens.finish();
  } catch (error) {
    if (error instanceof DtError) throw error;
    if (error instanceof TokenError) throw new DtError(error.reason === 'TRUNCATED' ? 'TRUNCATED' : 'UNRECOGNIZED_LAYOUT');
    throw new DtError('CORRUPT'); // inflate failure: the deflate stream is damaged
  }
  if (!sink.objects.length) throw new DtError('UNRECOGNIZED_LAYOUT');
  const { rows, priceSources } = rowsFrom(sink.records);
  return { version, inflatedBytes: inflated, objects: sink.objects, priceSources, structure: sink.structure, rows };
}

export type LayoutProbe = {
  version: string; inflatedBytes: number; zeroByteShare: number; braces: { open: number; close: number }; quotes: number;
  /** Metadata object names found by byte pattern (e.g. "Справочник.МУОЛАЖА"), with first offset and count. */
  metadataNames: { name: string; encoding: 'utf16' | 'utf8'; firstOffset: number; count: number }[];
};
const META_PREFIXES = ['Справочник.', 'Документ.', 'РегистрСведений.', 'РегистрНакопления.', 'Перечисление.', 'Константа.'];

/**
 * Diagnostic for a dump the reader does not recognize. Reports byte statistics and metadata object names
 * found by searching for their known prefixes. It decodes nothing else, so it cannot print record values.
 */
export async function probeLayout(source: AsyncIterable<Uint8Array>, inflate: Inflater): Promise<LayoutProbe> {
  let version = '', inflated = 0, zeros = 0, open = 0, close = 0, quotes = 0;
  const found = new Map<string, LayoutProbe['metadataNames'][number]>();
  const patterns = META_PREFIXES.flatMap(p => [{ bytes: new TextEncoder().encode(p), encoding: 'utf8' as const },
    { bytes: Uint8Array.from([...p].flatMap(ch => [ch.charCodeAt(0) & 255, ch.charCodeAt(0) >> 8])), encoding: 'utf16' as const }]);
  let tail = new Uint8Array(0);
  try {
    for await (const chunk of inflate(afterHeader(source, h => { version = checkHeader(h); }))) {
      for (const b of chunk) { if (b === 0) zeros++; else if (b === 0x7b) open++; else if (b === 0x7d) close++; else if (b === 0x22) quotes++; }
      const data = new Uint8Array(tail.length + chunk.length); data.set(tail); data.set(chunk, tail.length);
      for (const p of patterns) for (let i = data.indexOf(p.bytes[0]!); i >= 0 && i + p.bytes.length <= data.length; i = data.indexOf(p.bytes[0]!, i + 1)) {
        if (!p.bytes.every((b, k) => data[i + k] === b)) continue;
        const rest = data.subarray(i + p.bytes.length, i + p.bytes.length + 128);
        const text = p.encoding === 'utf16' ? new TextDecoder('utf-16le').decode(rest.subarray(0, rest.length & ~1)) : new TextDecoder().decode(rest);
        const name = /^[\p{L}\d_]+/u.exec(text)?.[0];
        if (!name || name.length >= 60) continue;
        const full = new TextDecoder(p.encoding === 'utf16' ? 'utf-16le' : 'utf-8').decode(p.bytes) + name, keyName = `${p.encoding}:${full}`;
        const hit = found.get(keyName);
        if (hit) hit.count++; else found.set(keyName, { name: full, encoding: p.encoding, firstOffset: inflated - tail.length + i, count: 1 });
      }
      tail = data.slice(Math.max(0, data.length - 300));
      inflated += chunk.length;
    }
  } catch (error) {
    if (error instanceof DtError) throw error;
    throw new DtError('CORRUPT');
  }
  if (!version) throw new DtError('NOT_A_DT');
  return { version, inflatedBytes: inflated, zeroByteShare: inflated ? zeros / inflated : 0, braces: { open, close }, quotes, metadataNames: [...found.values()] };
}
