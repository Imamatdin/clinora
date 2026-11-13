import { useSyncExternalStore } from 'react';

/**
 * One interface language for the whole app (task 017). Every screen reads it from here, so the header switch
 * changes every module at once. The choice is a per-device convenience (storage may be unavailable in a private
 * window or Telegram); it never affects what the server returns. Default: Uzbek Cyrillic.
 */
export type Locale = 'uz-Cyrl' | 'uz-Latn' | 'ru';
export const LOCALES: readonly Locale[] = ['uz-Cyrl', 'uz-Latn', 'ru'];
/** Each language's own short name, shown on the switch buttons (never translated). */
export const LOCALE_LABELS: Record<Locale, string> = { 'uz-Cyrl': 'Ўзб', 'uz-Latn': 'Oʻzb', ru: 'Рус' };
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
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
/** Re-renders the caller when the language changes. */
export const useLocale = (): Locale => useSyncExternalStore(subscribe, currentLocale, currentLocale);
/** Intl locale for numbers and dates in the current language. */
export const intlLocale = (l: Locale = current) => l === 'ru' ? 'ru-RU' : l === 'uz-Latn' ? 'uz-Latn-UZ' : 'uz-Cyrl-UZ';
