import type { LineTotal } from './invoice.js';
import { integer, min, nonempty, uzs, type Uzs } from './money.js';

export interface DoctorShareRule {
  readonly doctorShareBp: number;
  readonly basis: 'billed' | 'paid';
  readonly discountBearer: 'clinic' | 'doctor' | 'proportional';
  readonly categories: readonly string[];
}
export interface DoctorLineShare {
  readonly lineId: string;
  readonly amountReceived: Uzs;
  /** Unscaled entitlement per the configured billed-basis formula. */
  readonly billedBasisAmount: Uzs;
  readonly doctorEntitlement: Uzs;
  readonly doctorFromReceipts: Uzs;
  readonly clinicShare: Uzs;
  readonly clinicFundedShare: Uzs;
}

/** Use invoice-calculated lines. Only this doctor's active lines in eligible categories count.
 * Clinic-funded entitlement is separate from receipts, never fictitious revenue.
 * For non-clinic bearers, distributable billed entitlement is capped at receipts:
 * unpaid accrual remains visible in billedBasisAmount, not clinicFundedShare.
 */
export function calculateDoctorShares(
  lines: readonly LineTotal[], doctorId: string, rule: DoctorShareRule,
): readonly DoctorLineShare[] {
  nonempty(doctorId);
  integer(rule.doctorShareBp, 0, 10000);
  if (!['billed', 'paid'].includes(rule.basis)) throw new TypeError('Invalid share basis');
  if (!['clinic', 'doctor', 'proportional'].includes(rule.discountBearer)) throw new TypeError('Invalid discount bearer');
  for (const category of rule.categories) nonempty(category);
  const ids = new Set<string>();
  return lines.flatMap(line => {
    nonempty(line.id);
    if (ids.has(line.id)) throw new TypeError('Duplicate share line');
    ids.add(line.id);
    const value = uzs(line.value), discount = uzs(line.discount);
    const payable = uzs(line.payable), received = uzs(line.allocatedPaid);
    if (discount > value || payable !== value - discount || received > payable) {
      throw new RangeError('Inconsistent invoice line');
    }
    if (line.status === 'cancelled' || line.doctorId !== doctorId || !rule.categories.includes(line.category)) return [];
    const grossShare = value * BigInt(rule.doctorShareBp) / 10000n;
    const billed = rule.discountBearer === 'clinic' ? grossShare
      : rule.discountBearer === 'doctor' ? (grossShare > discount ? grossShare - discount : 0n)
      : payable * BigInt(rule.doctorShareBp) / 10000n;
    const scaled = rule.basis === 'billed' ? billed : payable > 0n ? billed * received / payable
      : rule.discountBearer === 'clinic' ? billed : 0n;
    const fromReceipts = min(scaled, received);
    const funded = rule.discountBearer === 'clinic' ? scaled - fromReceipts : 0n;
    return [{
      lineId: line.id, amountReceived: received, billedBasisAmount: uzs(billed),
      doctorEntitlement: uzs(fromReceipts + funded), doctorFromReceipts: uzs(fromReceipts),
      clinicShare: uzs(received - fromReceipts), clinicFundedShare: uzs(funded),
    }];
  });
}
