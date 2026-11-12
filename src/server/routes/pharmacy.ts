import { PHARMACY, DISPENSERS, ReceiptInput, DispenseInput, AdjustmentInput, ThresholdInput, receive, dispense, adjust, setThreshold, stock, history } from '../../modules/pharmacy/actions.js';
import { visitOptions } from '../../modules/surgery/actions.js';
import { registerRoutes } from './registry.js';
import { parse, uuid } from './types.js';
registerRoutes('pharmacy', [
  { method:'GET', pattern:/^pharmacy\/stock$/, roles:PHARMACY, handle:async ctx => ({ body:await stock(ctx) }) },
  { method:'GET', pattern:/^pharmacy\/visits$/, roles:PHARMACY, handle:async ctx => ({ body:await visitOptions(ctx) }) },
  { method:'GET', pattern:new RegExp(`^pharmacy/stock/${uuid}/history$`), roles:PHARMACY, handle:async (ctx,[id]) => ({ body:await history(ctx,id!) }) },
  { method:'POST', pattern:/^pharmacy\/receipts$/, roles:PHARMACY, handle:async (ctx,_p,body) => ({ status:201,body:await receive(ctx,parse(ReceiptInput,await body())) }) },
  { method:'POST', pattern:/^pharmacy\/dispense$/, roles:DISPENSERS, handle:async (ctx,_p,body) => ({ status:201,body:await dispense(ctx,parse(DispenseInput,await body())) }) },
  { method:'POST', pattern:/^pharmacy\/adjustments$/, roles:PHARMACY, handle:async (ctx,_p,body) => ({ status:201,body:await adjust(ctx,parse(AdjustmentInput,await body())) }) },
  { method:'POST', pattern:/^pharmacy\/threshold$/, roles:PHARMACY, handle:async (ctx,_p,body) => ({ body:await setThreshold(ctx,parse(ThresholdInput,await body())) }) }
]);
