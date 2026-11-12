import { z } from 'zod';
import { DbId, DbInstant, DbUzs } from './common.js';

export const ChargeStatus = z.enum(['ordered', 'completed', 'cancelled']);
export const ChargeSource = z.enum(['registration', 'doctor', 'lab', 'inpatient', 'pharmacy', 'surgery', 'bed_day', 'caretaker', 'assistant']);
/**
 * quantity and unit_price_uzs never change after insert (trigger). Status moves only
 * ordered -> completed, ordered -> cancelled, completed -> cancelled (cancel_reason required).
 */
export const ChargeLineRow = z.object({
  id: DbId, clinic_id: DbId, visit_id: DbId, service_id: DbId, performer_user_id: DbId.nullable(), queue_ticket_id: DbId.nullable(),
  quantity: z.number().int().positive(), unit_price_uzs: DbUzs, status: ChargeStatus, source: ChargeSource,
  created_by: DbId, created_at: DbInstant, completed_by: DbId.nullable(), completed_at: DbInstant.nullable(),
  cancelled_by: DbId.nullable(), cancelled_at: DbInstant.nullable(), cancel_reason: z.string().nullable()
});
export type ChargeLineRow = z.infer<typeof ChargeLineRow>;
