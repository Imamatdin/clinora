import * as c from '../../modules/catalog/actions.js';
import { CATALOG_READERS, CATALOG_WRITERS } from '../../modules/catalog/shared.js';
import * as i from '../../modules/import1c/actions.js';
import { registerRoutes } from './registry.js';
import { parse, uuid } from './types.js';

/** Task 005 routes. requireRole runs before the body is read; each action rechecks its own roles. */
registerRoutes('catalog', [
  { method: 'GET', pattern: /^catalog\/options$/, roles: CATALOG_READERS, handle: async ctx => ({ body: await c.options(ctx) }) },
  { method: 'POST', pattern: /^catalog\/search$/, roles: CATALOG_READERS,
    handle: async (ctx, _p, body) => ({ body: await c.search(ctx, parse(c.SearchInput, await body())) }) },
  { method: 'POST', pattern: /^catalog\/items$/, roles: CATALOG_WRITERS,
    handle: async (ctx, _p, body) => ({ body: await c.save(ctx, parse(c.SaveInput, await body())) }) },
  { method: 'POST', pattern: /^catalog\/active$/, roles: CATALOG_WRITERS,
    handle: async (ctx, _p, body) => ({ body: await c.setActive(ctx, parse(c.ActiveInput, await body())) }) },
  { method: 'POST', pattern: /^catalog\/prices$/, roles: CATALOG_WRITERS,
    handle: async (ctx, _p, body) => ({ status: 201, body: await c.setPrice(ctx, parse(c.PriceInput, await body())) }) },
  { method: 'GET', pattern: new RegExp(`^catalog/services/${uuid}/prices$`), roles: CATALOG_READERS, handle: async (ctx, [id]) => ({ body: await c.priceHistory(ctx, id!) }) },
  { method: 'POST', pattern: /^catalog\/doctor-link$/, roles: CATALOG_WRITERS,
    handle: async (ctx, _p, body) => ({ body: await c.linkDoctor(ctx, parse(c.LinkDoctorInput, await body())) }) },
  { method: 'POST', pattern: /^catalog\/doctor-services$/, roles: CATALOG_WRITERS,
    handle: async (ctx, _p, body) => ({ body: await c.setDoctorServices(ctx, parse(c.DoctorServicesInput, await body())) }) },
  { method: 'GET', pattern: /^catalog\/imports$/, roles: i.IMPORTERS, handle: async ctx => ({ body: await i.recentBatches(ctx) }) },
  { method: 'POST', pattern: /^catalog\/imports$/, roles: i.IMPORTERS,
    handle: async (ctx, _p, body) => ({ status: 201, body: await i.createBatch(ctx, parse(i.BatchInput, await body())) }) },
  { method: 'GET', pattern: new RegExp(`^catalog/imports/${uuid}$`), roles: i.IMPORTERS, handle: async (ctx, [id]) => ({ body: await i.preview(ctx, id!) }) },
  { method: 'POST', pattern: new RegExp(`^catalog/imports/${uuid}/rows$`), roles: i.IMPORTERS,
    handle: async (ctx, [id], body) => ({ body: await i.addRows(ctx, id!, parse(i.RowsInput, await body())) }) },
  { method: 'POST', pattern: new RegExp(`^catalog/imports/${uuid}/commit$`), roles: i.IMPORTERS,
    handle: async (ctx, [id], body) => ({ body: await i.commit(ctx, id!, parse(i.FinishInput, await body())) }) },
  { method: 'POST', pattern: new RegExp(`^catalog/imports/${uuid}/discard$`), roles: i.IMPORTERS,
    handle: async (ctx, [id], body) => ({ body: await i.discard(ctx, id!, parse(i.FinishInput, await body())) }) }
]);
