import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync,strFromU8 } from 'fflate';
import { computePayroll } from '../src/modules/payroll/actions.js';
import { computeReport } from '../src/modules/reports/actions.js';
import { csv,xlsx } from '../src/modules/reports/exports.js';
import { Range,type Records } from '../src/modules/reports/records.js';
import { ceo } from '../src/web/i18n/ceo.uz-Cyrl.js';
import { ceoUzLatn } from '../src/web/i18n/ceo.uz-Latn.js';
import { ceoRu } from '../src/web/i18n/ceo.ru.js';
function data():Records{return {
  clinic:{name:'Synthetic clinic',timezone:'Asia/Tashkent'},visits:[{id:'v',date:'2026-11-10',patient_id:'p',patient_no:'1',full_name:'Synthetic patient',type:'outpatient',status:'active',first_date:'2026-11-10'}],
  charges:[{id:'l',visit_id:'v',created_at:'2026-11-10T08:00:00Z',unit_price_uzs:'1000000',quantity:1,status:'ordered',kind:'consultation',performer_user_id:'doctor',service:'Synthetic consultation',doctor:'Synthetic doctor'}],discounts:[],payments:[{id:'p1',visit_id:'v',date:'2026-11-10',amount_uzs:'500000',kind:'payment',method:'cash'},{id:'p2',visit_id:'v',date:'2026-11-11',amount_uzs:'200000',kind:'refund',method:'cash'}],
  allocations:[{payment_id:'p1',charge_line_id:'l',amount_uzs:'500000'},{payment_id:'p2',charge_line_id:'l',amount_uzs:'200000'}],adjustments:[],cashOuts:[],shifts:[],rules:[{id:'rule',user_id:'doctor',doctor_share_bp:5000,basis:'paid',discount_bearer:'proportional',categories:['consultation'],effective_from:'2026-01-01'}]
};}
test('payroll accrues paid earnings once, reverses refunds in the later period and preserves dated rules',()=>{
  const d=data(),first=computePayroll(d,{from:'2026-11-10',to:'2026-11-10'}),second=computePayroll(d,{from:'2026-11-11',to:'2026-11-11'});
  assert.equal(first[0]!.entitlement_uzs,250000n);assert.equal(second[0]!.entitlement_uzs,-100000n);assert.equal(computePayroll(d,{from:'2026-11-10',to:'2026-11-11'})[0]!.entitlement_uzs,150000n);
  d.rules.unshift({...d.rules[0],id:'future',doctor_share_bp:8000,effective_from:'2026-11-12'});assert.equal(computePayroll(d,{from:'2026-11-10',to:'2026-11-10'})[0]!.entitlement_uzs,250000n);
  assert.deepEqual(computePayroll(d,{from:'2026-11-10',to:'2026-11-11'},'other'),[]);
});
test('billed entitlement is not paid twice when receipts arrive; refunded cash is never new revenue',()=>{
  const d=data();d.rules[0]!.basis='billed';const a=computePayroll(d,{from:'2026-11-10',to:'2026-11-10'})[0]!,b=computePayroll(d,{from:'2026-11-11',to:'2026-11-11'})[0]!;
  assert.equal(a.entitlement_uzs,500000n);assert.equal(b.entitlement_uzs,0n);assert.equal(b.from_receipts_uzs,-200000n);assert.equal(b.clinic_funded_uzs,200000n);
  const r=computeReport(d,{from:'2026-11-11',to:'2026-11-11'});assert.equal(r.totals.collected,'0');assert.equal(r.totals.refunds,'200000');assert.equal(r.totals.net,'-200000');assert.equal(r.doctors[0]!.amount,'-200000');
});
test('exports preserve arbitrary precision, escape XML and neutralize CSV formulas',()=>{
  assert.match(csv([['=HYPERLINK("bad")','+123','@SUM(A1)','-1']]),/"'=HYPERLINK/);
  const out=unzipSync(xlsx([['<&>','9007199254740993','=1+1']]));const sheet=strFromU8(out['xl/worksheets/sheet1.xml']!);
  assert.match(sheet,/&lt;&amp;&gt;/);assert.match(sheet,/9007199254740993/);assert.match(sheet,/<t xml:space="preserve">=1\+1<\/t>/);assert.doesNotMatch(sheet,/<f>/);
  assert.equal(Range.safeParse({from:'2026-02-30',to:'2026-03-01'}).success,false);assert.equal(Range.safeParse({from:'2026-11-12',to:'2026-11-11'}).success,false);
});
test('report interface ships matching Uzbek Cyrillic, Uzbek Latin and Russian dictionaries',()=>{
  for(const dictionary of [ceoUzLatn,ceoRu]){assert.deepEqual(Object.keys(dictionary).sort(),Object.keys(ceo).sort());for(const v of Object.values(dictionary))assert.ok(v.length>0);}
  for(const v of Object.values(ceoUzLatn))assert.doesNotMatch(v,/\p{Script=Cyrillic}/u);
});
