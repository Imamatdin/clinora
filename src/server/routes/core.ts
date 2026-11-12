import { EmptyInput, StaffCreateInput, StaffRolesInput, StaffStatusInput } from '../../contracts/clinic.js';
import { MANAGERS, ROLES } from '../../modules/identity/roles.js';
import { changeRoles, createStaff, listStaff, resetPassword, setStatus } from '../../modules/staff/actions.js';
import { closeDay, currentDay, openDay } from '../../modules/business-days/actions.js';
import { registerRoutes } from './registry.js';
import { parse, uuid } from './types.js';

/** Task 003A routes: business days and staff management. requireRole runs before the body is read. */
registerRoutes('core', [
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
]);
