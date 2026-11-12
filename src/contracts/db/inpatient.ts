import { z } from 'zod';
import { DbDate, DbId, DbInstant, Phone } from './common.js';

export const AdmissionRow = z.object({
  id: DbId, clinic_id: DbId, visit_id: DbId, department_id: DbId, attending_user_id: DbId,
  admitted_at: DbInstant, expected_discharge: DbDate.nullable(), discharged_at: DbInstant.nullable(),
  status: z.enum(['admitted', 'discharged'])
});
/** At most one open (to_at null) assignment per bed and per admission. Closing is write-once. */
export const BedAssignmentRow = z.object({
  id: DbId, clinic_id: DbId, admission_id: DbId, bed_id: DbId, from_at: DbInstant, to_at: DbInstant.nullable()
});
export const CaretakerRow = z.object({
  id: DbId, clinic_id: DbId, admission_id: DbId, full_name: z.string().min(1), phone: Phone.nullable(),
  from_date: DbDate, to_date: DbDate.nullable(), daily_service_id: DbId.nullable()
});
/** One row per admission per date: the daily job is idempotent by primary key. */
export const BedDayChargeRow = z.object({ clinic_id: DbId, admission_id: DbId, charge_date: DbDate, charge_line_id: DbId });
export const CaretakerDayChargeRow = z.object({ clinic_id: DbId, caretaker_id: DbId, charge_date: DbDate, charge_line_id: DbId });
export const SurgeryRow = z.object({
  id: DbId, clinic_id: DbId, visit_id: DbId, admission_id: DbId.nullable(), surgeon_user_id: DbId, service_id: DbId,
  performed_at: DbInstant, document_id: DbId.nullable(), created_by: DbId, created_at: DbInstant
});

export type AdmissionRow = z.infer<typeof AdmissionRow>;
export type BedAssignmentRow = z.infer<typeof BedAssignmentRow>;
export type CaretakerRow = z.infer<typeof CaretakerRow>;
export type BedDayChargeRow = z.infer<typeof BedDayChargeRow>;
export type CaretakerDayChargeRow = z.infer<typeof CaretakerDayChargeRow>;
export type SurgeryRow = z.infer<typeof SurgeryRow>;
