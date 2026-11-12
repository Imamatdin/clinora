import { z } from 'zod';
import { uzs } from '../../modules/billing/money.js';

/**
 * Row-level building blocks for the core schema (db/migrations/010_core_schema.sql, docs/DATA-MODEL.md).
 * Row schemas parse what `pg` returns: snake_case keys, bigint as string, timestamptz as Date,
 * date as 'YYYY-MM-DD' (src/server/database.ts disables date parsing). Output types are what features use.
 */
export const DbId = z.string().uuid();
/** Whole UZS. pg returns bigint as a string; parsed into the billing Uzs bigint. */
export const DbUzs = z.union([z.string().regex(/^\d+$/), z.bigint().nonnegative(), z.number().int().nonnegative().safe()]).transform(v => uzs(v));
/** Signed whole number for counters stored as bigint (receipt numbers). */
export const DbBigint = z.union([z.string().regex(/^-?\d+$/), z.bigint(), z.number().int().safe()]).transform(v => BigInt(v));
export const DbBp = z.number().int().min(0).max(10000);
export const DbDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const DbInstant = z.date();
export const DbJson = z.record(z.string(), z.unknown());
export const Locale = z.enum(['uz-Cyrl', 'uz-Latn', 'ru']);
export const Phone = z.string().regex(/^\+[1-9][0-9]{7,14}$/);

/** Three-script names on catalog rows. Only Uzbek Cyrillic is required. */
export const Names = {
  name_uz_cyrl: z.string().min(1),
  name_uz_latn: z.string().nullable(),
  name_ru: z.string().nullable()
};
export const ServiceKind = z.enum(['consultation', 'procedure', 'lab', 'diagnostic', 'bed', 'surgery', 'medicine', 'good', 'caretaker', 'other']);
export type ServiceKind = z.infer<typeof ServiceKind>;
