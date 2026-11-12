import type { IncomingMessage } from 'node:http';
import type { z } from 'zod';
import { EmptyInput, StaffCreateInput, StaffRolesInput, StaffStatusInput } from '../contracts/clinic.js';
import { Id } from '../contracts/index.js';
import { DomainError } from '../modules/identity/access.js';
import { MANAGERS, ROLES, type Role } from '../modules/identity/roles.js';
import { changeRoles, createStaff, listStaff, resetPassword, setStatus } from '../modules/staff/actions.js';
import { closeDay, currentDay, openDay } from '../modules/business-days/actions.js';
import type { Tx } from './database.js';
import { requireRole, type ClinicContext } from './roles.js';

type Body = () => Promise<unknown>;
type Route = {
  method: 'GET' | 'POST'; pattern: RegExp; roles: readonly Role[];
  handle: (ctx: ClinicContext, params: string[], body: Body) => Promise<{ status?: number; body: unknown }>
};
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value); if (!result.success) throw new DomainError('INVALID_INPUT'); return result.data;
};
const uuid = '([0-9a-fA-F-]{36})';

/**
 * Every clinic route added from task 003A onward. Each declares its roles; requireRole runs
 * before the body is read, so an unauthorized caller learns nothing from validation errors.
 */
export const CLINIC_ROUTES: Route[] = [
  { method: 'GET', pattern: /^business-days\/current$/, roles: ROLES, handle: async ctx => ({ body: await currentDay(ctx) }) },
  { method: 'POST', pattern: /^business-days\/open$/, roles: MANAGERS,
    handle: async (ctx, _p, body) => { parse(EmptyInput, await body()); return { status: 201, body: await openDay(ctx) }; } },
  { method: 'POST', pattern: new RegExp(`^business-days/${uuid}/close$`), roles: MANAGERS,
    handle: async (ctx, [day], body) => { parse(EmptyInput, await body()); return { body: await closeDay(ctx, day!) }; } },
  { method: 'GET', pattern: /^staff$/, roles: MANAGERS, handle: async ctx => ({ body: await listStaff(ctx) }) },
  { method: 'POST', pattern: /^staff$/, roles: MANAGERS,
    handle: async (ctx, _p, body) => ({ status: 201, body: await createStaff(ctx, parse(StaffCreateInput, await body())) }) },
  { method: 'POST', pattern: new RegExp(`^staff/${uuid}/roles$`), roles: MANAGERS,
    handle: async (ctx, [user], body) => ({ body: await changeRoles(ctx, user!, parse(StaffRolesInput, await body())) }) },
  { method: 'POST', pattern: new RegExp(`^staff/${uuid}/status$`), roles: MANAGERS,
    handle: async (ctx, [user], body) => ({ body: await setStatus(ctx, user!, parse(StaffStatusInput, await body())) }) },
  { method: 'POST', pattern: new RegExp(`^staff/${uuid}/password-reset$`), roles: MANAGERS,
    handle: async (ctx, [user], body) => { parse(EmptyInput, await body()); return { body: await resetPassword(ctx, user!) }; } }
];

/** Returns null when the path is not a clinic route, so the notebook router can handle it. */
export async function clinicRoute(tx: Tx, actorId: string, clinicId: string, rest: string, method: string, req: IncomingMessage,
  readBody: (req: IncomingMessage) => Promise<unknown>): Promise<{ status?: number; body: unknown } | null> {
  const candidates = CLINIC_ROUTES.filter(route => route.pattern.test(rest));
  if (!candidates.length) return null;
  const route = candidates.find(r => r.method === method);
  if (!route) throw new DomainError('NOT_FOUND');
  const params = route.pattern.exec(rest)!.slice(1);
  if (params.some(p => !Id.safeParse(p).success)) throw new DomainError('NOT_FOUND');
  const ctx = await requireRole(tx, actorId, clinicId, route.roles);
  return route.handle(ctx, params, () => readBody(req));
}
