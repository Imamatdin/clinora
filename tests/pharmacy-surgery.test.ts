import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ReceiptInput,DispenseInput,AdjustmentInput } from '../src/modules/pharmacy/actions.js';
import { ROLES } from '../src/modules/identity/roles.js';
import { StaffRolesInput } from '../src/contracts/clinic.js';
import { pharmacy } from '../src/web/i18n/pharmacy.uz-Cyrl.js';
import { pharmacyUzLatn } from '../src/web/i18n/pharmacy.uz-Latn.js';
import { pharmacyRu } from '../src/web/i18n/pharmacy.ru.js';
import { surgery } from '../src/web/i18n/surgery.uz-Cyrl.js';
import { surgeryUzLatn } from '../src/web/i18n/surgery.uz-Latn.js';
import { surgeryRu } from '../src/web/i18n/surgery.ru.js';
test('pharmacy role is assignable with all other roles; quantities and money reject fractions and overflow',()=>{
  assert.ok(StaffRolesInput.safeParse({roles:ROLES}).success);
  const base={serviceId:randomUUID(),idempotencyKey:randomUUID()};
  const receipt={...base,qty:1,unitCostUzs:'9007199254740993',supplier:'Synthetic'};
  assert.ok(ReceiptInput.safeParse(receipt).success);
  for(const cost of ['1.5','1e4','-1','9223372036854775808']) assert.ok(!ReceiptInput.safeParse({...receipt,unitCostUzs:cost}).success);
  for(const qty of [0,-1,0.5,2147483648]) assert.ok(!DispenseInput.safeParse({...base,visitId:randomUUID(),qty}).success);
  assert.ok(!AdjustmentInput.safeParse({...base,qty:-1,reason:' '}).success);
});
test('pharmacy and surgery ship complete dictionaries in three languages',()=>{
  for(const [cyrl,latin,ru] of [[pharmacy,pharmacyUzLatn,pharmacyRu],[surgery,surgeryUzLatn,surgeryRu]]) {
    assert.deepEqual(Object.keys(cyrl).sort(),Object.keys(latin).sort());assert.deepEqual(Object.keys(cyrl).sort(),Object.keys(ru).sort());
    for(const text of Object.values(latin)) {assert.ok(text.trim());assert.doesNotMatch(text,/\p{Script=Cyrillic}/u);}
    for(const text of Object.values(ru)) assert.match(text,/\p{Script=Cyrillic}/u);
  }
});
