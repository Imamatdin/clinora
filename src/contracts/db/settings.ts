import { z } from 'zod';
import { DbId, DbInstant, Locale } from './common.js';

export const BedDayRule = z.object({ countAdmissionDay: z.boolean(), countDischargeDay: z.boolean(), minimumDays: z.number().int().min(0).max(365) });
export const ReceiptHeader = z.object({
  name: z.string().optional(), address: z.string().optional(), phone: z.string().optional(), taxId: z.string().optional()
});
export const ClinicSettingsRow = z.object({
  clinic_id: DbId, default_locale: Locale, bed_day_rule: BedDayRule, receipt_header: ReceiptHeader,
  updated_by: DbId.nullable(), updated_at: DbInstant
});
export type ClinicSettingsRow = z.infer<typeof ClinicSettingsRow>;
