import { z } from 'zod';

/*
 * The one row shape every import source produces (.dt reader, .xlsx, .csv) and the server stages.
 * Rows carry catalog reference data only. Parents are referenced by code (or, for spreadsheets, by
 * name) and resolved on the server against the batch and the clinic's existing catalog.
 */

export const IMPORT_OBJECTS = ['department', 'serviceGroup', 'service', 'doctor', 'district', 'mahalla', 'roomType', 'expenseType', 'price'] as const;
export const ImportObject = z.enum(IMPORT_OBJECTS);
export type ImportObject = z.infer<typeof ImportObject>;
export const SERVICE_KINDS = ['consultation', 'procedure', 'lab', 'diagnostic', 'bed', 'surgery', 'medicine', 'good', 'caretaker', 'other'] as const;
export const ServiceKind = z.enum(SERVICE_KINDS);
export type ServiceKind = z.infer<typeof ServiceKind>;

const text = (max: number) => z.string().trim().min(1).max(max);
const optional = (max: number) => z.string().trim().max(max).transform(v => v || null).nullable().optional().transform(v => v ?? null);
/** Whole UZS as a decimal string, so no float ever touches a price. */
export const PriceText = z.string().regex(/^(0|[1-9][0-9]{0,14})$/);

export const ImportRow = z.object({
  object: ImportObject,
  /** 1C code (namespaced by 1C object for .dt rows) or the spreadsheet's code column. */
  code: optional(120),
  nameUzCyrl: optional(300), nameUzLatn: optional(300), nameRu: optional(300),
  /** Parent references: a code, or for spreadsheets a code or a name. */
  department: optional(300), group: optional(300), district: optional(300),
  /** Price rows: the service the price belongs to. */
  service: optional(300),
  kind: ServiceKind.nullable().optional().transform(v => v ?? null),
  unit: optional(40),
  mxikCode: optional(100), referenceRange: optional(1000),
  // Reference flags only; these never grant staff permissions.
  doctorRoles: z.object({ 'Кабул': z.boolean(), 'Стационар': z.boolean(), 'Лабаратория': z.boolean(), 'УЗИ': z.boolean() }).nullable().optional().transform(v => v ?? null),
  trackStock: z.boolean().optional().transform(v => v ?? false),
  priceUzs: PriceText.nullable().optional().transform(v => v ?? null),
  /** ISO date or instant the price applies from; null means "from commit time". */
  effectiveFrom: z.iso.datetime({ offset: true }).or(z.iso.date()).nullable().optional().transform(v => v ?? null),
  specialty: optional(200),
  /** Set by the reader when a source row cannot be used; the server keeps the reason for the preview. */
  rejected: z.string().regex(/^[A-Z_]{3,40}$/).nullable().optional().transform(v => v ?? null),
  /** Which source object or sheet the row came from (e.g. "МУОЛАЖА"), for the preview only. */
  source: text(80)
}).strict();
export type ImportRow = z.input<typeof ImportRow>;
export type ParsedImportRow = z.output<typeof ImportRow>;

/** Reasons a row is rejected, by the reader or by the server. Labels live in the web dictionaries. */
export const REJECT_REASONS = [
  'NO_NAME', 'NO_CODE', 'BAD_PRICE', 'FRACTIONAL_PRICE', 'NO_SERVICE', 'UNKNOWN_SERVICE', 'UNKNOWN_DEPARTMENT', 'UNKNOWN_GROUP',
  'UNKNOWN_DISTRICT', 'NO_DISTRICT', 'DUPLICATE_CODE', 'KIND_CHANGED', 'PRICE_CONFLICT', 'FOLDER', 'DELETED', 'NO_PRICE_DATE'
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];
