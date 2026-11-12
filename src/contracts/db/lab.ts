import { z } from 'zod';
import { DbId, DbInstant } from './common.js';

/** One measured value. An unknown value stays null; it is never converted to zero or "normal". */
export const LabValue = z.object({
  code: z.string().min(1), value: z.union([z.number(), z.string()]).nullable(), unit: z.string().nullable(),
  referenceRange: z.string().nullable(), flag: z.enum(['low', 'normal', 'high', 'abnormal']).nullable()
});
export const LabResultBody = z.object({ values: z.array(LabValue), comment: z.string().nullable() });
/** Append-only; a correction is a new version. The highest version is current. */
export const LabResultRow = z.object({
  id: DbId, clinic_id: DbId, charge_line_id: DbId, version: z.number().int().positive(), result: LabResultBody,
  entered_by: DbId, entered_at: DbInstant
});
export type LabResultRow = z.infer<typeof LabResultRow>;
