import { uzCyrl, type UiKey } from './uz-Cyrl.js';

export type { UiKey };
export type Locale = 'uz-Cyrl';
const dictionaries: Record<Locale, Record<UiKey, string>> = { 'uz-Cyrl': uzCyrl };
let locale: Locale = 'uz-Cyrl';
export const currentLocale = () => locale;
export const setLocale = (next: Locale) => { locale = next; document.documentElement.lang = next; };

/** Translate a dictionary key. Unknown placeholders stay visible so a missing value is noticed, never silently blank. */
export function t(key: UiKey, vars: Record<string, string | number> = {}): string {
  return dictionaries[locale][key].replace(/\{(\w+)\}/g, (match, name: string) => name in vars ? String(vars[name]) : match);
}
/** Error codes from the API map to dictionary entries; anything unexpected reads as "service unavailable". */
export function errorText(code: string): string {
  const key = `error.${code}` as UiKey;
  return key in dictionaries[locale] ? t(key) : t('error.SERVICE_UNAVAILABLE');
}
/** Business dates display as DD.MM.YYYY, the format used in Uzbek clinic paperwork. */
export const formatDate = (isoDate: string) => isoDate.split('-').reverse().join('.');
export const formatTime = (instant: string, timeZone: string) => new Intl.DateTimeFormat('uz-Cyrl', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone }).format(new Date(instant));
