/**
 * Clinic route registry. Each feature keeps its routes in src/server/routes/<feature>.ts, calls
 * registerRoutes('<feature>', [...]) there, and adds exactly one import line below.
 */
import './core.js';
import './access.js';
import './assistant.js';
import './cashier.js';
import './reports.js';
import './payroll.js';
import './inpatient.js';

export { registeredRoutes } from './registry.js';
export type { Route } from './types.js';

import './pharmacy.js';
import './surgery.js';
import './registration.js';
import './catalog.js';
import './doctor.js';
import './lab.js';
