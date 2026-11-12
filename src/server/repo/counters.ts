import type { Tx } from '../database.js';

/*
 * Gap-free per-scope counters. Each call upserts the counter row and returns the incremented value,
 * holding that row's lock until the caller's transaction ends. Concurrent callers serialize on the row,
 * so values are distinct and consecutive; a rolled-back caller releases its number for the next one.
 * Always call inside the transaction that inserts the numbered row.
 */

export async function nextPatientNo(tx: Tx, clinicId: string): Promise<number> {
  const row = (await tx.query(
    `INSERT INTO patient_counters AS c (clinic_id, last_no) VALUES ($1, 1)
     ON CONFLICT (clinic_id) DO UPDATE SET last_no = c.last_no + 1 RETURNING last_no`, [clinicId])).rows[0];
  return row.last_no as number;
}

/** Queue numbers restart every business day, independently per queue point. */
export async function nextQueueNumber(tx: Tx, clinicId: string, businessDayId: string, queuePointId: string): Promise<number> {
  const row = (await tx.query(
    `INSERT INTO queue_counters AS c (clinic_id, business_day_id, queue_point_id, last_number) VALUES ($1, $2, $3, 1)
     ON CONFLICT (business_day_id, queue_point_id) DO UPDATE SET last_number = c.last_number + 1
     WHERE c.clinic_id = EXCLUDED.clinic_id
     RETURNING last_number`, [clinicId, businessDayId, queuePointId])).rows[0];
  // The WHERE clause makes a counter row of another clinic invisible instead of advancing it.
  if (!row) throw new Error('Queue counter scope mismatch');
  return row.last_number as number;
}

/** Receipt numbers are clinic-wide and never reset. Returned as bigint (column is bigint). */
export async function nextReceiptNo(tx: Tx, clinicId: string): Promise<bigint> {
  const row = (await tx.query(
    `INSERT INTO receipt_counters AS c (clinic_id, last_no) VALUES ($1, 1)
     ON CONFLICT (clinic_id) DO UPDATE SET last_no = c.last_no + 1 RETURNING last_no`, [clinicId])).rows[0];
  return BigInt(row.last_no);
}
