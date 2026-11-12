import { z } from 'zod';
import * as a from '../../modules/payroll/actions.js';
import { Range } from '../../modules/reports/records.js';
import { download,pdf,xlsx } from '../../modules/reports/exports.js';
import { recordAudit } from '../roles.js';
import { registerRoutes } from './registry.js';
import { parse } from './types.js';
registerRoutes('payroll',[
  {method:'GET',pattern:/^payroll\/rules$/,roles:['ceo','doctor'],handle:async c=>({body:await a.rules(c)})},
  {method:'POST',pattern:/^payroll\/rules$/,roles:['ceo'],handle:async(c,_p,b)=>({status:201,body:await a.setRule(c,parse(a.Rule,await b()))})},
  {method:'POST',pattern:/^payroll\/earnings$/,roles:['ceo','doctor'],handle:async(c,_p,b)=>({body:await a.earnings(c,parse(Range,await b()))})},
  {method:'POST',pattern:/^payroll\/finalize$/,roles:['ceo'],handle:async(c,_p,b)=>({body:await a.finalize(c,parse(Range,await b()))})},
  {method:'POST',pattern:/^payroll\/export$/,roles:['ceo'],handle:async(c,_p,b)=>{
    const i=parse(Range.safeExtend({format:z.enum(['pdf','xlsx'])}),await b()),result=await a.earnings(c,{from:i.from,to:i.to});
    const rows:unknown[][]=[['Clinora',i.from,i.to,result.period?'Тасдиқланган':'Қоралама'],['Шифокор','Хизмат ID','Қоида ID','Ҳақ, сўм','Тушумдан','Клиника ҳисобидан'],...result.lines.map(l=>[l.doctor,l.charge_line_id,l.rule_id,l.entitlement_uzs,l.from_receipts_uzs,l.clinic_funded_uzs])];
    await recordAudit(c.tx,c.actorId,c.clinicId,'payroll.exported',result.period?.id??c.clinicId,{format:i.format});
    return {body:i.format==='pdf'?download('clinora-payroll.pdf','application/pdf',await pdf('Шифокорлар иш ҳақи',rows)):download('clinora-payroll.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',xlsx(rows))};
  }}
]);
