import { z } from 'zod';
import { DbBp, DbDate, DbId, DbInstant, DbUzs, ServiceKind } from './common.js';

/** Append-only. The rule in force on a date is the latest effective_from <= that date. */
export const DoctorSplitRuleRow = z.object({
  id: DbId, clinic_id: DbId, user_id: DbId, doctor_share_bp: DbBp, basis: z.enum(['billed', 'paid']),
  discount_bearer: z.enum(['clinic', 'doctor', 'proportional']), categories: z.array(ServiceKind).min(1),
  effective_from: DbDate, created_by: DbId, created_at: DbInstant
});
export const PayrollPeriodRow = z.object({
  id: DbId, clinic_id: DbId, from_date: DbDate, to_date: DbDate, status: z.enum(['draft', 'final']),
  finalized_by: DbId.nullable(), finalized_at: DbInstant.nullable()
});
/** Snapshot written while finalizing; immutable, and never inserted into a final period. */
export const PayrollLineRow = z.object({
  id: DbId, clinic_id: DbId, period_id: DbId, user_id: DbId, charge_line_id: DbId, rule_id: DbId,
  entitlement_uzs: DbUzs, from_receipts_uzs: DbUzs, clinic_funded_uzs: DbUzs
});

export type DoctorSplitRuleRow = z.infer<typeof DoctorSplitRuleRow>;
export type PayrollPeriodRow = z.infer<typeof PayrollPeriodRow>;
export type PayrollLineRow = z.infer<typeof PayrollLineRow>;
