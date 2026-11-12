import { assistant, type AssistantKey } from '../i18n/assistant.uz-Cyrl.js';
import { assistantUzLatn } from '../i18n/assistant.uz-Latn.js';
import { assistantRu } from '../i18n/assistant.ru.js';

/**
 * The assistant's strings live in the shared i18n registry (src/web/i18n/assistant.*.ts; uz-Cyrl is merged
 * into the shell dictionary). The shell renders uz-Cyrl only today, so the panel keeps a per-viewer choice
 * of the three shipped languages over those same dictionaries. Keys here are relative to 'assistant.'.
 */
export type AKey = AssistantKey extends `assistant.${infer K}` ? K : never;
export type ALocale = 'uz-Cyrl' | 'uz-Latn' | 'ru';
const dictionaries: Record<ALocale, Record<AssistantKey, string>> = { 'uz-Cyrl': assistant, 'uz-Latn': assistantUzLatn, ru: assistantRu };
/** Language buttons show each language's own short name. */
export const LOCALES: { id: ALocale; label: string }[] = [{ id: 'uz-Cyrl', label: 'Ўзб' }, { id: 'uz-Latn', label: 'Oʻzb' }, { id: 'ru', label: 'Рус' }];
export function translator(locale: ALocale) {
  return (key: AKey, vars: Record<string, string | number> = {}) =>
    dictionaries[locale][`assistant.${key}` as AssistantKey].replace(/\{(\w+)\}/g, (m, n: string) => n in vars ? String(vars[n]) : m);
}
export const labKey = (locale: ALocale) => locale === 'uz-Cyrl' ? 'uzCyrl' : locale === 'uz-Latn' ? 'uzLatn' : 'ru';
