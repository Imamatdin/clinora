import { z } from 'zod';
import { DbId, DbInstant, DbUzs, Names, ServiceKind } from './common.js';

const base = { id: DbId, clinic_id: DbId };
const code = { code_1c: z.string().nullable() };

export const DepartmentRow = z.object({ ...base, ...Names, ...code, is_active: z.boolean() });
export const ServiceGroupRow = z.object({ ...base, department_id: DbId.nullable(), ...Names, ...code, is_active: z.boolean() });
export const ServiceRow = z.object({
  ...base, group_id: DbId.nullable(), department_id: DbId.nullable(), kind: ServiceKind, ...Names, ...code,
  unit: z.string().min(1), track_stock: z.boolean(), is_active: z.boolean()
});
/** Append-only. Price at time t = latest row with effective_from <= t (see repo/priceAt). */
export const ServicePriceRow = z.object({
  ...base, service_id: DbId, price_uzs: DbUzs, effective_from: DbInstant, set_by: DbId, created_at: DbInstant
});
export const DoctorProfileRow = z.object({
  clinic_id: DbId, user_id: DbId, department_id: DbId.nullable(),
  specialty_uz_cyrl: z.string().min(1), specialty_uz_latn: z.string().nullable(), specialty_ru: z.string().nullable(),
  is_active: z.boolean()
});
export const DoctorServiceRow = z.object({ clinic_id: DbId, user_id: DbId, service_id: DbId });
export const DistrictRow = z.object({ ...base, ...Names, ...code });
export const MahallaRow = z.object({ ...base, district_id: DbId, ...Names, ...code });
export const RoomTypeRow = z.object({ ...base, ...Names, ...code });
export const RoomRow = z.object({ ...base, department_id: DbId.nullable(), room_type_id: DbId.nullable(), name: z.string().min(1), is_active: z.boolean() });
/** bed_service_id must be a service of kind 'bed' (trigger); its price is the daily bed price. */
export const BedRow = z.object({ ...base, room_id: DbId, label: z.string().min(1), bed_service_id: DbId, is_active: z.boolean() });
export const ExpenseTypeRow = z.object({ ...base, ...Names, ...code, is_active: z.boolean() });

export type DepartmentRow = z.infer<typeof DepartmentRow>;
export type ServiceGroupRow = z.infer<typeof ServiceGroupRow>;
export type ServiceRow = z.infer<typeof ServiceRow>;
export type ServicePriceRow = z.infer<typeof ServicePriceRow>;
export type DoctorProfileRow = z.infer<typeof DoctorProfileRow>;
export type DoctorServiceRow = z.infer<typeof DoctorServiceRow>;
export type DistrictRow = z.infer<typeof DistrictRow>;
export type MahallaRow = z.infer<typeof MahallaRow>;
export type RoomTypeRow = z.infer<typeof RoomTypeRow>;
export type RoomRow = z.infer<typeof RoomRow>;
export type BedRow = z.infer<typeof BedRow>;
export type ExpenseTypeRow = z.infer<typeof ExpenseTypeRow>;
