import { SURGERY, SurgeryInput, recordSurgery, surgeryOptions } from '../../modules/surgery/actions.js';
import { registerRoutes } from './registry.js';
import { parse } from './types.js';
registerRoutes('surgery', [
  { method:'GET',pattern:/^surgery\/options$/,roles:SURGERY,handle:async ctx => ({ body:await surgeryOptions(ctx) }) },
  { method:'POST',pattern:/^surgery$/,roles:SURGERY,handle:async (ctx,_p,body) => ({ status:201,body:await recordSurgery(ctx,parse(SurgeryInput,await body())) }) }
]);
