import { uzs, type Uzs } from '../../modules/billing/money.js';
import type { Tx } from '../database.js';

/**
 * Price of a service at instant `at`: the latest service_prices row with effective_from <= at.
 * Returns null when the service has no price yet at that instant (callers must refuse to charge,
 * never treat it as zero). Scoped by clinic, so another clinic's service id finds nothing.
 */
export async function priceAt(tx: Tx, clinicId: string, serviceId: string, at: Date): Promise<{ priceId: string; priceUzs: Uzs; effectiveFrom: Date } | null> {
  const row = (await tx.query(
    `SELECT id, price_uzs, effective_from FROM service_prices
      WHERE clinic_id = $1 AND service_id = $2 AND effective_from <= $3
      ORDER BY effective_from DESC LIMIT 1`, [clinicId, serviceId, at])).rows[0];
  return row ? { priceId: row.id, priceUzs: uzs(row.price_uzs), effectiveFrom: row.effective_from } : null;
}
