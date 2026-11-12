import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { calculateInvoice, formatUzs, uzs, type ChargeLine, type Discount, type Transaction } from '../src/modules/billing/index.js';

const line = (id: string, amount: bigint, extra: Partial<ChargeLine> = {}): ChargeLine => ({
  id, unitPrice: uzs(amount), quantity: 1, status: 'completed', category: 'service', ...extra,
});
const percent = (basisPoints: number, lineId?: string): Discount => ({
  kind: 'percent', basisPoints, reason: 'Authorized synthetic discount', approverId: 'ceo',
  ...(lineId === undefined ? {} : { lineId }),
});
const fixed = (amount: bigint, lineId?: string): Discount => ({
  kind: 'fixed', amount: uzs(amount), reason: 'Synthetic reason', approverId: 'ceo',
  ...(lineId === undefined ? {} : { lineId }),
});
const event = (id: string, kind: Transaction['kind'], amount: bigint): Transaction => ({ id, kind, amount: uzs(amount) });

test('UZS validates whole safe inputs and formats arbitrary precision without floats', () => {
  for (const invalid of [-1, 1.2, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '-1', '1.0', ' 1', '1e3', '']) {
    assert.throws(() => uzs(invalid));
  }
  assert.throws(() => uzs(-1n));
  assert.equal(uzs(Number.MAX_SAFE_INTEGER), BigInt(Number.MAX_SAFE_INTEGER));
  assert.equal(formatUzs(uzs('123456789012345678901234567890')), '123 456 789 012 345 678 901 234 567 890 сўм');
  assert.equal(formatUzs(uzs(1000000)), '1 000 000 сўм');
  assert.equal(formatUzs(uzs(0)), '0 сўм');
});

test('spec invoice totals one million and retains a fully discounted service', () => {
  const invoice = calculateInvoice([line('bed', 100000n, { quantity: 5 }), line('lab', 250000n),
    line('ultrasound', 150000n), line('other', 100000n), line('cancelled', 999n, { status: 'cancelled' })]);
  assert.equal(invoice.value, 1000000n);
  assert.equal(invoice.due, 1000000n);
  assert.equal(invoice.status, 'unpaid');
  const free = calculateInvoice([line('service', 500000n)], [percent(10000)]);
  assert.equal(free.lines.length, 1);
  assert.equal(free.value, 500000n);
  assert.equal(free.discount, 500000n);
  assert.equal(free.payable, 0n);
  assert.equal(free.status, 'paid');
  assert.equal(calculateInvoice([]).due, 0n);
});

test('discounts floor, cap, apply line then visit, and break remainder ties by ID', () => {
  assert.equal(calculateInvoice([line('a', 101n)], [percent(3333)]).discount, 33n);
  assert.equal(calculateInvoice([line('a', 100n)], [fixed(999n)]).payable, 0n);
  const lines = [line('b', 100n), line('a', 100n), line('c', 100n)];
  const invoice = calculateInvoice(lines, [fixed(1n)]);
  assert.deepEqual(invoice.lines.map(item => item.discount), [0n, 1n, 0n]);
  const mixed = calculateInvoice(lines, [percent(5000), fixed(50n, 'a')]);
  assert.equal(mixed.discount, 175n);
  assert.equal(mixed.lines.find(item => item.id === 'a')!.discount, 75n);
  assert.equal(calculateInvoice([line('a', 0n)], [fixed(100n)]).discount, 0n);
});

test('bad charges, discount targets and missing approval metadata are rejected', () => {
  for (const quantity of [0, -1, 1.1, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => calculateInvoice([line('a', 1n, { quantity })]));
  }
  assert.throws(() => calculateInvoice([line('a', 1n), line('a', 2n)]));
  assert.throws(() => calculateInvoice([line('', 1n)]));
  for (const basisPoints of [-1, 10001, 1.1, NaN]) {
    assert.throws(() => calculateInvoice([], [percent(basisPoints)]));
  }
  for (const invalid of [{ ...fixed(1n), reason: ' ' }, { ...fixed(1n), approverId: '' },
    fixed(1n, 'missing')]) assert.throws(() => calculateInvoice([line('a', 1n)], [invalid]));
  assert.throws(() => calculateInvoice([line('a', 1n, { status: 'cancelled' })], [fixed(1n, 'a')]));
  assert.throws(() => calculateInvoice([], [fixed(1n), percent(100)]));
  assert.throws(() => calculateInvoice([line('a', 1n)], [fixed(1n, 'a'), percent(100, 'a')]));
});

test('payments use oldest lines and refunds reverse newest allocation lots, including after repayments', () => {
  const lines = [line('a', 100n), line('b', 100n)];
  let events = [event('p1', 'payment', 150n)];
  assert.deepEqual(calculateInvoice(lines, [], events).lines.map(item => item.allocatedPaid), [100n, 50n]);
  events = [...events, event('r1', 'refund', 100n), event('p2', 'payment', 20n), event('r2', 'refund', 10n)];
  const result = calculateInvoice(lines, [], events);
  assert.deepEqual(result.lines.map(item => item.allocatedPaid), [60n, 0n]);
  assert.equal(result.payments, 170n);
  assert.equal(result.refunds, 110n);
  assert.equal(result.paid, 60n);
  assert.equal(result.due, 140n);
  assert.equal(result.status, 'partially_paid');
  assert.equal(calculateInvoice(lines, [], [...events, event('r3', 'refund', 60n)]).status, 'refunded');
  assert.equal(calculateInvoice(lines, [], [event('p', 'payment', 200n)]).status, 'paid');
  assert.throws(() => calculateInvoice(lines, [], [event('p', 'payment', 201n)]));
  assert.throws(() => calculateInvoice(lines, [], [event('r', 'refund', 1n)]));
  assert.throws(() => calculateInvoice(lines, [], [event('p', 'payment', 1n), event('r', 'refund', 2n)]));
  assert.throws(() => calculateInvoice(lines, [], [event('p', 'payment', 0n)]));
  assert.throws(() => calculateInvoice(lines, [], [event('same', 'payment', 1n), event('same', 'payment', 1n)]));
});

const amounts = fc.array(fc.bigInt({ min: 0n, max: 10n ** 24n }), { maxLength: 30 });
test('property: largest remainder conserves discount and is independent of line and discount order', () => {
  fc.assert(fc.property(amounts, fc.integer({ min: 0, max: 10000 }), (prices, bp) => {
    const lines = prices.map((price, index) => line(String(index), price));
    const discounts = [percent(bp)];
    if (lines.length) discounts.push(percent(1234, '0'));
    const invoice = calculateInvoice(lines, discounts);
    const reversed = calculateInvoice([...lines].reverse(), [...discounts].reverse());
    assert.equal(invoice.discount, invoice.lines.reduce((sum, item) => sum + item.discount, 0n));
    const base = prices.reduce((sum, price) => sum + price, 0n);
    const firstDiscount = (prices[0] ?? 0n) * 1234n / 10000n;
    assert.equal(invoice.discount, firstDiscount + (base - firstDiscount) * BigInt(bp) / 10000n);
    assert.equal(invoice.payable, reversed.payable);
    for (const item of invoice.lines) {
      assert.ok(item.discount <= item.value);
      assert.equal(item.discount, reversed.lines.find(other => other.id === item.id)!.discount);
    }
  }), { numRuns: 1000 });
});

test('property: every valid payment/refund sequence conserves allocations and nonnegative due', () => {
  fc.assert(fc.property(amounts, fc.array(fc.tuple(fc.boolean(), fc.nat()), { maxLength: 60 }), (prices, choices) => {
    const lines = prices.map((price, index) => line(String(index), price));
    const events: Transaction[] = [];
    let invoice = calculateInvoice(lines);
    for (const [refund, seed] of choices) {
      const limit = refund ? invoice.paid : invoice.due;
      if (!limit) continue;
      const amount = BigInt(seed) % limit + 1n;
      events.push(event(String(events.length), refund ? 'refund' : 'payment', amount));
      invoice = calculateInvoice(lines, [], events);
      assert.equal(invoice.lines.reduce((sum, item) => sum + item.allocatedPaid, 0n), invoice.paid);
      assert.equal(invoice.paid, invoice.payments - invoice.refunds);
      assert.equal(invoice.payable, invoice.paid + invoice.due);
      assert.ok(invoice.due >= 0n);
      for (const item of invoice.lines) assert.ok(item.allocatedPaid >= 0n && item.allocatedPaid <= item.payable);
    }
  }), { numRuns: 500 });
});

test('calculations do not mutate supplied charge, discount or ledger objects', () => {
  const lines = Object.freeze([Object.freeze(line('a', 100n))]);
  const discounts = Object.freeze([Object.freeze(percent(1000))]);
  const events = Object.freeze([Object.freeze(event('p', 'payment', 10n))]);
  assert.equal(calculateInvoice(lines, discounts, events).due, 80n);
});

test('large quantities and money stay exact beyond the JavaScript number range', () => {
  const amount = 123456789012345678901234567890n;
  const quantity = Number.MAX_SAFE_INTEGER;
  const invoice = calculateInvoice([line('large', amount, { quantity })]);
  assert.equal(invoice.value, amount * BigInt(quantity));
  assert.equal(calculateInvoice([line('ordered', 10n, { status: 'ordered' })]).value, 10n);
});
