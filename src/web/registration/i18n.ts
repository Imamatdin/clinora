import { registration } from '../i18n/registration.uz-Cyrl.js';
import { registrationUzLatn } from '../i18n/registration.uz-Latn.js';
import { registrationRu } from '../i18n/registration.ru.js';

export type Locale = 'uz-Cyrl' | 'uz-Latn' | 'ru';
export type RegistrationKey = keyof typeof registration;
export const languages: { id: Locale; label: string }[] = [{ id: 'uz-Cyrl', label: 'Ўзб' }, { id: 'uz-Latn', label: 'Oʻzb' }, { id: 'ru', label: 'Рус' }];
const dictionaries: Record<Locale, Record<RegistrationKey, string>> = { 'uz-Cyrl': registration, 'uz-Latn': registrationUzLatn, ru: registrationRu };
export const translator = (locale: Locale) => (key: RegistrationKey, vars: Record<string, string | number> = {}) =>
  dictionaries[locale][key].replace(/\{(\w+)\}/g, (match, name: string) => name in vars ? String(vars[name]) : match);
export type Names = { uzCyrl: string; uzLatn: string | null; ru: string | null };
/** Catalog names in the chosen language, falling back to Uzbek Cyrillic (the only required name). */
export const pickName = (n: Names, locale: Locale) => (locale === 'ru' ? n.ru : locale === 'uz-Latn' ? n.uzLatn : null) ?? n.uzCyrl;
