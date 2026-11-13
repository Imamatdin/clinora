import type { UiKey } from './uz-Cyrl.js';
import { coreUzLatn } from './core.uz-Latn.js';
import { pharmacyUzLatn } from './pharmacy.uz-Latn.js';
import { surgeryUzLatn } from './surgery.uz-Latn.js';
import { accessUzLatn } from './access.uz-Latn.js';
import { assistantUzLatn } from './assistant.uz-Latn.js';
import { cashierUzLatn } from './cashier.uz-Latn.js';
import { inpatientUzLatn } from './inpatient.uz-Latn.js';
import { registrationUzLatn } from './registration.uz-Latn.js';
import { doctorUzLatn } from './doctor.uz-Latn.js';
import { labUzLatn } from './lab.uz-Latn.js';
import { ceoUzLatn } from './ceo.uz-Latn.js';
import { catalogUzLatn } from './catalog.uz-Latn.js';

/** uz-Latn dictionary: the same feature parts as ./uz-Cyrl.ts (each part is typed against its Cyrillic keys). */
export const UZ_LATN_PARTS = {
  core: coreUzLatn, pharmacy: pharmacyUzLatn, surgery: surgeryUzLatn, access: accessUzLatn, assistant: assistantUzLatn, cashier: cashierUzLatn,
  inpatient: inpatientUzLatn, registration: registrationUzLatn, doctor: doctorUzLatn, lab: labUzLatn, ceo: ceoUzLatn, catalog: catalogUzLatn,
} as const;
export const uzLatn = Object.assign({}, ...Object.values(UZ_LATN_PARTS)) as Record<UiKey, string>;
