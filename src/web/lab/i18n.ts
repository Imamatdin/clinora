import { lab } from '../i18n/lab.uz-Cyrl.js';
import { labUzLatn } from '../i18n/lab.uz-Latn.js';
import { labRu } from '../i18n/lab.ru.js';
import type { Locale } from '../doctor/i18n.js';

export { languages, savedLocale, saveLocale, type Locale } from '../doctor/i18n.js';
export type LabKey = keyof typeof lab;
const dictionaries: Record<Locale, Record<LabKey, string>> = { 'uz-Cyrl': lab, 'uz-Latn': labUzLatn, ru: labRu };
export const translator = (locale: Locale) => (key: LabKey, vars: Record<string, string | number> = {}) =>
  dictionaries[locale][key].replace(/\{(\w+)\}/g, (m, name: string) => name in vars ? String(vars[name]) : m);
