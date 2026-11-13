import { doctor } from '../i18n/doctor.uz-Cyrl.js';
import { doctorUzLatn } from '../i18n/doctor.uz-Latn.js';
import { doctorRu } from '../i18n/doctor.ru.js';

export type { Locale } from '../i18n/locale.js';
import type { Locale } from '../i18n/locale.js';
export type DoctorKey = keyof typeof doctor;
const dictionaries: Record<Locale, Record<DoctorKey, string>> = { 'uz-Cyrl': doctor, 'uz-Latn': doctorUzLatn, ru: doctorRu };
/** Unknown placeholders stay visible so a missing value is noticed, never silently blank. */
export const translator = (locale: Locale) => (key: DoctorKey, vars: Record<string, string | number> = {}) =>
  dictionaries[locale][key].replace(/\{(\w+)\}/g, (m, name: string) => name in vars ? String(vars[name]) : m);

/** Whole sums with thin-space thousands: 1 250 000. Money arrives as a decimal string and never passes through a float. */
export const money = (uzs: string) => uzs.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
