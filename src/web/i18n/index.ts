import { uzCyrl, type UiKey } from './uz-Cyrl.js';
import { uzLatn } from './uz-Latn.js';
import { ru } from './ru.js';
import { currentLocale, intlLocale, type Locale } from './locale.js';

export type { UiKey, Locale };
export { adoptLocale, currentLocale, setLocale, useLocale, LOCALES, LOCALE_LABELS, intlLocale } from './locale.js';
export const DICTIONARIES: Record<Locale, Record<UiKey, string>> = { 'uz-Cyrl': uzCyrl, 'uz-Latn': uzLatn, ru };

/** Fill {placeholders}; unknown ones stay visible so a missing value is noticed, never silently blank. */
export const fill = (text: string, vars: Record<string, string | number> = {}) =>
  text.replace(/\{(\w+)\}/g, (match, name: string) => name in vars ? String(vars[name]) : match);
/** Translate a dictionary key in the current interface language. */
export function t(key: UiKey, vars: Record<string, string | number> = {}): string {
  return fill(DICTIONARIES[currentLocale()][key] ?? uzCyrl[key], vars);
}
/** Error codes from the API map to dictionary entries; anything unexpected reads as "service unavailable". */
export function errorText(code: string): string {
  const key = `error.${code}` as UiKey;
  return key in uzCyrl ? t(key) : t('error.SERVICE_UNAVAILABLE');
}
/** Business dates display as DD.MM.YYYY, the format used in Uzbek clinic paperwork. */
export const formatDate = (isoDate: string) => isoDate.split('-').reverse().join('.');
export const formatTime = (instant: string, timeZone: string) => new Intl.DateTimeFormat(intlLocale(), { hour: '2-digit', minute: '2-digit', hour12: false, timeZone }).format(new Date(instant));
