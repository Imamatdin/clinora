import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ClinicContext } from '../../server/roles.js';
import { withAudit } from '../../server/repo/audit.js';
import { priceAt as repoPriceAt } from '../../server/repo/prices.js';
import { ServiceKind } from '../import1c/model.js';
import { CATALOG_READERS, CATALOG_WRITERS, Key, authorize, fail, names, once, type Names } from './shared.js';
import type { Uzs } from '../billing/money.js';

/*
 * Catalog reads and edits for administrators (task 005, increment C3). Every mutation is a typed server
 * action: zod input, roles rechecked here, idempotency key, audit in the same transaction. Prices are
 * append-only rows; "set price" adds a dated row and never edits an old one.
 */

export const LISTS = ['service', 'department', 'serviceGroup', 'doctor', 'district', 'mahalla', 'roomType', 'expenseType'] as const;
export const CatalogList = z.enum(LISTS);
export type CatalogList = z.infer<typeof CatalogList>;
const TABLE: Record<CatalogList, string> = {
  service: 'services', department: 'departments', serviceGroup: 'service_groups', doctor: 'catalog_doctors',
  district: 'districts', mahalla: 'mahallas', roomType: 'room_types', expenseType: 'expense_types'
};

const id = z.uuid();
const name = (max = 300) => z.string().trim().min(1).max(max);
const optionalName = z.string().trim().max(300).nullable().transform(v => v || null);

export const SearchInput = z.object({
  list: CatalogList, query: z.string().trim().max(100).default(''), includeInactive: z.boolean().default(false),
  offset: z.number().int().min(0).max(100000).default(0)
}).strict();
export const SaveInput = z.object({
  list: CatalogList, id: id.optional(),
  nameUzCyrl: name(), nameUzLatn: optionalName, nameRu: optionalName,
  code: z.string().trim().max(120).nullable().transform(v => v || null),
  departmentId: id.nullable().optional(), groupId: id.nullable().optional(), districtId: id.nullable().optional(),
  kind: ServiceKind.optional(), unit: z.string().trim().min(1).max(40).optional(), trackStock: z.boolean().optional(),
  specialty: optionalName.optional(),
  idempotencyKey: Key
}).strict();
export const ActiveInput = z.object({ list: CatalogList, id, active: z.boolean(), idempotencyKey: Key }).strict();
export const PriceInput = z.object({
  serviceId: id, priceUzs: z.string().regex(/^(0|[1-9][0-9]{0,14})$/),
  /** Defaults to now. A past instant is refused: a new price never reaches back over recorded days. */
  effectiveFrom: z.iso.datetime({ offset: true }).optional(),
  idempotencyKey: Key
}).strict();
export const LinkDoctorInput = z.object({ catalogDoctorId: id, userId: id.nullable(), idempotencyKey: Key }).strict();
export const DoctorServicesInput = z.object({ userId: id, serviceIds: z.array(id).max(500), idempotencyKey: Key }).strict();

export type CatalogItem = {
  id: string; list: CatalogList; names: Names; code: string | null; active: boolean;
  departmentId?: string | null; groupId?: string | null; districtId?: string | null;
  mxikCode?: string | null; kind?: string; unit?: string; trackStock?: boolean; priceUzs?: string | null; priceFrom?: string | null;
  specialty?: string | null; linkedUserId?: string | null; linkedUserName?: string | null; serviceIds?: string[];
};

const SEARCH_KEY = "registration_fold(concat_ws(' ', t.name_uz_cyrl, t.name_uz_latn, t.name_ru, t.code_1c))";
const DOCTOR_KEY = "registration_fold(concat_ws(' ', t.full_name, t.specialty_uz_cyrl, t.specialty_uz_latn, t.specialty_ru, t.code_1c))";

/**
 * Lists one catalog, filtered by a query in any script: every word of the folded query must occur in the
 * folded Uzbek Cyrillic, Uzbek Latin or Russian name (or the 1C code). Pages of 100.
 */
export async function search(ctx: ClinicContext, raw: z.input<typeof SearchInput>): Promise<{ items: CatalogItem[]; more: boolean }> {
  ctx = await authorize(ctx, CATALOG_READERS);
  const input = SearchInput.parse(raw), table = TABLE[input.list], doctor = input.list === 'doctor';
  const select = input.list === 'service'
    ? `t.*, p.price_uzs::text price_uzs, p.effective_from price_from`
    : doctor ? `t.*, a.display_name linked_name,
        (SELECT coalesce(array_agg(ds.service_id ORDER BY ds.service_id), '{}') FROM doctor_services ds WHERE ds.clinic_id=t.clinic_id AND ds.user_id=t.linked_user_id) service_ids`
    : 't.*';
  const join = input.list === 'service'
    ? `LEFT JOIN LATERAL (SELECT price_uzs, effective_from FROM service_prices sp WHERE sp.clinic_id=t.clinic_id AND sp.service_id=t.id AND sp.effective_from<=now()
         ORDER BY effective_from DESC LIMIT 1) p ON true`
    : doctor ? 'LEFT JOIN accounts a ON a.id=t.linked_user_id' : '';
  const rows = (await ctx.tx.query(`WITH q AS (SELECT registration_fold($2) folded)
    SELECT ${select} FROM ${table} t ${join}, q
     WHERE t.clinic_id=$1 AND ($3 OR t.is_active)
       AND (q.folded='' OR NOT EXISTS (SELECT 1 FROM unnest(string_to_array(q.folded,' ')) w WHERE position(w IN ${doctor ? DOCTOR_KEY : SEARCH_KEY})=0))
     ORDER BY ${doctor ? 't.full_name' : 't.name_uz_cyrl'}, t.id LIMIT 101 OFFSET $4`,
  [ctx.clinicId, input.query, input.includeInactive, input.offset])).rows;
  return { items: rows.slice(0, 100).map(r => itemOf(input.list, r)), more: rows.length > 100 };
}

function itemOf(list: CatalogList, r: Record<string, any>): CatalogItem {
  const base = { id: r.id, list, code: r.code_1c ?? null, active: r.is_active };
  if (list === 'doctor') return { ...base, names: { uzCyrl: r.full_name, uzLatn: null, ru: null }, departmentId: r.department_id,
    specialty: r.specialty_uz_cyrl, linkedUserId: r.linked_user_id, linkedUserName: r.linked_name ?? null, serviceIds: r.service_ids ?? [] };
  const item: CatalogItem = { ...base, names: names(r as { name_uz_cyrl: string; name_uz_latn: string | null; name_ru: string | null }) };
  if ('department_id' in r) item.departmentId = r.department_id;
  if (list === 'service') Object.assign(item, { mxikCode: r.mxik_code ?? null, groupId: r.group_id, kind: r.kind, unit: r.unit, trackStock: r.track_stock,
    priceUzs: r.price_uzs ?? null, priceFrom: r.price_from ? new Date(r.price_from).toISOString() : null });
  if (list === 'mahalla') item.districtId = r.district_id;
  return item;
}

/** Pick lists for the edit forms: departments, groups, districts and staff who can be linked as doctors. */
export async function options(ctx: ClinicContext) {
  ctx = await authorize(ctx, CATALOG_READERS);
  const q = (sql: string) => ctx.tx.query(sql, [ctx.clinicId]).then(r => r.rows);
  const [departments, groups, districts, staff] = await Promise.all([
    q('SELECT id,name_uz_cyrl,name_uz_latn,name_ru FROM departments WHERE clinic_id=$1 AND is_active ORDER BY name_uz_cyrl,id'),
    q('SELECT id,department_id,name_uz_cyrl,name_uz_latn,name_ru FROM service_groups WHERE clinic_id=$1 AND is_active ORDER BY name_uz_cyrl,id'),
    q('SELECT id,name_uz_cyrl,name_uz_latn,name_ru FROM districts WHERE clinic_id=$1 AND is_active ORDER BY name_uz_cyrl,id'),
    q(`SELECT m.user_id, a.display_name FROM memberships m JOIN accounts a ON a.id=m.user_id
        WHERE m.clinic_id=$1 AND m.status='active' AND EXISTS (SELECT 1 FROM membership_roles r WHERE r.clinic_id=m.clinic_id AND r.user_id=m.user_id AND r.role='doctor')
        ORDER BY a.display_name, m.user_id`)
  ]);
  return {
    departments: departments.map(d => ({ id: d.id, names: names(d) })),
    groups: groups.map(g => ({ id: g.id, departmentId: g.department_id, names: names(g) })),
    districts: districts.map(d => ({ id: d.id, names: names(d) })),
    doctors: staff.map(s => ({ userId: s.user_id, fullName: s.display_name }))
  };
}

async function ensureRef(ctx: ClinicContext, table: string, refId: string | null | undefined) {
  if (!refId) return;
  const row = (await ctx.tx.query(`SELECT 1 FROM ${table} WHERE clinic_id=$1 AND id=$2`, [ctx.clinicId, refId])).rows[0];
  if (!row) fail('NOT_FOUND');
}

/** Creates (no id) or updates (id) one catalog row. A service's kind is fixed once created. */
export async function save(ctx: ClinicContext, raw: z.input<typeof SaveInput>): Promise<CatalogItem> {
  ctx = await authorize(ctx, CATALOG_WRITERS);
  const input = SaveInput.parse(raw);
  return once(ctx, 'catalog.save', input, async () => {
    const table = TABLE[input.list], itemId = input.id ?? randomUUID(), creating = !input.id;
    await ensureRef(ctx, 'departments', input.departmentId);
    await ensureRef(ctx, 'service_groups', input.groupId);
    await ensureRef(ctx, 'districts', input.districtId);
    let current: Record<string, any> | undefined;
    if (!creating) {
      current = (await ctx.tx.query(`SELECT * FROM ${table} WHERE clinic_id=$1 AND id=$2 FOR UPDATE`, [ctx.clinicId, itemId])).rows[0];
      if (!current) fail('NOT_FOUND');
    }
    if (input.code !== null) {
      const clash = (await ctx.tx.query(`SELECT 1 FROM ${table} WHERE clinic_id=$1 AND code_1c=$2 AND id<>$3`, [ctx.clinicId, input.code, itemId])).rows[0];
      if (clash) fail('ALREADY_EXISTS');
    }
    const n = [input.nameUzCyrl, input.nameUzLatn, input.nameRu];
    const pick = <T>(value: T | undefined, column: string, fallback: T): T => value !== undefined ? value : current ? current[column] as T : fallback;
    switch (input.list) {
      case 'service': {
        if (creating && !input.kind) fail('INVALID_INPUT');
        if (!creating && input.kind && input.kind !== current!.kind) fail('INVALID_TRANSITION');
        const values = [pick(input.groupId, 'group_id', null), pick(input.departmentId, 'department_id', null), ...n, input.code,
          pick(input.unit, 'unit', 'дона'), pick(input.trackStock, 'track_stock', input.kind === 'medicine' || input.kind === 'good')];
        if (creating) await ctx.tx.query(`INSERT INTO services(id,clinic_id,group_id,department_id,name_uz_cyrl,name_uz_latn,name_ru,code_1c,unit,track_stock,kind)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [itemId, ctx.clinicId, ...values, input.kind]);
        else await ctx.tx.query(`UPDATE services SET group_id=$3,department_id=$4,name_uz_cyrl=$5,name_uz_latn=$6,name_ru=$7,code_1c=$8,unit=$9,track_stock=$10
          WHERE clinic_id=$2 AND id=$1`, [itemId, ctx.clinicId, ...values]);
        break;
      }
      case 'doctor': {
        const values = [input.nameUzCyrl, input.code, pick(input.departmentId, 'department_id', null), pick(input.specialty, 'specialty_uz_cyrl', null)];
        if (creating) await ctx.tx.query('INSERT INTO catalog_doctors(id,clinic_id,full_name,code_1c,department_id,specialty_uz_cyrl) VALUES($1,$2,$3,$4,$5,$6)', [itemId, ctx.clinicId, ...values]);
        else await ctx.tx.query('UPDATE catalog_doctors SET full_name=$3,code_1c=$4,department_id=$5,specialty_uz_cyrl=$6 WHERE clinic_id=$2 AND id=$1', [itemId, ctx.clinicId, ...values]);
        break;
      }
      case 'serviceGroup': {
        const values = [pick(input.departmentId, 'department_id', null), ...n, input.code];
        if (creating) await ctx.tx.query('INSERT INTO service_groups(id,clinic_id,department_id,name_uz_cyrl,name_uz_latn,name_ru,code_1c) VALUES($1,$2,$3,$4,$5,$6,$7)', [itemId, ctx.clinicId, ...values]);
        else await ctx.tx.query('UPDATE service_groups SET department_id=$3,name_uz_cyrl=$4,name_uz_latn=$5,name_ru=$6,code_1c=$7 WHERE clinic_id=$2 AND id=$1', [itemId, ctx.clinicId, ...values]);
        break;
      }
      case 'mahalla': {
        const district = pick(input.districtId, 'district_id', null);
        if (!district) fail('INVALID_INPUT');
        if (creating) await ctx.tx.query('INSERT INTO mahallas(id,clinic_id,district_id,name_uz_cyrl,name_uz_latn,name_ru,code_1c) VALUES($1,$2,$3,$4,$5,$6,$7)', [itemId, ctx.clinicId, district, ...n, input.code]);
        else await ctx.tx.query('UPDATE mahallas SET district_id=$3,name_uz_cyrl=$4,name_uz_latn=$5,name_ru=$6,code_1c=$7 WHERE clinic_id=$2 AND id=$1', [itemId, ctx.clinicId, district, ...n, input.code]);
        break;
      }
      default: {
        if (creating) await ctx.tx.query(`INSERT INTO ${table}(id,clinic_id,name_uz_cyrl,name_uz_latn,name_ru,code_1c) VALUES($1,$2,$3,$4,$5,$6)`, [itemId, ctx.clinicId, ...n, input.code]);
        else await ctx.tx.query(`UPDATE ${table} SET name_uz_cyrl=$3,name_uz_latn=$4,name_ru=$5,code_1c=$6 WHERE clinic_id=$2 AND id=$1`, [itemId, ctx.clinicId, ...n, input.code]);
      }
    }
    await withAudit(ctx.tx, ctx, creating ? 'catalog.item_created' : 'catalog.item_updated', itemId, { list: input.list });
    return one(ctx, input.list, itemId);
  });
}

async function one(ctx: ClinicContext, list: CatalogList, itemId: string): Promise<CatalogItem> {
  const doctor = list === 'doctor';
  const row = (await ctx.tx.query(`SELECT t.* ${list === 'service' ? `, (SELECT price_uzs::text FROM service_prices p WHERE p.clinic_id=t.clinic_id AND p.service_id=t.id AND p.effective_from<=now() ORDER BY effective_from DESC LIMIT 1) price_uzs` : ''}
    ${doctor ? ', a.display_name linked_name' : ''} FROM ${TABLE[list]} t ${doctor ? 'LEFT JOIN accounts a ON a.id=t.linked_user_id' : ''} WHERE t.clinic_id=$1 AND t.id=$2`, [ctx.clinicId, itemId])).rows[0];
  if (!row) fail('NOT_FOUND');
  return itemOf(list, row);
}

/** Deactivates or reactivates a row. Nothing in the catalog is deleted: past charges keep pointing at it. */
export async function setActive(ctx: ClinicContext, raw: z.input<typeof ActiveInput>): Promise<CatalogItem> {
  ctx = await authorize(ctx, CATALOG_WRITERS);
  const input = ActiveInput.parse(raw);
  return once(ctx, 'catalog.set_active', input, async () => {
    const r = await ctx.tx.query(`UPDATE ${TABLE[input.list]} SET is_active=$3 WHERE clinic_id=$1 AND id=$2`, [ctx.clinicId, input.id, input.active]);
    if (!r.rowCount) fail('NOT_FOUND');
    await withAudit(ctx.tx, ctx, input.active ? 'catalog.item_activated' : 'catalog.item_deactivated', input.id, { list: input.list });
    return one(ctx, input.list, input.id);
  });
}

/** Adds a dated price row. Old rows stay; priceAt picks the row in force at any instant. */
export async function setPrice(ctx: ClinicContext, raw: z.input<typeof PriceInput>): Promise<{ priceId: string; priceUzs: string; effectiveFrom: string }> {
  ctx = await authorize(ctx, CATALOG_WRITERS);
  const input = PriceInput.parse(raw);
  return once(ctx, 'catalog.set_price', input, async () => {
    const service = (await ctx.tx.query('SELECT id FROM services WHERE clinic_id=$1 AND id=$2 FOR UPDATE', [ctx.clinicId, input.serviceId])).rows[0];
    if (!service) fail('NOT_FOUND');
    const priceId = randomUUID();
    const row = (await ctx.tx.query(`INSERT INTO service_prices(id,clinic_id,service_id,price_uzs,effective_from,set_by)
      SELECT $1,$2,$3,$4,coalesce($5::timestamptz, now()),$6 WHERE coalesce($5::timestamptz, now()) >= now() - interval '1 minute'
      ON CONFLICT (clinic_id, service_id, effective_from) DO NOTHING RETURNING effective_from`,
    [priceId, ctx.clinicId, input.serviceId, input.priceUzs, input.effectiveFrom ?? null, ctx.actorId])).rows[0];
    if (!row) fail(input.effectiveFrom ? 'INVALID_INPUT' : 'STALE_VERSION');
    await withAudit(ctx.tx, ctx, 'catalog.price_set', input.serviceId, { priceId, priceUzs: input.priceUzs });
    return { priceId, priceUzs: input.priceUzs, effectiveFrom: new Date(row.effective_from).toISOString() };
  });
}

/** Every price row of a service, newest first. */
export async function priceHistory(ctx: ClinicContext, serviceId: string) {
  ctx = await authorize(ctx, CATALOG_READERS);
  const service = (await ctx.tx.query('SELECT id FROM services WHERE clinic_id=$1 AND id=$2', [ctx.clinicId, serviceId])).rows[0];
  if (!service) fail('NOT_FOUND');
  return (await ctx.tx.query(`SELECT p.id, p.price_uzs::text price_uzs, p.effective_from, a.display_name set_by FROM service_prices p JOIN accounts a ON a.id=p.set_by
    WHERE p.clinic_id=$1 AND p.service_id=$2 ORDER BY p.effective_from DESC LIMIT 200`, [ctx.clinicId, serviceId])).rows
    .map(r => ({ id: r.id, priceUzs: r.price_uzs, effectiveFrom: new Date(r.effective_from).toISOString(), setBy: r.set_by }));
}

/**
 * Links a 1C doctor to a staff account that holds the doctor role, creating or refreshing its doctor
 * profile. Linking grants no patient access by itself: access still comes from routing (task 007).
 * userId null unlinks; the doctor profile stays (it may have history) but loses the 1C link.
 */
export async function linkDoctor(ctx: ClinicContext, raw: z.input<typeof LinkDoctorInput>): Promise<CatalogItem> {
  ctx = await authorize(ctx, CATALOG_WRITERS);
  const input = LinkDoctorInput.parse(raw);
  return once(ctx, 'catalog.link_doctor', input, async () => {
    const doc = (await ctx.tx.query('SELECT * FROM catalog_doctors WHERE clinic_id=$1 AND id=$2 FOR UPDATE', [ctx.clinicId, input.catalogDoctorId])).rows[0];
    if (!doc) fail('NOT_FOUND');
    if (input.userId) {
      const member = (await ctx.tx.query(`SELECT 1 FROM memberships m WHERE m.clinic_id=$1 AND m.user_id=$2 AND m.status='active'
        AND EXISTS (SELECT 1 FROM membership_roles r WHERE r.clinic_id=m.clinic_id AND r.user_id=m.user_id AND r.role='doctor') FOR SHARE`, [ctx.clinicId, input.userId])).rows[0];
      if (!member) fail('NOT_FOUND');
      const other = (await ctx.tx.query('SELECT id FROM catalog_doctors WHERE clinic_id=$1 AND linked_user_id=$2 AND id<>$3', [ctx.clinicId, input.userId, doc.id])).rows[0];
      if (other) fail('ALREADY_EXISTS');
      await ctx.tx.query(`INSERT INTO doctor_profiles(clinic_id,user_id,department_id,specialty_uz_cyrl,specialty_uz_latn,specialty_ru) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT (clinic_id,user_id) DO UPDATE SET department_id=coalesce(EXCLUDED.department_id, doctor_profiles.department_id),
          specialty_uz_cyrl=EXCLUDED.specialty_uz_cyrl, specialty_uz_latn=coalesce(EXCLUDED.specialty_uz_latn, doctor_profiles.specialty_uz_latn),
          specialty_ru=coalesce(EXCLUDED.specialty_ru, doctor_profiles.specialty_ru), is_active=true`,
      [ctx.clinicId, input.userId, doc.department_id, doc.specialty_uz_cyrl ?? doc.full_name, doc.specialty_uz_latn, doc.specialty_ru]);
    }
    await ctx.tx.query('UPDATE catalog_doctors SET linked_user_id=$3 WHERE clinic_id=$1 AND id=$2', [ctx.clinicId, doc.id, input.userId]);
    await withAudit(ctx.tx, ctx, input.userId ? 'catalog.doctor_linked' : 'catalog.doctor_unlinked', doc.id, input.userId ? { userId: input.userId } : null);
    return one(ctx, 'doctor', doc.id);
  });
}

/** Replaces the services a doctor performs (what registration offers at that doctor's queue point). */
export async function setDoctorServices(ctx: ClinicContext, raw: z.input<typeof DoctorServicesInput>): Promise<{ serviceIds: string[] }> {
  ctx = await authorize(ctx, CATALOG_WRITERS);
  const input = DoctorServicesInput.parse(raw);
  return once(ctx, 'catalog.doctor_services', input, async () => {
    const profile = (await ctx.tx.query('SELECT 1 FROM doctor_profiles WHERE clinic_id=$1 AND user_id=$2 FOR UPDATE', [ctx.clinicId, input.userId])).rows[0];
    if (!profile) fail('NOT_FOUND');
    const ids = [...new Set(input.serviceIds)].sort();
    const found = (await ctx.tx.query('SELECT count(*)::int n FROM services WHERE clinic_id=$1 AND id = ANY($2::uuid[])', [ctx.clinicId, ids])).rows[0].n;
    if (found !== ids.length) fail('NOT_FOUND');
    await ctx.tx.query('DELETE FROM doctor_services WHERE clinic_id=$1 AND user_id=$2 AND NOT (service_id = ANY($3::uuid[]))', [ctx.clinicId, input.userId, ids]);
    await ctx.tx.query('INSERT INTO doctor_services(clinic_id,user_id,service_id) SELECT $1,$2,unnest($3::uuid[]) ON CONFLICT DO NOTHING', [ctx.clinicId, input.userId, ids]);
    await withAudit(ctx.tx, ctx, 'catalog.doctor_services_set', input.userId, { count: ids.length });
    return { serviceIds: ids };
  });
}

/**
 * The price of a service in force at an instant (a charge's service date). Null when the service had no
 * price then: callers must refuse to charge, never treat it as zero. Clinic-scoped by construction.
 * Library function for charge-writing modules, which run inside their own authorized action.
 */
export async function priceAt(ctx: Pick<ClinicContext, 'tx' | 'clinicId'>, serviceId: string, at: Date): Promise<{ priceId: string; priceUzs: Uzs; effectiveFrom: Date } | null> {
  return repoPriceAt(ctx.tx, ctx.clinicId, serviceId, at);
}
