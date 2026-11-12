import { deflateRawSync } from 'node:zlib';
import { DT_SIGNATURE } from './dt.js';

/*
 * Synthetic .dt generator for tests and demos. Produces the container (signature, version digit, raw
 * deflate) around the layout the reader assumes (see README.md). Every name and price is invented.
 * Real clinic dumps never enter git or CI.
 */

export type SynthValue = string | { atom: string } | { ref: string } | null;
export type SynthSection = { name: string; records: [string, SynthValue][][]; prefix?: SynthValue[] };
export type SynthOptions = { encoding?: 'utf16' | 'utf8' | 'mixed'; version?: string };

const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;

/** Inflated body. 'mixed' (default) writes Cyrillic strings as UTF-16LE and ASCII-only strings as single bytes. */
export function synthBody(sections: SynthSection[], options: SynthOptions = {}): Buffer {
  const encoding = options.encoding ?? 'mixed';
  const parts: Buffer[] = [];
  const raw = (s: string) => parts.push(encoding === 'utf16' ? Buffer.from(s, 'utf16le') : Buffer.from(s, 'latin1'));
  const str = (s: string) => {
    const wide = encoding === 'utf16' || (encoding === 'mixed' && /[^\x20-\x7e]/.test(s));
    parts.push(wide ? Buffer.from(quote(s), 'utf16le') : Buffer.from(quote(s), 'utf8'));
  };
  const value = (v: SynthValue) => {
    if (v === null) raw('');
    else if (typeof v === 'string') str(v);
    else if ('atom' in v) raw(v.atom);
    else { raw('{'); str('#'); raw(',00000000-0000-0000-0000-000000000000,'); raw(v.ref); raw('}'); }
  };
  for (const section of sections) {
    raw('{'); str(section.name);
    for (const p of section.prefix ?? []) { raw(','); value(p); }
    for (const record of section.records) {
      raw(',\r\n{');
      record.forEach(([key, v], i) => { if (i) raw(','); raw('{'); str(key); raw(','); value(v); raw('}'); });
      raw('}');
    }
    raw('}\r\n');
  }
  return Buffer.concat(parts);
}
export function synthDt(sections: SynthSection[], options: SynthOptions = {}): Buffer {
  return Buffer.concat([Buffer.from(DT_SIGNATURE + (options.version ?? '3'), 'latin1'), deflateRawSync(synthBody(sections, options))]);
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
    { name: 'Справочник.МИХИЛАР', records: [
      [['Ссылка', { ref: ref(10) }], ['Код', '001'], ['Наименование', 'Гастроэнтеролог Хизматлари'], ['Булим', { ref: ref(2) }]],
      [['Ссылка', { ref: ref(11) }], ['Код', '002'], ['Наименование', 'Нурланиш диагностикаси'], ['Булим', { ref: ref(1) }]]
    ] },
    { name: 'Справочник.МУОЛАЖА', records: [
      [['Ссылка', { ref: ref(20) }], ['Код', '10902002002000003'], ['Наименование', 'Нурланиш диагностика Ультратовуш текшируви (УТТ)'],
        ['НаименованиеЛат', 'Nurlanish diagnostika Ultratovush tadqiqoti (UZI)'], ['НаименованиеРус', 'Лучевая диагностика Ультразвуковое исследование (УЗИ)'],
        ['Михил', { ref: ref(11) }], ['Нархи', { atom: price.uzi }]],
      [['Ссылка', { ref: ref(21) }], ['Код', '10902002002000004'], ['Наименование', 'Гастроэнтеролог кўриги'], ['НаименованиеЛат', 'Gastroenterolog koʻrigi'],
        ['НаименованиеРус', 'Консультация гастроэнтеролога'], ['Михил', { ref: ref(10) }], ['Булим', { ref: ref(2) }], ['Нархи', { atom: price.consult }]],
      [['Ссылка', { ref: ref(22) }], ['Код', '10902002002000005'], ['Наименование', 'Ярим сўм'], ['Нархи', { atom: '1000.50' }]],
      [['Ссылка', { ref: ref(23) }], ['Код', '10902002002000006'], ['Наименование', ''], ['Нархи', { atom: '5000' }]],
      [['Ссылка', { ref: ref(24) }], ['Код', 'GRP'], ['Наименование', 'Папка'], ['ЭтоГруппа', { atom: '1' }]]
    ] },
    { name: 'Справочник.Анализ', records: [
      [['Ссылка', { ref: ref(30) }], ['Код', 'A01'], ['Наименование', 'Умумий қон таҳлили'], ['НаименованиеРус', 'Общий анализ крови']]
    ] },
    { name: 'Справочник.Дорилар', records: [
      [['Ссылка', { ref: ref(40) }], ['Код', 'D01'], ['Наименование', 'Парацетамол 500 мг'], ['ЕдиницаИзмерения', 'таблетка'], ['Цена', { atom: '3000' }]]
    ] },
    { name: 'Справочник.ВРАЧЛАР', records: [
      [['Ссылка', { ref: ref(50) }], ['Код', 'V01'], ['Наименование', 'Синтетик Шифокор Бир'], ['Мутахассислик', 'Гастроэнтеролог'], ['Булим', { ref: ref(2) }]]
    ] },
    { name: 'Справочник.Туман', records: [[['Ссылка', { ref: ref(60) }], ['Код', 'T1'], ['Наименование', 'Синтетик тумани']]] },
    { name: 'Справочник.МФЙ', records: [
      [['Ссылка', { ref: ref(61) }], ['Код', 'M1'], ['Наименование', 'Синтетик МФЙ'], ['Туман', { ref: ref(60) }]],
      [['Ссылка', { ref: ref(62) }], ['Код', 'M2'], ['Наименование', 'Етим МФЙ']]
    ] },
    { name: 'Справочник.ХоналарТипи', records: [[['Ссылка', { ref: ref(70) }], ['Код', 'X1'], ['Наименование', 'Умумий палата'], ['Нархи', { atom: '200000' }]]] },
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
