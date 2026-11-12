import { z } from 'zod';
import { DbId, DbInstant, DbUzs } from './common.js';

export const StockReason = z.enum(['receipt', 'dispense', 'adjustment', 'return']);
/**
 * Append-only. qty > 0 in, < 0 out; receipt/return are positive, dispense negative and linked to a
 * visit and charge line. Stock on hand = sum(qty). Going below zero needs an approved adjustment (action rule).
 */
export const StockMovementRow = z.object({
  id: DbId, clinic_id: DbId, service_id: DbId, qty: z.number().int().refine(q => q !== 0), reason: StockReason,
  visit_id: DbId.nullable(), charge_line_id: DbId.nullable(), unit_cost_uzs: DbUzs.nullable(),
  supplier: z.string().nullable(), note: z.string().nullable(), created_by: DbId, created_at: DbInstant
});
export type StockMovementRow = z.infer<typeof StockMovementRow>;
