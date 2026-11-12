import { deflateRawSync } from 'node:zlib';
import { DT_SIGNATURE } from './dt.js';

// Invented records serialized with the verified binary grammar, schema and metadata indirection.
export type SynthValue = string | { atom: string } | { ref: string } | null;
export type SynthSection = { name: string; records: [string, SynthValue][][]; prefix?: SynthValue[] };
export type SynthOptions = { encoding?: 'utf16' | 'utf8' | 'mixed'; version?: string };
type Value = string | number | Buffer | Value[];
export function binaryBody(values: Value[], encoding: SynthOptions['encoding'] = 'mixed'): Buffer {
  const parts: Buffer[] = [];
  const encode = (v: Value): void => {
    if (Array.isArray(v)) { parts.push(Buffer.from([0x40])); v.forEach((x, i) => { if (i) parts.push(Buffer.from([0x80])); encode(x); }); parts.push(Buffer.from([0x20])); }
    else if (typeof v === 'number') { const b = Buffer.alloc(5); b[0] = 0x0f; b.writeUInt32LE(v, 1); parts.push(b); }
    else {
      const wide = typeof v === 'string' && (encoding === 'utf16' || /[^\x20-\x7e]/.test(v));
      const b = Buffer.isBuffer(v) ? v : Buffer.from(v, wide ? 'utf16le' : 'ascii');
      const length = wide ? b.length / 2 : b.length;
      const header = Buffer.alloc(3); header[0] = wide ? 0x18 : 0x1b; header.writeUInt16LE(length, 1); parts.push(header, b);
    }
  };
  values.forEach(encode); return Buffer.concat(parts);
}
const uuid = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ALIAS: Record<string, string> = { 'Ссылка': 'ID', 'Код': 'Code', 'Наименование': 'Description', 'Parent': 'ParentID', 'ПометкаУдаления': 'Marked', 'ЭтоГруппа': 'Folder', 'Нархи': 'НАРХИ' };
export function synthBody(sections: SynthSection[], options: SynthOptions = {}): Buffer {
  const merged = new Map<string, SynthSection>();
  for (const s of sections) { const old = merged.get(s.name); if (old) old.records.push(...s.records); else merged.set(s.name, { ...s, records: [...s.records] }); }
  const descriptors: Value[] = [], tables: Value[] = [], configs: Value[] = [], dbnames: string[] = [];
  let fieldId = 500;
  for (const [index, section] of [...merged.values()].entries()) {
    const name = section.name.replace(/^Справочник\./, ''), id = uuid(index + 1), table = `Reference${index + 100}`;
    dbnames.push(`{${id},"Reference",${index + 100}}`);
    const keys = [...new Set(section.records.flatMap(r => r.map(([k]) => k)))];
    const physical = new Map<string, string>(); let config = `{0,0,${id}},"${name}"`;
    for (const key of keys) {
      const attr = ALIAS[key] ?? key;
      if (['ID','Code','Description','Folder','Marked','ParentID'].includes(attr)) physical.set(key, attr);
      else { const n = fieldId++, u = uuid(n); dbnames.push(`{${u},"Fld",${n}}`); physical.set(key, `Fld${n}`); config += `,{${u}},"${attr}",{1,"ru","${attr}"}`; }
    }
    const desc: Value[] = keys.map(k => [physical.get(k)!, 0, [0, [83]]]);
    desc.splice(1, 0, ['Version', 0, [0, [86]]]); // V field is deliberately absent from stored rows
    descriptors.push([table, 0, index + 100, 0, [desc.length, ...desc], [1, ['VT', 0, 0, 0, [0], [0], [0]]], [0]]);
    const data: Value[] = [section.records.length];
    for (const record of section.records) {
      const row: Value[] = [], fields = new Map(record);
      for (const key of keys) {
        const v = fields.get(key); if (v == null) { row.push(0); continue; }
        row.push(1);
        if (typeof v === 'string') row.push(v);
        else if ('ref' in v) row.push(Buffer.from(v.ref.replaceAll('-', ''), 'hex'));
        else row.push(key === 'ЭтоГруппа' ? (v.atom === '1' ? '0' : '1') : v.atom);
      }
      data.push(row);
    }
    tables.push(data, [0]);
    const compressed = deflateRawSync(Buffer.from(config)), mid = Math.floor(compressed.length / 2);
    configs.push([0, Buffer.from(id), 0, 0, 0, 0, 0, 0, 0, 0, 0, [compressed.subarray(0, mid), compressed.subarray(mid)]]);
  }
  const entry: Value[] = [0, Buffer.from('DBNames'), 0, 0, 0, 0, 0, 0, 0, 0, 0, deflateRawSync(Buffer.from(dbnames.join(',')))];
  return binaryBody([['CompatibilityMode', 0], ['Folder', Buffer.from('Config'), configs], ['Folder', Buffer.from('Params'), [entry]], ['DataBase', [['0', [descriptors.length, ...descriptors]], ...tables]]], options.encoding);
}
export function synthDt(sections: SynthSection[], options: SynthOptions = {}): Buffer {
  return Buffer.concat([Buffer.from(DT_SIGNATURE + (options.version ?? '3')), deflateRawSync(synthBody(sections, options))]);
}

const ref = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const SYNTH_REF = ref;

/**
 * A small invented clinic: two departments, two service groups, services with prices in three
 * languages, lab tests, medicines, a price register, address lists, plus patient and document
 * objects filled with marker text that must never appear in the reader's output.
 */
export const PATIENT_MARKER = 'SYNTHPATIENTMARKER';
export function sampleSections(price = { uzi: '150000.00', consult: '100000' }): SynthSection[] {
  return [
    { name: 'Справочник.БЕМОРЛАР', prefix: [{ atom: '2' }], records: [
      [['Ссылка', { ref: ref(900) }], ['Код', '000001'], ['Наименование', `Бемор ${PATIENT_MARKER} Синтетик`], ['Телефон', { atom: '998901234567' }]],
      [['Ссылка', { ref: ref(901) }], ['Код', '000002'], ['Наименование', `${PATIENT_MARKER} Иккинчи`], ['Манзил', `маҳалла ${PATIENT_MARKER}`]]
    ] },
    { name: 'Справочник.БУЛИМ', records: [
      [['Ссылка', { ref: ref(1) }], ['Код', '01'], ['Наименование', 'Диагностика бўлими'], ['НаименованиеЛат', 'Diagnostika boʻlimi'], ['НаименованиеРус', 'Отделение диагностики']],
      [['Ссылка', { ref: ref(2) }], ['Код', '02'], ['Наименование', 'Терапия бўлими'], ['ПометкаУдаления', { atom: '0' }]]
    ] },
    { name: 'Справочник.Анализ', records: [
      [['Ссылка', { ref: ref(10) }], ['Код', '001'], ['Наименование', 'Гастроэнтеролог Хизматлари'], ['Булим', { ref: ref(2) }], ['Folder', { atom: '0' }]],
      [['Ссылка', { ref: ref(11) }], ['Код', '002'], ['Наименование', 'Нурланиш диагностикаси'], ['Булим', { ref: ref(1) }], ['Folder', { atom: '0' }]]
    ] },
    { name: 'Справочник.МУОЛАЖА', records: [
      [['Ссылка', { ref: ref(20) }], ['Код', '10902002002000003'], ['Наименование', 'Нурланиш диагностика Ультратовуш текшируви (УТТ)'],
        ['НаименованиеЛат', 'Nurlanish diagnostika Ultratovush tadqiqoti (UZI)'], ['НаименованиеРус', 'Лучевая диагностика Ультразвуковое исследование (УЗИ)'],
        ['МИХИ', '10902002002000003'], ['Булим', { ref: ref(1) }], ['Нархи', { atom: price.uzi }]],
      [['Ссылка', { ref: ref(21) }], ['Код', '10902002002000004'], ['Наименование', 'Гастроэнтеролог кўриги'], ['НаименованиеЛат', 'Gastroenterolog koʻrigi'],
        ['НаименованиеРус', 'Консультация гастроэнтеролога'], ['Булим', { ref: ref(2) }], ['Нархи', { atom: price.consult }]],
      [['Ссылка', { ref: ref(22) }], ['Код', '10902002002000005'], ['Наименование', 'Ярим сўм'], ['Нархи', { atom: '1000.50' }]],
      [['Ссылка', { ref: ref(23) }], ['Код', '10902002002000006'], ['Наименование', ''], ['Нархи', { atom: '5000' }]],
      [['Ссылка', { ref: ref(24) }], ['Код', 'GRP'], ['Наименование', 'Папка'], ['ЭтоГруппа', { atom: '1' }]]
    ] },
    { name: 'Справочник.Анализ', records: [
      [['Ссылка', { ref: ref(30) }], ['Код', 'A01'], ['Наименование', 'Умумий қон таҳлили'], ['НаименованиеРус', 'Общий анализ крови'], ['Норма', '4–9'], ['Цена', { atom: '45000' }], ['Parent', { ref: ref(10) }]]
    ] },
    { name: 'Справочник.Дорилар', records: [
      [['Ссылка', { ref: ref(40) }], ['Код', 'D01'], ['Наименование', 'Парацетамол 500 мг'], ['ЕдиницаИзмерения', 'таблетка'], ['Цена', { atom: '3000' }]]
    ] },
    { name: 'Справочник.ВРАЧЛАР', records: [
      [['Ссылка', { ref: ref(50) }], ['Код', 'V01'], ['Наименование', 'Синтетик Шифокор Бир'], ['Кабул', { atom: '1' }], ['ПАРОЛ', 'STAFFSECRET'], ['Телефон', '998901234567'], ['Булим', { ref: ref(2) }]]
    ] },
    { name: 'Справочник.Туман', records: [[['Ссылка', { ref: ref(60) }], ['Код', 'T1'], ['Наименование', 'Синтетик тумани']]] },
    { name: 'Справочник.МФЙ', records: [
      [['Ссылка', { ref: ref(61) }], ['Код', 'M1'], ['Наименование', 'Синтетик МФЙ'], ['Туман', { ref: ref(60) }]],
      [['Ссылка', { ref: ref(62) }], ['Код', 'M2'], ['Наименование', 'Етим МФЙ']]
    ] },
    { name: 'Справочник.ХоналарТипи', records: [[['Ссылка', { ref: ref(70) }], ['Код', 'X1'], ['Наименование', 'Умумий палата'], ['КунликЁтокПули', { atom: '200000' }]]] },
    { name: 'Справочник.Каровчи', records: [[['Ссылка', { ref: ref(80) }], ['Наименование', `Қаровчи ${PATIENT_MARKER}`], ['Бемор', { ref: ref(900) }]]] },
    { name: 'Справочник.Мумкун', records: [[['Ссылка', { ref: ref(81) }], ['Наименование', 'Ҳа']]] },
    { name: 'РегистрСведений.Нархлар', records: [
      [['Период', { atom: '20260101000000' }], ['Хизмат', { ref: ref(30) }], ['Нархи', { atom: '45000' }]],
      [['Период', { atom: '20260101000000' }], ['Хизмат', { ref: ref(999) }], ['Нархи', { atom: '1' }]]
    ] },
    { name: 'Документ.КАБУЛ', records: [[['Ссылка', { ref: ref(950) }], ['Бемор', { ref: ref(900) }], ['Изоҳ', `шикоят ${PATIENT_MARKER}`], ['Сумма', { atom: '777777' }]]] },
    { name: 'РегистрНакопления.БЕМОР', records: [[['Бемор', { ref: ref(900) }], ['Сумма', { atom: '777777' }], ['Изоҳ', PATIENT_MARKER]]] }
  ];
}
