import { z } from 'zod';
import { DbBigint, DbBp, DbId, DbInstant, DbJson, DbUzs } from './common.js';

export const CashDeskRow = z.object({ id: DbId, clinic_id: DbId, name: z.string().min(1), is_active: z.boolean() });
/** At most one open shift per desk (partial unique index). A closed shift is immutable. */
export const CashShiftRow = z.object({
  id: DbId, clinic_id: DbId, cash_desk_id: DbId, business_day_id: DbId, cashier_user_id: DbId,
  opened_at: DbInstant, opening_cash_uzs: DbUzs, closed_at: DbInstant.nullable(), counted_cash_uzs: DbUzs.nullable(),
  close_report: DbJson.nullable(), status: z.enum(['open', 'closed'])
});
/** Reason and approver are mandatory. Only the void columns may be set, once. */
export const DiscountRow = z.object({
  id: DbId, clinic_id: DbId, visit_id: DbId, charge_line_id: DbId.nullable(), kind: z.enum(['percent', 'fixed']),
  percent_bp: DbBp.nullable(), amount_uzs: DbUzs.nullable(), reason: z.string().min(1), approved_by: DbId,
  created_by: DbId, created_at: DbInstant, voided_by: DbId.nullable(), voided_at: DbInstant.nullable(), void_reason: z.string().nullable()
});
export const PaymentMethod = z.enum(['cash', 'card', 'transfer']);
/** Append-only. A refund is a new row of kind 'refund' referencing the original payment. */
export const PaymentRow = z.object({
  id: DbId, clinic_id: DbId, visit_id: DbId, cash_shift_id: DbId, business_day_id: DbId,
  kind: z.enum(['payment', 'refund']), method: PaymentMethod, amount_uzs: DbUzs, refund_of: DbId.nullable(),
  idempotency_key: z.string().min(8).max(200), received_by: DbId, created_at: DbInstant
});
export const PaymentAllocationRow = z.object({ clinic_id: DbId, payment_id: DbId, charge_line_id: DbId, amount_uzs: DbUzs });
/** Immutable except print_count, which only increases. */
export const ReceiptRow = z.object({
  id: DbId, clinic_id: DbId, receipt_no: DbBigint, visit_id: DbId, payment_id: DbId.nullable(),
  kind: z.enum(['payment', 'refund', 'invoice']), snapshot: DbJson, issued_by: DbId, issued_at: DbInstant,
  print_count: z.number().int().min(0)
});
export const CashOutRow = z.object({
  id: DbId, clinic_id: DbId, cash_shift_id: DbId, business_day_id: DbId, expense_type_id: DbId,
  amount_uzs: DbUzs, note: z.string().nullable(), created_by: DbId, created_at: DbInstant
});

export type CashDeskRow = z.infer<typeof CashDeskRow>;
export type CashShiftRow = z.infer<typeof CashShiftRow>;
export type DiscountRow = z.infer<typeof DiscountRow>;
export type PaymentRow = z.infer<typeof PaymentRow>;
export type PaymentAllocationRow = z.infer<typeof PaymentAllocationRow>;
export type ReceiptRow = z.infer<typeof ReceiptRow>;
export type CashOutRow = z.infer<typeof CashOutRow>;
