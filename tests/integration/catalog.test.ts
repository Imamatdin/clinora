import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { httpFixture } from './fixture.js';
import { passwordHash } from '../../src/server/security.js';
import { transaction } from '../../src/server/database.js';
import { readDt } from '../../src/modules/import1c/dt.js';
import { bytes, nodeInflate } from '../../src/modules/import1c/node.js';
import { sampleSections, synthDt } from '../../src/modules/import1c/synthetic.js';
import { parseCsv, rowsFromTable, guessMapping } from '../../src/modules/import1c/table.js';
import type { ImportRow } from '../../src/modules/import1c/model.js';
import { priceAt } from '../../src/modules/catalog/actions.js';
import { fold } from '../../src/modules/catalog/shared.js';

let f: Awaited<ReturnType<typeof httpFixture>>;
type Client = ReturnType<typeof f.client>;
let admin: Client, ceo: Client, cashier: Client, foreign: Client;
const key = () => randomUUID();
const url = (p: string) => `/api/clinics/${f.owner.clinicId}/${p}`;
const ids: Record<string, string> = {};

async function member(email: string, roles: string[], name: string) {
  const userId = randomUUID(), c = f.owner.clinicId;
  await f.pool.query('INSERT INTO accounts(id,email,display_name,password_hash) VALUES($1,$2,$3,$4)', [userId, email, name, await passwordHash(f.password)]);
  await f.pool.query("INSERT INTO memberships(id,clinic_id,user_id,status,granted_by) VALUES($1,$2,$3,'active',$4)", [key(), c, userId, f.owner.userId]);
  for (const role of roles) await f.pool.query('INSERT INTO membership_roles(clinic_id,user_id,role,granted_by) VALUES($1,$2,$3,$4)', [c, userId, role, f.owner.userId]);
  return userId;
}
async function ok<T = any>(r: Response, status = 200): Promise<T> { const body = await r.json(); assert.equal(r.status, status, JSON.stringify(body)); return body as T; }

/** Uploads rows the way the browser does: one batch, pages under the 100 kB body limit, then preview. */
async function stage(client: Client, rows: ImportRow[], source: 'dt' | 'csv' | 'xlsx' = 'dt') {
  const sha = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  const batch = await ok(await client.request(url('catalog/imports'), { source, contentSha256: sha, totalRows: rows.length, idempotencyKey: key() }), 201);
  for (let offset = 0; offset < rows.length; offset += 100)
    await ok(await client.request(url(`catalog/imports/${batch.id}/rows`), { offset, rows: rows.slice(offset, offset + 100) }));
  return batch.id as string;
}
const preview = async (batchId: string) => ok(await admin.request(url(`catalog/imports/${batchId}`)));
const commit = async (batchId: string) => ok(await admin.request(url(`catalog/imports/${batchId}/commit`), { idempotencyKey: key() }));
const dtRows = async (price?: { uzi: string; consult: string }) => (await readDt(bytes(synthDt(sampleSections(price))), nodeInflate)).rows;
async function snapshot() {
  const tables = ['departments', 'service_groups', 'services', 'service_prices', 'catalog_doctors', 'districts', 'mahallas', 'room_types'];
  const out: Record<string, unknown> = {};
  for (const t of tables) out[t] = (await f.pool.query(`SELECT * FROM ${t} WHERE clinic_id=$1 ORDER BY id`, [f.owner.clinicId])).rows;
  return out;
}

test.before(async () => {
  f = await httpFixture();
  ids.admin = await member('admin.c005@example.test', ['administrator'], 'Синтетик Администратор');
  ids.ceo = await member('ceo.c005@example.test', ['ceo'], 'Синтетик Раҳбар');
  ids.cashier = await member('cashier.c005@example.test', ['cashier'], 'Синтетик Кассир');
  ids.doctor = await member('doctor.c005@example.test', ['doctor'], 'Синтетик Шифокор');
  admin = f.client(); await admin.login('admin.c005@example.test');
  ceo = f.client(); await ceo.login('ceo.c005@example.test');
  cashier = f.client(); await cashier.login('cashier.c005@example.test');
  foreign = f.client(); await foreign.login('other@example.test');
});
test.after(async () => { await f?.close(); });

test('import and catalog writes: 403 for non-administrators, 404 for another clinic, 401 anonymous', async () => {
  const some = randomUUID();
  const writes: [string, unknown][] = [['catalog/imports', {}], [`catalog/imports/${some}/rows`, {}], [`catalog/imports/${some}/commit`, {}],
    [`catalog/imports/${some}/discard`, {}], ['catalog/items', {}], ['catalog/active', {}], ['catalog/prices', {}], ['catalog/doctor-link', {}],
    ['catalog/doctor-services', {}], ['catalog/imports', undefined], [`catalog/imports/${some}`, undefined]];
  for (const [path, body] of writes) {
    assert.equal((await ceo.request(url(path), body)).status, 403, `ceo ${path}`);
    assert.equal((await cashier.request(url(path), body)).status, 403, `cashier ${path}`);
    assert.equal((await foreign.request(url(path), body)).status, 404, `foreign ${path}`);
    assert.equal((await f.client().request(url(path), body)).status, 401, `anonymous ${path}`);
  }
  // Reads: the CEO may read; a cashier may not; another clinic sees nothing.
  assert.equal((await ceo.request(url('catalog/search'), { list: 'service' })).status, 200);
  assert.equal((await cashier.request(url('catalog/search'), { list: 'service' })).status, 403);
  assert.equal((await foreign.request(url('catalog/search'), { list: 'service' })).status, 404);
});

test('synthetic .dt imports through preview and one commit; re-import changes nothing', async () => {
  const before = await snapshot();
  const rows = await dtRows();
  const batch = await stage(admin, rows);
  const p = await preview(batch);
  assert.equal(p.batch.received, rows.length);
  assert.deepEqual(p.plan.objects.service, { new: 5, changed: 0, unchanged: 0, rejected: 3, pricesNew: 4 });
  assert.equal(p.plan.objects.mahalla.rejected, 1);
  assert.deepEqual(p.plan.rejected.map((r: any) => r.reason).sort(), ['FOLDER', 'FRACTIONAL_PRICE', 'NO_DISTRICT', 'NO_NAME']);
  assert.ok(p.plan.samples.service.length > 0);
  assert.deepEqual(await snapshot(), before, 'preview writes nothing');

  const done = await commit(batch);
  assert.equal(done.status, 'committed');
  const svc = (await f.pool.query("SELECT s.*, g.code_1c group_code, d.code_1c dep_code FROM services s LEFT JOIN service_groups g ON g.id=s.group_id LEFT JOIN departments d ON d.id=s.department_id WHERE s.clinic_id=$1 AND s.code_1c='МУОЛАЖА/10902002002000003'", [f.owner.clinicId])).rows[0];
  assert.deepEqual([svc.kind, svc.name_uz_latn, svc.group_code, svc.dep_code], ['diagnostic', 'Nurlanish diagnostika Ultratovush tadqiqoti (UZI)', null, 'БУЛИМ/01']);
  const med = (await f.pool.query("SELECT kind, track_stock, unit FROM services WHERE clinic_id=$1 AND code_1c='Дорилар/D01'", [f.owner.clinicId])).rows[0];
  assert.deepEqual(med, { kind: 'medicine', track_stock: true, unit: 'таблетка' });
  const doctor = (await f.pool.query("SELECT full_name, specialty_uz_cyrl, linked_user_id FROM catalog_doctors WHERE clinic_id=$1", [f.owner.clinicId])).rows;
  assert.deepEqual(doctor, [{ full_name: 'Синтетик Шифокор Бир', specialty_uz_cyrl: null, linked_user_id: null }]);
  assert.equal(svc.mxik_code, '10902002002000003');
  const listed = await ok(await admin.request(url('catalog/search'), { list: 'service', query: 'ultratovush' }));
  assert.equal(listed.items[0].mxikCode, svc.mxik_code);
  const labMeta = (await f.pool.query("SELECT reference_range FROM services WHERE clinic_id=$1 AND code_1c='Анализ/A01'", [f.owner.clinicId])).rows[0];
  assert.equal(labMeta.reference_range, '4–9');
  const roleFlags = (await f.pool.query('SELECT source_role_flags FROM catalog_doctors WHERE clinic_id=$1', [f.owner.clinicId])).rows[0].source_role_flags;
  assert.equal(roleFlags['Кабул'], true);
  ids.uzi = svc.id;
  ids.doctorEntry = (await f.pool.query('SELECT id FROM catalog_doctors WHERE clinic_id=$1', [f.owner.clinicId])).rows[0].id;
  assert.equal((await admin.request(url(`catalog/imports/${batch}/commit`), { idempotencyKey: key() })).status, 409, 'a committed batch cannot commit again');
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM import_batch_rows WHERE batch_id=$1', [batch])).rows[0].n, 0, 'staged rows are dropped');

  const after = await snapshot();
  const again = await stage(admin, await dtRows());
  const p2 = await preview(again);
  for (const [object, c] of Object.entries(p2.plan.objects) as [string, any][]) assert.equal(c.new + c.changed + c.pricesNew, 0, object);
  await commit(again);
  assert.deepEqual(await snapshot(), after, 'second import of the same file changes nothing');
});

test('a changed price creates history; priceAt reads the price in force at the service date', async () => {
  const t1 = new Date();
  await new Promise(r => setTimeout(r, 20));
  const batch = await stage(admin, await dtRows({ uzi: '175000', consult: '100000' }));
  const p = await preview(batch);
  assert.equal(p.plan.objects.service.pricesNew, 1);
  assert.equal(p.plan.objects.service.changed, 1);
  await commit(batch);
  const history = (await f.pool.query('SELECT price_uzs::text p FROM service_prices WHERE clinic_id=$1 AND service_id=$2 ORDER BY effective_from', [f.owner.clinicId, ids.uzi])).rows.map(r => r.p);
  assert.deepEqual(history, ['150000', '175000']);
  await transaction(f.pool, async tx => {
    const ctx = { tx, clinicId: f.owner.clinicId };
    assert.equal((await priceAt(ctx, ids.uzi!, t1))!.priceUzs, 150000n);
    assert.equal((await priceAt(ctx, ids.uzi!, new Date(Date.now() + 1000)))!.priceUzs, 175000n);
    assert.equal(await priceAt(ctx, ids.uzi!, new Date('2000-01-01')), null, 'no price before the first row: never zero');
    assert.equal(await priceAt({ tx, clinicId: f.other.clinicId }, ids.uzi!, new Date()), null, 'another clinic finds nothing');
  });
  // An item price takes effect at commit time.
  const lab = (await f.pool.query("SELECT p.effective_from FROM service_prices p JOIN services s ON s.id=p.service_id WHERE s.clinic_id=$1 AND s.code_1c='Анализ/A01'", [f.owner.clinicId])).rows;
  assert.equal(lab.length, 1);
  assert.ok(new Date(lab[0].effective_from).getTime() <= t1.getTime());
});

test('dated import price rows retain timezone, conflict and retry rules', async () => {
  const row: ImportRow = { object: 'price', source: 'prices.csv', service: 'Анализ/A01', priceUzs: '40000', effectiveFrom: '2026-01-01' };
  const batch = await stage(admin, [row, { ...row, service: 'missing' }], 'csv');
  assert.equal((await preview(batch)).plan.objects.price.new, 1);
  await commit(batch);
  const dated = (await f.pool.query("SELECT p.effective_from FROM service_prices p JOIN services s ON s.id=p.service_id WHERE s.clinic_id=$1 AND s.code_1c='Анализ/A01' ORDER BY effective_from", [f.owner.clinicId])).rows;
  assert.equal(new Date(dated[0].effective_from).toISOString(), '2025-12-31T19:00:00.000Z');
  const again = await stage(admin, [row], 'csv');
  assert.equal((await preview(again)).plan.objects.price.unchanged, 1);
  const conflict = await stage(admin, [{ ...row, priceUzs: '40001' }], 'csv');
  assert.equal((await preview(conflict)).plan.rejected[0].reason, 'PRICE_CONFLICT');
});

test('server rejects an incomplete batch and malformed rows, and writes nothing', async () => {
  const before = await snapshot();
  const rows = await dtRows();
  const b = await ok(await admin.request(url('catalog/imports'), { source: 'dt', contentSha256: 'a'.repeat(64), totalRows: rows.length, idempotencyKey: key() }), 201);
  await ok(await admin.request(url(`catalog/imports/${b.id}/rows`), { offset: 0, rows: rows.slice(0, 3) }));
  assert.equal((await preview(b.id)).plan, null, 'preview waits for every row');
  assert.equal((await admin.request(url(`catalog/imports/${b.id}/commit`), { idempotencyKey: key() })).status, 409);
  assert.equal((await admin.request(url(`catalog/imports/${b.id}/rows`), { offset: rows.length, rows: rows.slice(0, 1) })).status, 422, 'rows past the declared total');
  assert.equal((await admin.request(url(`catalog/imports/${b.id}/rows`), { offset: 0, rows: [{ object: 'patient', source: 'x' }] })).status, 422);
  assert.equal((await admin.request(url(`catalog/imports/${b.id}/rows`), { offset: 0, rows: [{ ...rows[0], priceUzs: '1.5' }] })).status, 422);
  assert.equal((await foreign.request(`/api/clinics/${f.other.clinicId}/catalog/imports/${b.id}`)).status, 404, 'an administrator of another clinic cannot see this batch through their own clinic');
  await ok(await admin.request(url(`catalog/imports/${b.id}/discard`), { idempotencyKey: key() }));
  assert.deepEqual(await snapshot(), before);
});

test('spreadsheet rows match by name, resolve parents by name and share the same flow', async () => {
  const csv = parseCsv('Номи;Нархи;Булим\nЭКГ текшируви;70000;Терапия бўлими\nНомаълум;1000;Йўқ бўлим\n');
  const rows = rowsFromTable(csv, 'service', guessMapping(csv[0]!), { headerRow: true, kind: 'diagnostic', source: 'list.csv' });
  const batch = await stage(admin, rows, 'csv');
  const p = await preview(batch);
  assert.deepEqual(p.plan.objects.service, { new: 1, changed: 0, unchanged: 0, rejected: 1, pricesNew: 1 });
  assert.equal(p.plan.rejected[0].reason, 'UNKNOWN_DEPARTMENT');
  await commit(batch);
  const again = await stage(admin, rows, 'csv');
  assert.deepEqual((await preview(again)).plan.objects.service, { new: 0, changed: 0, unchanged: 1, rejected: 1, pricesNew: 0 });
});

test('search finds a service by its Cyrillic, Latin or Russian name', async () => {
  for (const query of ['ультратовуш', 'Ultratovush tadqiqoti', 'УЗИ', 'ультразвуковое исследование', 'uzi', 'nurlanish']) {
    const r = await ok(await admin.request(url('catalog/search'), { list: 'service', query }));
    assert.ok(r.items.some((i: any) => i.id === ids.uzi), query);
  }
  const none = await ok(await admin.request(url('catalog/search'), { list: 'service', query: 'zzzz' }));
  assert.equal(none.items.length, 0);
  const otherClinic = await ok(await foreign.request(`/api/clinics/${f.other.clinicId}/catalog/search`, { list: 'service', query: 'uzi' }));
  assert.equal(otherClinic.items.length, 0, 'catalog is per clinic');
});

test('manual edit, deactivate and dated price; doctor linked to a staff account', async () => {
  const created = await ok(await admin.request(url('catalog/items'), { list: 'service', nameUzCyrl: 'Синтетик муолажа', nameUzLatn: 'Sintetik muolaja', nameRu: null,
    code: null, kind: 'procedure', idempotencyKey: key() }));
  const k = key();
  const price = await ok(await admin.request(url('catalog/prices'), { serviceId: created.id, priceUzs: '50000', idempotencyKey: k }), 201);
  const replay = await ok(await admin.request(url('catalog/prices'), { serviceId: created.id, priceUzs: '50000', idempotencyKey: k }), 201);
  assert.equal(replay.priceId, price.priceId, 'double submit records one price');
  assert.equal((await admin.request(url('catalog/prices'), { serviceId: created.id, priceUzs: '1', effectiveFrom: '2020-01-01T00:00:00+05:00', idempotencyKey: key() })).status, 422, 'no back-dated prices');
  const future = await ok(await admin.request(url('catalog/prices'), { serviceId: created.id, priceUzs: '60000', effectiveFrom: '2099-01-01T00:00:00+05:00', idempotencyKey: key() }), 201);
  assert.equal(future.priceUzs, '60000');
  const history = await ok(await admin.request(url(`catalog/services/${created.id}/prices`)));
  assert.deepEqual(history.map((h: any) => h.priceUzs), ['60000', '50000']);
  const listed = await ok(await admin.request(url('catalog/search'), { list: 'service', query: 'sintetik muolaja' }));
  assert.equal(listed.items[0].priceUzs, '50000', 'the list shows the price in force now');

  const edited = await ok(await admin.request(url('catalog/items'), { list: 'service', id: created.id, nameUzCyrl: 'Синтетик муолажа 2', nameUzLatn: null, nameRu: 'Синтетическая процедура',
    code: null, idempotencyKey: key() }));
  assert.equal(edited.names.ru, 'Синтетическая процедура');
  assert.equal((await admin.request(url('catalog/items'), { list: 'service', id: created.id, nameUzCyrl: 'x', nameUzLatn: null, nameRu: null, code: null, kind: 'lab', idempotencyKey: key() })).status, 409, 'kind is fixed');
  const foreignService = randomUUID();
  assert.equal((await admin.request(url('catalog/items'), { list: 'service', id: foreignService, nameUzCyrl: 'x', nameUzLatn: null, nameRu: null, code: null, idempotencyKey: key() })).status, 404);

  await ok(await admin.request(url('catalog/active'), { list: 'service', id: created.id, active: false, idempotencyKey: key() }));
  const hidden = await ok(await admin.request(url('catalog/search'), { list: 'service', query: 'sintetik muolaja' }));
  assert.equal(hidden.items.length, 0);
  const shown = await ok(await admin.request(url('catalog/search'), { list: 'service', query: 'sintetik muolaja', includeInactive: true }));
  assert.equal(shown.items[0].active, false);

  assert.equal((await admin.request(url('catalog/doctor-link'), { catalogDoctorId: ids.doctorEntry, userId: ids.cashier, idempotencyKey: key() })).status, 404, 'only staff with the doctor role');
  const linked = await ok(await admin.request(url('catalog/doctor-link'), { catalogDoctorId: ids.doctorEntry, userId: ids.doctor, idempotencyKey: key() }));
  assert.equal(linked.linkedUserId, ids.doctor);
  const profile = (await f.pool.query('SELECT specialty_uz_cyrl FROM doctor_profiles WHERE clinic_id=$1 AND user_id=$2', [f.owner.clinicId, ids.doctor])).rows[0];
  assert.equal(profile.specialty_uz_cyrl, 'Синтетик Шифокор Бир');
  const services = await ok(await admin.request(url('catalog/doctor-services'), { userId: ids.doctor, serviceIds: [ids.uzi], idempotencyKey: key() }));
  assert.deepEqual(services.serviceIds, [ids.uzi]);
  const access = (await f.pool.query('SELECT count(*)::int n FROM patient_assignments WHERE clinic_id=$1 AND user_id=$2', [f.owner.clinicId, ids.doctor])).rows[0].n;
  assert.equal(access, 0, 'linking grants no patient access');
  const opts = await ok(await admin.request(url('catalog/options')));
  assert.ok(opts.doctors.some((d: any) => d.userId === ids.doctor) && !opts.doctors.some((d: any) => d.userId === ids.cashier));
});

test('TypeScript fold equals SQL registration_fold', async () => {
  const samples = ['Ҳасанов Ғайрат', 'Oʻzbekiston', 'Ультразвуковое исследование (УЗИ)', 'Щука Ёлка Юла Ящик Жасур Чинор', 'Kh-ts zh dj w', 'Tadqiqoti №5'];
  for (const s of samples) assert.equal(fold(s), (await f.pool.query('SELECT registration_fold($1) f', [s])).rows[0].f, s);
});
