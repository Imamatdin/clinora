import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { calculateDoctorShares, calculateInvoice, uzs, type DoctorShareRule } from '../src/modules/billing/index.js';

const makeInvoice = (value: bigint, discount: bigint, paid: bigint) => calculateInvoice([
  { id: 'service', unitPrice: uzs(value), quantity: 1, status: 'completed', category: 'consultation', doctorId: 'doctor' },
], [{ kind: 'fixed', amount: uzs(discount), reason: 'Synthetic approval', approverId: 'ceo' }],
paid > 0n ? [{ id: 'payment', kind: 'payment', amount: uzs(paid) }] : []);
const baseRule: DoctorShareRule = { doctorShareBp: 5000, basis: 'paid', discountBearer: 'clinic', categories: ['consultation'] };

test('all three bearer formulas, partial paid scaling and full payment', () => {
  const invoice = makeInvoice(100n, 20n, 40n);
  const expected = { clinic: [50n, 25n], doctor: [30n, 15n], proportional: [40n, 20n] } as const;
  for (const discountBearer of ['clinic', 'doctor', 'proportional'] as const) {
    const rule = { ...baseRule, discountBearer };
    const share = calculateDoctorShares(invoice.lines, 'doctor', rule)[0]!;
    assert.equal(share.billedBasisAmount, expected[discountBearer][0]);
    assert.equal(share.doctorEntitlement, expected[discountBearer][1]);
    assert.equal(share.clinicFundedShare, 0n);
    const full = calculateDoctorShares(makeInvoice(100n, 20n, 80n).lines, 'doctor', rule)[0]!;
    assert.equal(full.doctorEntitlement, full.billedBasisAmount);
  }
  assert.equal(calculateDoctorShares(makeInvoice(101n, 0n, 1n).lines, 'doctor', baseRule)[0]!.doctorEntitlement, 0n);
});

test('full discount and clinic subsidy never create revenue or a negative clinic share', () => {
  for (const basis of ['billed', 'paid'] as const) for (const discountBearer of ['clinic', 'doctor', 'proportional'] as const) {
    const share = calculateDoctorShares(makeInvoice(500000n, 500000n, 0n).lines, 'doctor', { ...baseRule, basis, discountBearer })[0]!;
    assert.equal(share.doctorEntitlement, discountBearer === 'clinic' ? 250000n : 0n);
    assert.equal(share.clinicFundedShare, share.doctorEntitlement);
    assert.equal(share.doctorFromReceipts, 0n);
    assert.equal(share.clinicShare, 0n);
  }
  const share = calculateDoctorShares(makeInvoice(100n, 90n, 10n).lines, 'doctor', baseRule)[0]!;
  assert.equal(share.doctorEntitlement, 50n);
  assert.equal(share.doctorFromReceipts, 10n);
  assert.equal(share.clinicFundedShare, 40n);
});

test('billed accrual is distinct from distribution; non-clinic bearers cannot receive clinic funding', () => {
  for (const discountBearer of ['clinic', 'doctor', 'proportional'] as const) {
    const share = calculateDoctorShares(makeInvoice(100n, 0n, 10n).lines, 'doctor', { ...baseRule, basis: 'billed', discountBearer })[0]!;
    assert.equal(share.billedBasisAmount, 50n);
    assert.equal(share.doctorFromReceipts, 10n);
    assert.equal(share.doctorEntitlement, discountBearer === 'clinic' ? 50n : 10n);
    assert.equal(share.clinicFundedShare, discountBearer === 'clinic' ? 40n : 0n);
  }
});

test('scope excludes other doctors, categories, unassigned and cancelled lines; validates rules', () => {
  const invoice = makeInvoice(100n, 0n, 100n);
  assert.deepEqual(calculateDoctorShares(invoice.lines, 'other', baseRule), []);
  assert.deepEqual(calculateDoctorShares(invoice.lines, 'doctor', { ...baseRule, categories: [] }), []);
  assert.deepEqual(calculateDoctorShares(invoice.lines.map(line => ({ ...line, doctorId: 'other' })), 'doctor', baseRule), []);
  const cancelled = calculateInvoice([{ id: 'cancelled', unitPrice: uzs(100n), quantity: 1, status: 'cancelled', doctorId: 'doctor', category: 'consultation' }]);
  assert.deepEqual(calculateDoctorShares(cancelled.lines, 'doctor', baseRule), []);
  for (const doctorShareBp of [-1, 10001, 1.2]) {
    assert.throws(() => calculateDoctorShares(invoice.lines, 'doctor', { ...baseRule, doctorShareBp }));
  }
  assert.throws(() => calculateDoctorShares(invoice.lines, '', baseRule));
  assert.throws(() => calculateDoctorShares([...invoice.lines, ...invoice.lines], 'doctor', baseRule));
  assert.throws(() => calculateDoctorShares(invoice.lines.map(line => ({ ...line, payable: uzs(99n) })), 'doctor', baseRule));
});

test('property: receipt conservation, entitlement identity, funding restrictions and exact scaling', () => {
  fc.assert(fc.property(fc.bigInt({ min: 0n, max: 10n ** 24n }), fc.nat(), fc.nat(),
    fc.integer({ min: 0, max: 10000 }), (value, discountSeed, paidSeed, bp) => {
      const discount = value * BigInt(discountSeed % 10001) / 10000n;
      const payable = value - discount;
      const paid = payable * BigInt(paidSeed % 10001) / 10000n;
      const invoice = makeInvoice(value, discount, paid);
      for (const basis of ['billed', 'paid'] as const) for (const discountBearer of ['clinic', 'doctor', 'proportional'] as const) {
        const rule = { ...baseRule, doctorShareBp: bp, basis, discountBearer };
        const share = calculateDoctorShares(invoice.lines, 'doctor', rule)[0]!;
        const gross = value * BigInt(bp) / 10000n;
        const billed = discountBearer === 'clinic' ? gross : discountBearer === 'doctor'
          ? (gross > discount ? gross - discount : 0n) : payable * BigInt(bp) / 10000n;
        const entitlement = basis === 'billed' ? billed : payable > 0n ? billed * paid / payable
          : discountBearer === 'clinic' ? billed : 0n;
        assert.equal(share.billedBasisAmount, billed);
        assert.equal(share.doctorFromReceipts + share.clinicShare, paid);
        assert.equal(share.doctorEntitlement, share.doctorFromReceipts + share.clinicFundedShare);
        assert.equal(share.doctorEntitlement, discountBearer === 'clinic' ? entitlement : entitlement < paid ? entitlement : paid);
        assert.ok(share.clinicShare >= 0n && share.doctorFromReceipts >= 0n);
        if (discountBearer !== 'clinic') assert.equal(share.clinicFundedShare, 0n);
        const full = calculateDoctorShares(makeInvoice(value, discount, payable).lines, 'doctor', rule)[0]!;
        assert.equal(full.doctorEntitlement, billed);
      }
    }), { numRuns: 1500 });
});

test('property: per-line shares are order independent and reconcile after refunds', () => {
  fc.assert(fc.property(fc.array(fc.bigInt({ min: 0n, max: 10n ** 18n }), { minLength: 1, maxLength: 20 }),
    fc.integer({ min: 0, max: 10000 }), (prices, doctorShareBp) => {
      const lines = prices.map((price, index) => ({ id: String(index), unitPrice: uzs(price), quantity: 1,
        status: 'completed' as const, category: 'consultation', doctorId: 'doctor' }));
      const total = prices.reduce((sum, price) => sum + price, 0n);
      const events = total ? [{ id: 'p', kind: 'payment' as const, amount: uzs(total) },
        ...(total / 2n ? [{ id: 'r', kind: 'refund' as const, amount: uzs(total / 2n) }] : [])] : [];
      const invoice = calculateInvoice(lines, [], events);
      const rule = { ...baseRule, doctorShareBp };
      const shares = calculateDoctorShares(invoice.lines, 'doctor', rule);
      const reversed = calculateDoctorShares([...invoice.lines].reverse(), 'doctor', rule);
      assert.equal(shares.reduce((sum, item) => sum + item.doctorFromReceipts + item.clinicShare, 0n), invoice.paid);
      for (const share of shares) assert.deepEqual(share, reversed.find(item => item.lineId === share.lineId));
    }), { numRuns: 500 });
});
