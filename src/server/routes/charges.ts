import * as ch from '../../modules/charges/actions.js';
import { registerRoutes } from './registry.js';
import { parse, uuid } from './types.js';

/** Task 023: cancelling unperformed charge lines and no-shows at day close. Actions recheck roles and ownership. */
registerRoutes('charges', [
  { method: 'POST', pattern: new RegExp(`^charges/${uuid}/cancel$`), roles: ch.CANCELLERS,
    handle: async (ctx, [id], body) => ({ body: await ch.cancelLine(ctx, id!, parse(ch.CancelInput, await body())) }) },
  { method: 'GET', pattern: new RegExp(`^business-days/${uuid}/no-show$`), roles: ['ceo', 'administrator'],
    handle: async (ctx, [day]) => ({ body: await ch.noShowCandidates(ctx, day!) }) },
  { method: 'POST', pattern: new RegExp(`^business-days/${uuid}/no-show$`), roles: ['ceo', 'administrator'],
    handle: async (ctx, [day], body) => ({ body: await ch.markNoShow(ctx, day!, parse(ch.NoShowInput, await body())) }) }
]);
