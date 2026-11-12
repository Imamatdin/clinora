import * as l from '../../modules/lab/actions.js';
import { registerRoutes } from './registry.js';
import { parse, uuid } from './types.js';

/** Task 010 laboratory workspace. Reads: laboratory and managers. Writes: laboratory only. */
registerRoutes('lab', [
  { method: 'GET', pattern: /^lab\/orders$/, roles: l.LAB_READ, handle: async ctx => ({ body: await l.orders(ctx) }) },
  { method: 'GET', pattern: new RegExp(`^lab/orders/${uuid}$`), roles: l.LAB_READ, handle: async (ctx, [id]) => ({ body: await l.order(ctx, id!) }) },
  { method: 'POST', pattern: new RegExp(`^lab/orders/${uuid}/results$`), roles: l.LAB, handle: async (ctx, [id], b) => ({ status: 201, body: await l.enterResult(ctx, id!, parse(l.ResultInput, await b())) }) },
  { method: 'POST', pattern: new RegExp(`^lab/orders/${uuid}/confirm$`), roles: l.LAB, handle: async (ctx, [id], b) => ({ body: await l.confirm(ctx, id!, parse(l.ConfirmInput, await b())) }) }
]);
