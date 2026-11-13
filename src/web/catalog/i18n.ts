import { catalogUzCyrl } from '../i18n/catalog.uz-Cyrl.js';
import { catalogUzLatn } from '../i18n/catalog.uz-Latn.js';
import { catalogRu } from '../i18n/catalog.ru.js';

import type { Locale } from '../i18n/locale.js';
export type { Locale };
export type CatalogKey = keyof typeof catalogUzCyrl;
const dictionaries: Record<Locale, Record<CatalogKey, string>> = { 'uz-Cyrl': catalogUzCyrl, 'uz-Latn': catalogUzLatn, ru: catalogRu };
export const translator = (locale: Locale) => (key: CatalogKey, vars: Record<string, string | number> = {}) =>
  dictionaries[locale][key].replace(/\{(\w+)\}/g, (match, name: string) => name in vars ? String(vars[name]) : match);
export const hasKey = (key: string): key is CatalogKey => key in catalogUzCyrl;
export type Names = { uzCyrl: string | null; uzLatn: string | null; ru: string | null };
/** Catalog names in the chosen language, falling back to Uzbek Cyrillic (the only required name). */
export const pickName = (n: Names, locale: Locale) => (locale === 'ru' ? n.ru : locale === 'uz-Latn' ? n.uzLatn : null) ?? n.uzCyrl ?? n.ru ?? n.uzLatn ?? '';
