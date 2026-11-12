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
test('a later service on an ongoing visit uses the rule effective when that service is recorded',()=>{
  const d=data();d.rules.unshift({...d.rules[0],id:'new-rule',doctor_share_bp:8000,basis:'billed',effective_from:'2026-11-12'});
  d.charges.push({...d.charges[0],id:'later-service',created_at:'2026-11-12T08:00:00Z',unit_price_uzs:'100000'});
  const lines=computePayroll(d,{from:'2026-11-12',to:'2026-11-12'});assert.equal(lines.length,1);assert.equal(lines[0]!.rule_id,'new-rule');assert.equal(lines[0]!.entitlement_uzs,80000n);
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
test('021: three-day stay service dates reconcile daily and range; outstanding includes earlier visits',()=>{
  const d=data(); d.payments=[];d.allocations=[];
  d.charges=[0,1,2].map(i=>({...d.charges[0],id:`bed-${i}`,kind:'bed',service_date:`2026-11-${10+i}`,created_at:'2026-11-12T08:00:00Z',unit_price_uzs:'100'}));
  const reports=[10,11,12].map(day=>computeReport(d,{from:`2026-11-${day}`,to:`2026-11-${day}`}));
  assert.deepEqual(reports.map(r=>r.totals.value),['100','100','100']);
  assert.equal(reports.reduce((n,r)=>n+BigInt(r.totals.value!),0n).toString(),computeReport(d,{from:'2026-11-10',to:'2026-11-12'}).totals.value);
  assert.equal(reports[2]!.totals.outstanding,'300');
});
test('021: an unbalanced visit is flagged and skipped without losing valid visits',()=>{
  const d=data();d.allocations[0]!.amount_uzs='2000000';
  d.visits.push({...d.visits[0],id:'good',patient_id:'other'});d.charges.push({...d.charges[0],id:'good-line',visit_id:'good'});
  const r=computeReport(d,{from:'2026-11-10',to:'2026-11-10'});
  assert.equal(r.totals.value,'1000000');assert.equal(r.needsReview?.[0]?.id,'v');
});
test('021: payroll lists missing rules and preserves other doctors earnings',()=>{
  const d=data();d.charges.push({...d.charges[0],id:'missing',performer_user_id:'missing-doctor'});
  const lines=computePayroll(d,{from:'2026-11-10',to:'2026-11-10'});
  assert.equal(lines.find(l=>l.user_id==='doctor')!.entitlement_uzs,250000n);
  assert.equal(lines.find(l=>l.user_id==='missing-doctor')!.status,'rule_missing');
});
