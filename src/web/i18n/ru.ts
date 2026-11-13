import type { UiKey } from './uz-Cyrl.js';
import { coreRu } from './core.ru.js';
import { pharmacyRu } from './pharmacy.ru.js';
import { surgeryRu } from './surgery.ru.js';
import { accessRu } from './access.ru.js';
import { assistantRu } from './assistant.ru.js';
import { cashierRu } from './cashier.ru.js';
import { inpatientRu } from './inpatient.ru.js';
import { registrationRu } from './registration.ru.js';
import { doctorRu } from './doctor.ru.js';
import { labRu } from './lab.ru.js';
import { ceoRu } from './ceo.ru.js';
import { catalogRu } from './catalog.ru.js';
import { helpRu } from './help.ru.js';

/** ru dictionary: the same feature parts as ./uz-Cyrl.ts (each part is typed against its Cyrillic keys). */
export const RU_PARTS = {
  core: coreRu, pharmacy: pharmacyRu, surgery: surgeryRu, access: accessRu, assistant: assistantRu, cashier: cashierRu,
  inpatient: inpatientRu, registration: registrationRu, doctor: doctorRu, lab: labRu, ceo: ceoRu, catalog: catalogRu, help: helpRu,
} as const;
export const ru = Object.assign({}, ...Object.values(RU_PARTS)) as Record<UiKey, string>;
