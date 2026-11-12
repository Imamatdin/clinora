import { randomUUID } from 'node:crypto';
import type { Tx } from '../../server/database.js';
import { fold } from '../catalog/shared.js';
import type { ImportObject, ParsedImportRow, RejectReason } from './model.js';

/*
 * Import plan: decides, for every staged row, whether it is new, changed, unchanged or rejected, by
 * comparing with the clinic's current catalog. Preview shows the plan; commit recomputes it inside the
 * commit transaction and applies exactly that, so the preview and the result cannot drift.
 *
 * Rules: rows match existing rows by code (1C code), else (spreadsheets without codes) by folded name.
 * Import never deletes, deactivates or clears: an empty source field leaves the existing value. A
 * changed price adds a service_prices row; an identical price adds nothing. Re-importing the same file
 * therefore changes nothing.
 */

export type Outcome = 'new' | 'changed' | 'unchanged' | 'rejected';
export type PlannedRow = { seq: number; row: ParsedImportRow; outcome: Outcome; reason: RejectReason | null; id: string | null; priceOutcome?: 'new' | 'unchanged' };
type Existing = Record<string, any> & { id: string };
type Table = { name: string; rows: Existing[]; byCode: Map<string, Existing>; byName: Map<string, Existing[]> };

const TABLES: Record<Exclude<ImportObject, 'price'>, string> = {
  department: 'departments', serviceGroup: 'service_groups', service: 'services', doctor: 'catalog_doctors',
  district: 'districts', mahalla: 'mahallas', roomType: 'room_types', expenseType: 'expense_types'
};
const ORDER: ImportObject[] = ['department', 'serviceGroup', 'district', 'mahalla', 'roomType', 'expenseType', 'service', 'doctor', 'price'];
const nameColumn = (object: ImportObject) => object === 'doctor' ? 'full_name' : 'name_uz_cyrl';

type Write = { table: string; id: string; values: Record<string, unknown> };
export type Plan = {
  rows: PlannedRow[];
  inserts: Write[]; updates: Write[];
  prices: { id: string; serviceId: string; priceUzs: string; effectiveFrom: string | null }[];
};

export async function buildPlan(tx: Tx, clinicId: string, staged: { seq: number; row: ParsedImportRow }[]): Promise<Plan> {
  const tables = {} as Record<Exclude<ImportObject, 'price'>, Table>;
  for (const [object, name] of Object.entries(TABLES) as [Exclude<ImportObject, 'price'>, string][]) {
    const rows = (await tx.query(`SELECT * FROM ${name} WHERE clinic_id=$1`, [clinicId])).rows as Existing[];
    const byCode = new Map<string, Existing>(), byName = new Map<string, Existing[]>();
    for (const r of rows) {
      if (r.code_1c) byCode.set(r.code_1c, r);
      const key = fold(r[nameColumn(object)]); byName.set(key, [...byName.get(key) ?? [], r]);
    }
    tables[object] = { name, rows, byCode, byName };
  }
  const tz = (await tx.query('SELECT timezone FROM clinics WHERE id=$1', [clinicId])).rows[0]?.timezone ?? 'Asia/Tashkent';
  const prices = new Map<string, { at: string | null; priceUzs: string }[]>(); // service id -> rows (at null = "now")
  for (const p of (await tx.query(`SELECT service_id, price_uzs::text price_uzs, effective_from FROM service_prices WHERE clinic_id=$1 ORDER BY effective_from`, [clinicId])).rows)
    prices.set(p.service_id, [...prices.get(p.service_id) ?? [], { at: new Date(p.effective_from).toISOString(), priceUzs: p.price_uzs }]);
  const instantOf = new Map<string, string>();
  for (const d of new Set(staged.map(s => s.row.effectiveFrom).filter((v): v is string => !!v)))
    instantOf.set(d, new Date((await tx.query(`SELECT CASE WHEN $1 ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN ($1::date::timestamp AT TIME ZONE $2) ELSE $1::timestamptz END AS at`, [d, tz])).rows[0].at).toISOString());
  const nowIso = new Date((await tx.query('SELECT now() AS now')).rows[0].now).toISOString();

  const plan: Plan = { rows: [], inserts: [], updates: [], prices: [] };
  /** Batch rows accepted so far, so later rows can reference them before they exist in the database. */
  const batch = {} as Record<ImportObject, { byCode: Map<string, string>; byName: Map<string, string[]>; values: Map<string, Record<string, unknown>> }>;
  for (const o of ORDER) batch[o] = { byCode: new Map(), byName: new Map(), values: new Map() };

  /** Resolves a parent reference (code first, then folded name) to an id, existing or planned in this batch. */
  const resolve = (object: Exclude<ImportObject, 'price'>, ref: string | null): string | null | undefined => {
    if (!ref) return null;
    const b = batch[object], t = tables[object];
    const byCode = b.byCode.get(ref) ?? t.byCode.get(ref)?.id;
    if (byCode) return byCode;
    const key = fold(ref);
    const names = [...new Set([...(b.byName.get(key) ?? []), ...(t.byName.get(key) ?? []).map(r => r.id)])];
    return names.length === 1 ? names[0] : undefined; // undefined: given but not found (or ambiguous)
  };
  const departmentOfGroup = (groupId: string | null) => groupId ? (batch.serviceGroup.values.get(groupId)?.department_id as string | null | undefined)
    ?? tables.serviceGroup.rows.find(g => g.id === groupId)?.department_id ?? null : null;

  const sorted = [...staged].sort((a, b) => ORDER.indexOf(a.row.object) - ORDER.indexOf(b.row.object) || a.seq - b.seq);
  for (const { seq, row } of sorted) {
    const reject = (reason: RejectReason) => { plan.rows.push({ seq, row, outcome: 'rejected', reason, id: null }); };
    if (row.rejected) { reject(row.rejected as RejectReason); continue; }
    if (row.object === 'price') {
      const serviceId = resolve('service', row.service);
      if (!row.service) { reject('NO_SERVICE'); continue; }
      if (!serviceId) { reject('UNKNOWN_SERVICE'); continue; }
      if (row.priceUzs === null) { reject('BAD_PRICE'); continue; }
      const at = row.effectiveFrom ? instantOf.get(row.effectiveFrom)! : null;
      const list = prices.get(serviceId) ?? [];
      const same = at ? list.find(p => p.at === at) : null;
      if (same && same.priceUzs !== row.priceUzs) { reject('PRICE_CONFLICT'); continue; }
      if (same) { plan.rows.push({ seq, row, outcome: 'unchanged', reason: null, id: serviceId, priceOutcome: 'unchanged' }); continue; }
      if (!at && list.some(p => p.at === null)) { reject('PRICE_CONFLICT'); continue; }
      if (!at && current(list, nowIso) === row.priceUzs) { plan.rows.push({ seq, row, outcome: 'unchanged', reason: null, id: serviceId, priceOutcome: 'unchanged' }); continue; }
      addPrice(plan, prices, serviceId, row.priceUzs, at);
      plan.rows.push({ seq, row, outcome: 'new', reason: null, id: serviceId, priceOutcome: 'new' });
      continue;
    }
    const object = row.object, t = tables[object], b = batch[object];
    if (!row.nameUzCyrl) { reject('NO_NAME'); continue; }
    if (row.code && b.byCode.has(row.code)) { reject('DUPLICATE_CODE'); continue; }
    const nameKey = fold(row.nameUzCyrl);
    if (!row.code && (b.byName.get(nameKey)?.length ?? 0) > 0) { reject('DUPLICATE_CODE'); continue; }
    let existing = row.code ? t.byCode.get(row.code) : undefined;
    if (!existing && !row.code) { const hits = t.byName.get(nameKey) ?? []; if (hits.length === 1) existing = hits[0]; }

    const values: Record<string, unknown> = {};
    const setText = (column: string, value: string | null) => { if (value !== null) values[column] = value; };
    if (object === 'doctor' && row.doctorRoles) values.source_role_flags = row.doctorRoles;
    if (object === 'doctor') { values.full_name = row.nameUzCyrl; setText('specialty_uz_cyrl', row.specialty); }
    else { values.name_uz_cyrl = row.nameUzCyrl; setText('name_uz_latn', row.nameUzLatn); setText('name_ru', row.nameRu); }
    if (row.code) values.code_1c = row.code;
    if (['serviceGroup', 'service', 'doctor'].includes(object)) {
      const dep = resolve('department', row.department);
      if (dep === undefined) { reject('UNKNOWN_DEPARTMENT'); continue; }
      if (dep) values.department_id = dep;
    }
    if (object === 'service') {
      const group = resolve('serviceGroup', row.group);
      if (group === undefined) { reject('UNKNOWN_GROUP'); continue; }
      if (group) { values.group_id = group; if (values.department_id === undefined) { const d = departmentOfGroup(group); if (d) values.department_id = d; } }
      // A service's kind is fixed once saved (trigger); an existing row keeps its kind.
      if (!existing) { values.kind = row.kind ?? 'procedure'; values.track_stock = row.trackStock; }
      else if (row.trackStock) values.track_stock = true;
      setText('unit', row.unit); setText('mxik_code', row.mxikCode); setText('reference_range', row.referenceRange);
    }
    if (object === 'mahalla') {
      const district = resolve('district', row.district);
      if (district === undefined) { reject('UNKNOWN_DISTRICT'); continue; }
      if (!district && !existing) { reject('NO_DISTRICT'); continue; }
      if (district) values.district_id = district;
    }

    let id: string, outcome: Outcome;
    if (existing) {
      id = existing.id;
      const changed = Object.entries(values).filter(([k, v]) => (k === 'source_role_flags' ? Object.entries(v as Record<string, boolean>).some(([key, value]) => existing![k]?.[key] !== value) : String(existing![k] ?? '') !== String(v ?? '')));
      outcome = changed.length ? 'changed' : 'unchanged';
      if (changed.length) plan.updates.push({ table: t.name, id, values: Object.fromEntries(changed) });
    } else {
      id = randomUUID(); outcome = 'new';
      plan.inserts.push({ table: t.name, id, values });
    }
    if (row.code) b.byCode.set(row.code, id);
    b.byName.set(nameKey, [...b.byName.get(nameKey) ?? [], id]);
    b.values.set(id, { ...existing, ...values });
    const planned: PlannedRow = { seq, row, outcome, reason: null, id };
    if (object === 'service' && row.priceUzs !== null) {
      // A price on the item row means "the price now": compared with the price in force at commit time.
      if (current(prices.get(id) ?? [], nowIso) === row.priceUzs) planned.priceOutcome = 'unchanged';
      else { addPrice(plan, prices, id, row.priceUzs, null); planned.priceOutcome = 'new'; if (outcome === 'unchanged') planned.outcome = 'changed'; }
    }
    plan.rows.push(planned);
  }
  plan.rows.sort((a, b) => a.seq - b.seq);
  return plan;
}

function current(list: { at: string | null; priceUzs: string }[], nowIso: string): string | null {
  let best: { at: string; priceUzs: string } | null = null;
  for (const p of list) { const at = p.at ?? nowIso; if (at <= nowIso && (!best || at >= best.at)) best = { at, priceUzs: p.priceUzs }; }
  return best?.priceUzs ?? null;
}
function addPrice(plan: Plan, prices: Map<string, { at: string | null; priceUzs: string }[]>, serviceId: string, priceUzs: string, at: string | null) {
  plan.prices.push({ id: randomUUID(), serviceId, priceUzs, effectiveFrom: at });
  prices.set(serviceId, [...prices.get(serviceId) ?? [], { at, priceUzs }]);
}

const COLUMN_TYPES: Record<string, string> = {
  id: 'uuid', department_id: 'uuid', group_id: 'uuid', district_id: 'uuid', track_stock: 'boolean', source_role_flags: 'jsonb'
};
const typeOf = (c: string) => COLUMN_TYPES[c] ?? 'text';

/** Applies a plan in the caller's transaction, set-based (one statement per table and column set). */
export async function applyPlan(tx: Tx, clinicId: string, actorId: string, plan: Plan): Promise<void> {
  const order = ['departments', 'service_groups', 'districts', 'mahallas', 'room_types', 'expense_types', 'services', 'catalog_doctors'];
  const groups = new Map<string, Write[]>();
  for (const w of plan.inserts) { const key = `${w.table}|${Object.keys(w.values).sort().join(',')}`; groups.set(key, [...groups.get(key) ?? [], w]); }
  for (const table of order) for (const [key, writes] of groups) {
    if (!key.startsWith(table + '|')) continue;
    const columns = ['id', ...key.split('|')[1]!.split(',')];
    await tx.query(`INSERT INTO ${table}(clinic_id,${columns.join(',')}) SELECT $1,${columns.map(c => `x.${c}`).join(',')}
      FROM jsonb_to_recordset($2::jsonb) AS x(${columns.map(c => `${c} ${typeOf(c)}`).join(',')})`,
    [clinicId, JSON.stringify(writes.map(w => ({ id: w.id, ...w.values })))]);
  }
  for (const w of plan.updates) {
    const columns = Object.keys(w.values);
    await tx.query(`UPDATE ${w.table} SET ${columns.map((c, i) => `${c}=$${i + 3}::${typeOf(c)}`).join(',')} WHERE clinic_id=$1 AND id=$2`,
      [clinicId, w.id, ...columns.map(c => w.values[c])]);
  }
  if (plan.prices.length) await tx.query(`INSERT INTO service_prices(id,clinic_id,service_id,price_uzs,effective_from,set_by)
    SELECT x.id,$1,x.service_id,x.price_uzs,coalesce(x.effective_from,now()),$2 FROM jsonb_to_recordset($3::jsonb) AS x(id uuid, service_id uuid, price_uzs bigint, effective_from timestamptz)`,
  [clinicId, actorId, JSON.stringify(plan.prices.map(p => ({ id: p.id, service_id: p.serviceId, price_uzs: p.priceUzs, effective_from: p.effectiveFrom })))]);
}
