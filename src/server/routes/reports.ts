import { z } from 'zod';
import { capReport, dashboard, dayReport } from '../../modules/reports/actions.js';
import { reportExport, fullExport } from '../../modules/reports/exports.js';
import { Range } from '../../modules/reports/records.js';
import { registerRoutes } from './registry.js';
import { parse,uuid } from './types.js';
const Export=Range.safeExtend({format:z.enum(['pdf','xlsx'])});
registerRoutes('reports',[
  {method:'GET',pattern:/^reports\/days$/,roles:['ceo','administrator','cashier'],handle:async c=>({body:(await c.tx.query('SELECT id,business_date,status FROM business_days WHERE clinic_id=$1 ORDER BY business_date DESC',[c.clinicId])).rows})},
  {method:'POST',pattern:/^reports\/dashboard$/,roles:['ceo'],handle:async(c,_p,b)=>({body:capReport(await dashboard(c,parse(Range,await b())))})},
  {method:'GET',pattern:new RegExp(`^reports/days/${uuid}$`),roles:['ceo','administrator','cashier'],handle:async(c,[id])=>({body:capReport(await dayReport(c,id!))})},
  {method:'POST',pattern:/^reports\/export$/,roles:['ceo'],handle:async(c,_p,b)=>{const i=parse(Export,await b());return {body:await reportExport(c,await dashboard(c,{from:i.from,to:i.to}),i.format)};}},
  {method:'POST',pattern:new RegExp(`^reports/days/${uuid}/print$`),roles:['ceo','administrator','cashier'],handle:async(c,[id],b)=>{const i=parse(z.object({format:z.enum(['pdf','thermal'])}).strict(),await b()); const report=await dayReport(c,id!);return {body:await reportExport(c,report,i.format,true)};}},
  {method:'POST',pattern:/^reports\/full-export$/,roles:['ceo'],handle:async(c,_p,b)=>{parse(z.object({}).strict(),await b());return {body:await fullExport(c)};}}
]);
