import { pharmacy } from './pharmacy.uz-Cyrl.js';
import { surgery } from './surgery.uz-Cyrl.js';
import { core } from './core.uz-Cyrl.js';
import { access } from './access.uz-Cyrl.js';
import { assistant } from './assistant.uz-Cyrl.js';
import { cashier } from './cashier.uz-Cyrl.js';

/**
 * Uzbek (Cyrillic) dictionary, merged from per-feature parts. Each feature keeps its strings in
 * ./<feature>.uz-Cyrl.ts, exports them under the feature name with keys prefixed '<feature>.',
 * and adds one entry here (import + name). tests/i18n.test.ts rejects key collisions and unprefixed keys.
 * Uzbek Latin and Russian dictionaries must provide the same keys (typed by UiKey).
 */
export const UZ_CYRL_PARTS = {
  core,
  pharmacy, surgery,
  access,
  assistant,
  cashier,
} as const;

type Parts = typeof UZ_CYRL_PARTS;
type Merged<U> = (U extends unknown ? (k: U) => void : never) extends (k: infer I) => void ? I : never;
export type UzCyrlDictionary = Merged<Parts[keyof Parts]>;
export type UiKey = keyof UzCyrlDictionary & string;
export const uzCyrl = Object.assign({}, ...Object.values(UZ_CYRL_PARTS)) as UzCyrlDictionary;
