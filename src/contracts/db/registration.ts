import { z } from 'zod';
import { DbDate, DbId, DbInstant, DbJson, Phone } from './common.js';

/** Core registration columns of patients. The row also keeps task-002 notebook columns (display_name, mrn, ...). */
export const PatientRow = z.object({
  id: DbId, clinic_id: DbId, patient_no: z.number().int().positive(), full_name: z.string().min(1),
  birth_date: DbDate.nullable(), gender: z.enum(['male', 'female']).nullable(), phone: Phone.nullable(),
  district_id: DbId.nullable(), mahalla_id: DbId.nullable(), address: z.string().nullable(), source: z.string().nullable(),
  display_name: z.string(), mrn: z.string().nullable(), date_of_birth: DbDate.nullable(),
  created_at: DbInstant, updated_at: DbInstant, revision: z.number().int().positive(), provenance: DbJson
});
export const VisitType = z.enum(['outpatient', 'inpatient']);
export const VisitStatus = z.enum(['open', 'closed', 'cancelled']);
/** Status moves only open -> closed or open -> cancelled (trigger). */
export const VisitRow = z.object({
  id: DbId, clinic_id: DbId, patient_id: DbId, business_day_id: DbId, type: VisitType, status: VisitStatus,
  created_by: DbId, created_at: DbInstant, closed_at: DbInstant.nullable()
});

export type PatientRow = z.infer<typeof PatientRow>;
export type VisitRow = z.infer<typeof VisitRow>;
