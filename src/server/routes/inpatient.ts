import { registerRoutes } from './registry.js';
import { uuid } from './types.js';
import * as inpatient from '../../modules/inpatient/actions.js';
import { renderInvoice } from '../../modules/inpatient/pdf.js';

registerRoutes('inpatient',[
  {method:'GET',pattern:/^inpatient$/,roles:inpatient.READ,handle:async ctx=>({body:await inpatient.ward(ctx)})},
  {method:'POST',pattern:/^inpatient\/admit$/,roles:inpatient.WARD,handle:async(ctx,_p,body)=>({status:201,body:await inpatient.admit(ctx,await body())})},
  {method:'POST',pattern:/^inpatient\/daily$/,roles:inpatient.WARD,handle:async(ctx,_p,body)=>({body:await inpatient.dailyCharges(ctx,await body())})},
  {method:'POST',pattern:/^inpatient\/rule$/,roles:['ceo','administrator'],handle:async(ctx,_p,body)=>({body:await inpatient.changeRule(ctx,await body())})},
  ...(['transfer','services','caretakers','discharge'] as const).map(action=>({method:'POST' as const,pattern:new RegExp(`^inpatient/${uuid}/${action}$`),roles:inpatient.WARD,
    handle:async(ctx:Parameters<typeof inpatient.admit>[0],[id]:string[],body:()=>Promise<unknown>)=>({body:await ({transfer:inpatient.transfer,services:inpatient.addService,caretakers:inpatient.addCaretaker,discharge:inpatient.discharge}[action])(ctx,id!,await body())})})),
  {method:'GET',pattern:new RegExp(`^inpatient/${uuid}/invoice$`),roles:inpatient.READ,handle:async(ctx,[id])=>({body:await inpatient.invoice(ctx,id!)})},
  {method:'GET',pattern:new RegExp(`^inpatient/${uuid}/invoice-pdf$`),roles:inpatient.READ,handle:async(ctx,[id])=>({file:{contentType:'application/pdf',filename:'clinora-inpatient-invoice.pdf',data:await renderInvoice(await inpatient.invoice(ctx,id!))}})}
]);
