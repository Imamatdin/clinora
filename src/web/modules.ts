import { pharmacyModule } from './pharmacy/screen.js';
import { surgeryModule } from './surgery/screen.js';
import type { ComponentType } from 'react';
import type { ClinicMembershipView, CurrentDayView } from '../contracts/clinic.js';
import type { Role } from '../modules/identity/roles.js';
import type { Request } from './api.js';
import type { UiKey } from './i18n/index.js';
import { cashierModule } from './cashier/screen.js';
import { inpatientModule } from './inpatient/screen.js';
import { registrationModule } from './registration/screen.js';
import { catalogModule } from './catalog/screen.js';
import { doctorModule } from './doctor/screen.js';
import { labModule } from './lab/screen.js';
import { dashboardModule,exportModule } from './ceo/dashboard.js';
import { payrollModule } from './ceo/payroll.js';
import { reportsModule } from './reports/screen.js';

/** What the shell hands every feature screen. The server still authorizes every call. */
export type ModuleProps = {
  clinic: ClinicMembershipView; request: Request; day: CurrentDayView | null; myId: string; offlineDeviceId?: string | null;
  reportDayId?: string|null;
  /** Mark unsaved input so the shell asks before navigating away. */
  setDirty: (dirty: boolean) => void;
};
export type WebModule = {
  /** Stable id, unique across features, e.g. 'registration'. */
  id: string;
  /** Role home screens that show this module. Navigation only; never an authorization check. */
  roles: readonly Role[];
  /** Tab label. Use the matching 'module.*' key to replace its "coming soon" placeholder. */
  label: UiKey;
  Screen: ComponentType<ModuleProps>;
};

/**
 * Web module registry. Each feature keeps its screens in src/web/<feature>/ and adds one line here,
 * e.g. `registrationModule,` after importing it.
 */
export const MODULES: readonly WebModule[] = [
  // A role lands on its first module here: CEO on the dashboard, doctor on the queue, inpatient on the ward; lab last so the administrator keeps the cashier home.
  dashboardModule, doctorModule, cashierModule, pharmacyModule, inpatientModule, surgeryModule,
  registrationModule, catalogModule, labModule, reportsModule, payrollModule, exportModule,
];

/** Placeholders per role for increments not yet built (task 017: built features no longer show "coming soon"). */
export const PLANNED: Record<Role, UiKey[]> = {
  ceo: [], administrator: ['module.queueMonitor'], registrar: [], doctor: [], laboratory: [], cashier: [], inpatient: [], pharmacy: []
};

export const modulesFor = (role: Role, modules: readonly WebModule[] = MODULES) => modules.filter(m => m.roles.includes(role));
export const plannedFor = (role: Role, modules: readonly WebModule[] = MODULES) =>
  PLANNED[role].filter(key => !modulesFor(role, modules).some(m => m.label === key));
