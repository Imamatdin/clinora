import * as r from '../../modules/registration/actions.js';
import { ticketsHtml } from '../../modules/registration/ticket.js';
import { registerRoutes } from './registry.js';
import { parse, uuid } from './types.js';

/** Task 007 routes. requireRole runs before the body is read; each action rechecks its own roles. */
registerRoutes('registration', [
  { method: 'POST', pattern: /^registration\/offline$/, roles: r.REGISTRARS,
    handle: async (ctx, _p, body) => ({ status: 201, body: await r.syncRegistration(ctx, parse(r.OfflineInput, await body())) }) },
  { method: 'GET', pattern: /^registration\/options$/, roles: r.REGISTRARS, handle: async ctx => ({ body: await r.options(ctx) }) },
  { method: 'POST', pattern: /^registration\/search$/, roles: r.REGISTRARS,
    handle: async (ctx, _p, body) => ({ body: await r.search(ctx, parse(r.SearchInput, await body())) }) },
  { method: 'POST', pattern: /^registration\/duplicates$/, roles: r.REGISTRARS,
    handle: async (ctx, _p, body) => ({ body: await r.duplicates(ctx, parse(r.DuplicateInput, await body())) }) },
  { method: 'POST', pattern: /^registration\/patients$/, roles: r.REGISTRARS,
    handle: async (ctx, _p, body) => ({ status: 201, body: await r.registerPatient(ctx, parse(r.PatientInput, await body())) }) },
  { method: 'GET', pattern: new RegExp(`^registration/patients/${uuid}$`), roles: r.REGISTRARS, handle: async (ctx, [id]) => ({ body: await r.patient(ctx, id!) }) },
  { method: 'POST', pattern: new RegExp(`^registration/patients/${uuid}$`), roles: r.REGISTRARS,
    handle: async (ctx, [id], body) => ({ body: await r.updatePatient(ctx, id!, parse(r.PatientUpdateInput, await body())) }) },
  { method: 'POST', pattern: /^registration\/visits$/, roles: r.REGISTRARS,
    handle: async (ctx, _p, body) => ({ status: 201, body: await r.createVisit(ctx, parse(r.VisitInput, await body())) }) },
  { method: 'GET', pattern: new RegExp(`^registration/visits/${uuid}/tickets$`), roles: r.REGISTRARS,
    handle: async (ctx, [id]) => ({ html: await ticketsHtml(ctx, id!) }) },
  { method: 'GET', pattern: /^queue\/mine$/, roles: ['doctor'], handle: async ctx => ({ body: await r.myQueue(ctx) }) },
  { method: 'POST', pattern: /^queue\/call-next$/, roles: r.QUEUE_ROLES,
    handle: async (ctx, _p, body) => ({ body: await r.callNext(ctx, parse(r.CallNextInput, await body())) }) },
  { method: 'POST', pattern: new RegExp(`^queue/tickets/${uuid}/status$`), roles: r.QUEUE_ROLES,
    handle: async (ctx, [id], body) => ({ body: await r.setTicketStatus(ctx, id!, parse(r.TicketStatusInput, await body())) }) }
]);
