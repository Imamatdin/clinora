declare const uzsBrand: unique symbol;
/** Whole, nonnegative Uzbek som. Convert transport strings at the boundary. */
export type Uzs = bigint & { readonly [uzsBrand]: 'Uzs' };

export function uzs(value: bigint | number | string): Uzs {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new RangeError('UZS number must be a safe integer');
  }
  if (typeof value === 'string' && !/^\d+$/.test(value)) {
    throw new RangeError('UZS string must contain whole digits only');
  }
  if (!['bigint', 'number', 'string'].includes(typeof value)) throw new TypeError('Invalid UZS');
  const amount = BigInt(value);
  if (amount < 0n) throw new RangeError('UZS cannot be negative');
  return amount as Uzs;
}

export function formatUzs(value: Uzs): string {
  return `${uzs(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} сўм`;
}

export function integer(value: number, minimum: number, maximum = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`Expected integer between ${minimum} and ${maximum}`);
  }
}

export function nonempty(value: string): void {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('Non-empty identifier or reason required');
}

export function min(a: bigint, b: bigint): bigint { return a < b ? a : b; }
