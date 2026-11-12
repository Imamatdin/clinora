import { integer, min, nonempty, uzs, type Uzs } from './money.js';

export interface ChargeLine {
  readonly id: string;
  readonly unitPrice: Uzs;
  readonly quantity: number;
  readonly status: 'ordered' | 'completed' | 'cancelled';
  readonly category: string;
  readonly doctorId?: string;
}
export type Discount = Readonly<{
  reason: string;
  approverId: string;
  /** Omit for visit-level. At most one discount per target. */
  lineId?: string;
} & ({ kind: 'percent'; basisPoints: number } | { kind: 'fixed'; amount: Uzs })>;
export interface LineTotal extends ChargeLine {
  readonly value: Uzs;
  readonly discount: Uzs;
  readonly payable: Uzs;
  readonly allocatedPaid: Uzs;
}
export interface Transaction {
  readonly id: string;
  readonly kind: 'payment' | 'refund';
  readonly amount: Uzs;
}
export interface Invoice {
  readonly lines: readonly LineTotal[];
  readonly transactions: readonly Transaction[];
  readonly value: Uzs;
  readonly discount: Uzs;
  readonly payable: Uzs;
  readonly payments: Uzs;
  readonly refunds: Uzs;
  readonly paid: Uzs;
  readonly due: Uzs;
  readonly status: 'unpaid' | 'partially_paid' | 'paid' | 'refunded';
}

function discountAmount(base: bigint, discount: Discount): bigint {
  nonempty(discount.reason);
  nonempty(discount.approverId);
  if (discount.kind === 'percent') {
    integer(discount.basisPoints, 0, 10000);
    return base * BigInt(discount.basisPoints) / 10000n;
  }
  if (discount.kind !== 'fixed') throw new TypeError('Unknown discount kind');
  return min(base, uzs(discount.amount));
}

/** Input line order is chronological (oldest first), and controls payment allocation only.
 * Discount ties use lexicographic line IDs, independent of caller ordering.
 * Line discounts apply first; the single visit discount applies to the remainder.
 * Transactions are chronological immutable events; duplicate IDs are rejected, not replayed.
 */
export function calculateInvoice(
  lines: readonly ChargeLine[], discounts: readonly Discount[] = [],
  transactions: readonly Transaction[] = [],
): Invoice {
  const ids = new Set<string>();
  const totals = lines.map(line => {
    nonempty(line.id); nonempty(line.category);
    if (line.doctorId !== undefined) nonempty(line.doctorId);
    if (ids.has(line.id)) throw new TypeError('Duplicate charge line');
    ids.add(line.id);
    integer(line.quantity, 1);
    if (!['ordered', 'completed', 'cancelled'].includes(line.status)) throw new TypeError('Invalid line status');
    const price = uzs(line.unitPrice);
    const value = uzs(line.status === 'cancelled' ? 0n : price * BigInt(line.quantity));
    return { ...line, unitPrice: price, value, discount: uzs(0n), payable: value, allocatedPaid: uzs(0n) };
  });
  const targets = new Set<string | undefined>();
  for (const discount of discounts) {
    if (targets.has(discount.lineId)) throw new TypeError('Duplicate discount target');
    targets.add(discount.lineId);
    // Validate even when the invoice has no value.
    discountAmount(0n, discount);
    if (discount.lineId === undefined) continue;
    const line = totals.find(item => item.id === discount.lineId);
    if (!line || line.status === 'cancelled') throw new TypeError('Discount target must be an active line');
    line.discount = uzs(discountAmount(line.value, discount));
    line.payable = uzs(line.value - line.discount);
  }
  const visit = discounts.find(discount => discount.lineId === undefined);
  if (visit) {
    const base = totals.reduce((sum, line) => sum + line.payable, 0n);
    const amount = discountAmount(base, visit);
    if (base > 0n) {
      const parts = totals.filter(line => line.payable > 0n).map(line => ({
        line, amount: amount * line.payable / base, remainder: amount * line.payable % base,
      }));
      let remaining = amount - parts.reduce((sum, part) => sum + part.amount, 0n);
      parts.sort((a, b) => a.remainder === b.remainder
        ? (a.line.id < b.line.id ? -1 : a.line.id > b.line.id ? 1 : 0)
        : a.remainder > b.remainder ? -1 : 1);
      for (const part of parts) {
        const allocated = part.amount + (remaining > 0n ? 1n : 0n);
        if (remaining > 0n) remaining--;
        part.line.discount = uzs(part.line.discount + allocated);
        part.line.payable = uzs(part.line.payable - allocated);
      }
    }
  }
  const payable = totals.reduce((sum, line) => sum + line.payable, 0n);
  const lots: { line: typeof totals[number]; remaining: bigint }[] = [];
  let payments = 0n, refunds = 0n, paid = 0n;
  const transactionIds = new Set<string>();
  const events = transactions.map(event => {
    nonempty(event.id);
    if (transactionIds.has(event.id)) throw new TypeError('Duplicate transaction ID');
    transactionIds.add(event.id);
    const amount = uzs(event.amount);
    if (amount === 0n) throw new RangeError('Transaction amount must be positive');
    let remaining: bigint = amount;
    if (event.kind === 'payment') {
      if (amount > payable - paid) throw new RangeError('Payment exceeds due');
      for (const line of totals) {
        const allocated = min(remaining, line.payable - line.allocatedPaid);
        if (allocated > 0n) {
          line.allocatedPaid = uzs(line.allocatedPaid + allocated);
          lots.push({ line, remaining: allocated });
          remaining -= allocated;
        }
      }
      payments += amount; paid += amount;
    } else if (event.kind === 'refund') {
      if (amount > paid) throw new RangeError('Refund exceeds paid');
      for (let index = lots.length - 1; index >= 0 && remaining > 0n; index--) {
        const lot = lots[index]!;
        const reversed = min(remaining, lot.remaining);
        lot.remaining -= reversed;
        lot.line.allocatedPaid = uzs(lot.line.allocatedPaid - reversed);
        remaining -= reversed;
      }
      refunds += amount; paid -= amount;
    } else throw new TypeError('Invalid transaction kind');
    return { ...event, amount };
  });
  const value = totals.reduce((sum, line) => sum + line.value, 0n);
  return {
    lines: totals, transactions: events, value: uzs(value), discount: uzs(value - payable),
    payable: uzs(payable), payments: uzs(payments), refunds: uzs(refunds), paid: uzs(paid), due: uzs(payable - paid),
    status: refunds > 0n && paid === 0n ? 'refunded' : paid === payable ? 'paid' : paid > 0n ? 'partially_paid' : 'unpaid',
  };
}
