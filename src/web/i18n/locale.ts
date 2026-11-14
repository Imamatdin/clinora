import { useSyncExternalStore } from 'react';

/**
 * One interface language for the whole app (task 017). Every screen reads it from here, so the header switch
 * changes every module at once. After sign-in the language follows the person: their account's saved language,
 * else the clinic's default (task 028, see adoptLocale). The copy in this browser only decides what the sign-in
 * screen shows before anyone is known; it never affects what the server returns. Default: Uzbek Cyrillic.
 */
export type Locale = 'uz-Cyrl' | 'uz-Latn' | 'ru';
export const LOCALES: readonly Locale[] = ['uz-Cyrl', 'uz-Latn', 'ru'];
/** Each language's own name, shown on the language choice (never translated). */
export const LOCALE_LABELS: Record<Locale, string> = { 'uz-Cyrl': 'Ўзбекча', 'uz-Latn': 'Oʻzbekcha', ru: 'Русский' };
const STORAGE_KEY = 'clinora.locale';

function saved(): Locale {
  try { const v = globalThis.localStorage?.getItem(STORAGE_KEY); return v === 'uz-Latn' || v === 'ru' ? v : 'uz-Cyrl'; } catch { return 'uz-Cyrl'; }
}
let current: Locale = saved();
const listeners = new Set<() => void>();

export const currentLocale = (): Locale => current;
export function setLocale(next: Locale) {
  current = next;
  if (typeof document !== 'undefined') document.documentElement.lang = next;
  try { globalThis.localStorage?.setItem(STORAGE_KEY, next); } catch { /* not persisted */ }
  for (const fn of [...listeners]) fn();
}
/** After sign-in: the account's language wins; without one, a choice made in this browser, else the clinic's default. */
export function adoptLocale(account: Locale | null | undefined, clinicDefault: Locale | undefined) {
  let stored: string | null = null;
  try { stored = globalThis.localStorage?.getItem(STORAGE_KEY) ?? null; } catch { /* no storage */ }
  const next = account ?? (LOCALES.includes(stored as Locale) ? stored as Locale : clinicDefault ?? 'uz-Cyrl');
  if (next !== current) setLocale(next);
}
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
/** Re-renders the caller when the language changes. */
export const useLocale = (): Locale => useSyncExternalStore(subscribe, currentLocale, currentLocale);
/** Intl locale for numbers and dates in the current language. */
export const intlLocale = (l: Locale = current) => l === 'ru' ? 'ru-RU' : l === 'uz-Latn' ? 'uz-Latn-UZ' : 'uz-Cyrl-UZ';
