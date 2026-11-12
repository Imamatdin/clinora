/**
 * Clinic route registry. Each feature keeps its routes in src/server/routes/<feature>.ts, calls
 * registerRoutes('<feature>', [...]) there, and adds exactly one import line below.
 */
import './core.js';
import './access.js';

export { registeredRoutes } from './registry.js';
export type { Route } from './types.js';
