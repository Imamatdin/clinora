import { integer } from './money.js';

export interface BedDayRule {
  readonly countAdmissionDay: boolean;
  readonly countDischargeDay: boolean;
  readonly minimumDays: number;
}

function day(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.startsWith('0000')) throw new RangeError('Expected YYYY-MM-DD');
  const milliseconds = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 10) !== date) {
    throw new RangeError('Invalid calendar date');
  }
  return milliseconds / 86400000;
}

/** Dates must already be clinic-local dates, not timestamps. Open stays include the
 * as-of day (it is not a discharge day); the discharge flag applies only on discharge.
 * A same-day stay counts that calendar date once if either applicable flag includes it.
 */
export function countBedDays(input: {
  admissionDate: string; dischargeDate?: string; asOfDate?: string; rule: BedDayRule;
}): number {
  const { rule } = input;
  integer(rule.minimumDays, 1);
  if (typeof rule.countAdmissionDay !== 'boolean' || typeof rule.countDischargeDay !== 'boolean') {
    throw new TypeError('Bed-day flags must be boolean');
  }
  const start = day(input.admissionDate);
  const endDate = input.dischargeDate ?? input.asOfDate;
  if (endDate === undefined) throw new TypeError('Open admission requires asOfDate');
  const end = day(endDate);
  if (end < start) throw new RangeError('End date precedes admission');
  const includeEnd = input.dischargeDate === undefined || rule.countDischargeDay;
  const days = start === end ? Number(rule.countAdmissionDay || includeEnd)
    : end - start - 1 + Number(rule.countAdmissionDay) + Number(includeEnd);
  return Math.max(rule.minimumDays, days);
}
