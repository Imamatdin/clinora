import type { IncomingMessage } from 'node:http';
import { Id } from '../contracts/index.js';
import { DomainError } from '../modules/identity/access.js';
import type { Tx } from './database.js';
import { requireRole } from './roles.js';
import { registeredRoutes } from './routes/index.js';
import type { RouteResult } from './routes/types.js';

/** Every clinic route from task 003A onward, as registered by the feature route files. */
export const CLINIC_ROUTES = registeredRoutes();

/** Returns null when the path is not a clinic route, so the notebook router can handle it. */
export async function clinicRoute(tx: Tx, actorId: string, clinicId: string, rest: string, method: string, req: IncomingMessage,
  readBody: (req: IncomingMessage) => Promise<unknown>): Promise<RouteResult | null> {
  const candidates = CLINIC_ROUTES.filter(route => route.pattern.test(rest));
  if (!candidates.length) return null;
  const route = candidates.find(r => r.method === method);
  if (!route) throw new DomainError('NOT_FOUND');
  const params = route.pattern.exec(rest)!.slice(1);
  if (params.some(p => !Id.safeParse(p).success)) throw new DomainError('NOT_FOUND');
  const ctx = await requireRole(tx, actorId, clinicId, route.roles);
  return route.handle(ctx, params, () => readBody(req));
}
