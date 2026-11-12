import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ClinicContext } from '../../server/roles.js';
import { withAudit } from '../../server/repo/audit.js';
import { CATALOG_WRITERS, Key, authorize, fail, once } from '../catalog/shared.js';
import { IMPORT_OBJECTS, ImportRow, type ImportObject, type ParsedImportRow } from './model.js';
import { applyPlan, buildPlan, type Plan } from './plan.js';

/*
 * Import flow (task 005): create a batch, upload its rows in pages, preview, commit in one transaction.
 * Administrator only. The browser parses the file (.dt, .xlsx, .csv) and sends only catalog rows; the
 * server validates every row again and decides everything that matters (matching, prices, rejections).
 */

export const IMPORTERS = CATALOG_WRITERS;
export const PAGE_ROWS = 500;

export const BatchInput = z.object({
  source: z.enum(['dt', 'xlsx', 'csv']), contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  totalRows: z.number().int().min(1).max(50000), idempotencyKey: Key
}).strict();
export const RowsInput = z.object({ offset: z.number().int().min(0).max(50000), rows: z.array(ImportRow).min(1).max(PAGE_ROWS) }).strict();
export const FinishInput = z.object({ idempotencyKey: Key }).strict();

type Batch = { id: string; source: string; content_sha256: string; total_rows: number; status: string; summary: unknown; created_at: Date; finished_at: Date | null };
const batchView = (b: Batch, received: number) => ({ id: b.id, source: b.source, contentSha256: b.content_sha256, totalRows: b.total_rows, received,
  status: b.status, summary: b.summary, createdAt: new Date(b.created_at).toISOString(), finishedAt: b.finished_at ? new Date(b.finished_at).toISOString() : null });

async function loadBatch(ctx: ClinicContext, batchId: string, lock = false): Promise<Batch> {
  const b = (await ctx.tx.query(`SELECT * FROM import_batches WHERE clinic_id=$1 AND id=$2 ${lock ? 'FOR UPDATE' : ''}`, [ctx.clinicId, batchId])).rows[0];
  return b ?? fail('NOT_FOUND');
}
const received = async (ctx: ClinicContext, batchId: string) =>
  (await ctx.tx.query('SELECT count(*)::int n FROM import_batch_rows WHERE clinic_id=$1 AND batch_id=$2', [ctx.clinicId, batchId])).rows[0].n as number;

export async function createBatch(ctx: ClinicContext, raw: z.input<typeof BatchInput>) {
  ctx = await authorize(ctx, IMPORTERS);
  const input = BatchInput.parse(raw);
  return once(ctx, 'import.create_batch', input, async () => {
    const id = randomUUID();
    const b = (await ctx.tx.query('INSERT INTO import_batches(id,clinic_id,source,content_sha256,total_rows,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
      [id, ctx.clinicId, input.source, input.contentSha256, input.totalRows, ctx.actorId])).rows[0];
    await withAudit(ctx.tx, ctx, 'catalog.import_started', id, { source: input.source, totalRows: input.totalRows });
    return batchView(b, 0);
  });
}

/** Stores one page of rows. Retrying a page overwrites the same positions, so retries never duplicate. */
export async function addRows(ctx: ClinicContext, batchId: string, raw: z.input<typeof RowsInput>) {
  ctx = await authorize(ctx, IMPORTERS);
  const input = RowsInput.parse(raw);
  const b = await loadBatch(ctx, batchId, true);
  if (b.status !== 'staging') fail('INVALID_TRANSITION');
  if (input.offset + input.rows.length > b.total_rows) fail('INVALID_INPUT');
  await ctx.tx.query(`INSERT INTO import_batch_rows(clinic_id,batch_id,seq,row)
    SELECT $1,$2,$3 + (ord - 1)::int, value FROM jsonb_array_elements($4::jsonb) WITH ORDINALITY AS x(value, ord)
    ON CONFLICT (batch_id, seq) DO UPDATE SET row = EXCLUDED.row`, [ctx.clinicId, b.id, input.offset, JSON.stringify(input.rows)]);
  return { received: await received(ctx, b.id), totalRows: b.total_rows };
}

async function stagedRows(ctx: ClinicContext, b: Batch): Promise<{ seq: number; row: ParsedImportRow }[]> {
  const rows = (await ctx.tx.query('SELECT seq,row FROM import_batch_rows WHERE clinic_id=$1 AND batch_id=$2 ORDER BY seq', [ctx.clinicId, b.id])).rows;
  if (rows.length !== b.total_rows) fail('INVALID_TRANSITION');
  return rows.map(r => ({ seq: r.seq, row: ImportRow.parse(r.row) }));
}

type Counts = { new: number; changed: number; unchanged: number; rejected: number; pricesNew: number };
function summarize(plan: Plan) {
  const objects = Object.fromEntries(IMPORT_OBJECTS.map(o => [o, { new: 0, changed: 0, unchanged: 0, rejected: 0, pricesNew: 0 }])) as Record<ImportObject, Counts>;
  for (const r of plan.rows) { const c = objects[r.row.object]; c[r.outcome]++; if (r.priceOutcome === 'new') c.pricesNew++; }
  for (const o of IMPORT_OBJECTS) if (!Object.values(objects[o]).some(Boolean)) delete objects[o];
  return { objects, pricesNew: plan.prices.length, inserts: plan.inserts.length, updates: plan.updates.length };
}
const rowView = (r: Plan['rows'][number]) => ({ seq: r.seq, object: r.row.object, source: r.row.source, code: r.row.code, kind: r.row.kind,
  names: { uzCyrl: r.row.nameUzCyrl, uzLatn: r.row.nameUzLatn, ru: r.row.nameRu }, service: r.row.service,
  priceUzs: r.row.priceUzs, effectiveFrom: r.row.effectiveFrom, outcome: r.outcome, priceOutcome: r.priceOutcome ?? null, reason: r.reason });

/** What a commit would do now: counts per list, up to 5 sample rows per list and every rejected row with its reason (first 300). */
export async function preview(ctx: ClinicContext, batchId: string) {
  ctx = await authorize(ctx, IMPORTERS);
  const b = await loadBatch(ctx, batchId);
  const got = await received(ctx, b.id);
  if (b.status !== 'staging' || got !== b.total_rows) return { batch: batchView(b, got), plan: null };
  const plan = await buildPlan(ctx.tx, ctx.clinicId, await stagedRows(ctx, b));
  const samples: Record<string, ReturnType<typeof rowView>[]> = {};
  const rank = { new: 0, changed: 1, unchanged: 2, rejected: 3 } as const;
  for (const r of [...plan.rows].sort((x, y) => rank[x.outcome] - rank[y.outcome] || x.seq - y.seq)) {
    if (r.outcome === 'rejected') continue;
    const list = samples[r.row.object] ??= [];
    if (list.length < 5) list.push(rowView(r));
  }
  const rejected = plan.rows.filter(r => r.outcome === 'rejected');
  return { batch: batchView(b, got), plan: { ...summarize(plan), samples, rejected: rejected.slice(0, 300).map(rowView), rejectedTotal: rejected.length } };
}

/**
 * Commits the batch in the caller's transaction: recomputes the plan against the catalog as it is now,
 * applies it, marks the batch committed and drops its staged rows. All or nothing.
 */
export async function commit(ctx: ClinicContext, batchId: string, raw: z.input<typeof FinishInput>) {
  ctx = await authorize(ctx, IMPORTERS);
  const input = FinishInput.parse(raw);
  return once(ctx, `import.commit:${batchId}`, input, async () => {
    // One import at a time per clinic, so two plans never race on the same codes.
    await ctx.tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['catalog-import:' + ctx.clinicId]);
    const b = await loadBatch(ctx, batchId, true);
    if (b.status !== 'staging') fail('INVALID_TRANSITION');
    const plan = await buildPlan(ctx.tx, ctx.clinicId, await stagedRows(ctx, b));
    await applyPlan(ctx.tx, ctx.clinicId, ctx.actorId, plan);
    const summary = summarize(plan);
    await ctx.tx.query("UPDATE import_batches SET status='committed', summary=$3, finished_by=$4, finished_at=now() WHERE clinic_id=$1 AND id=$2",
      [ctx.clinicId, b.id, JSON.stringify(summary), ctx.actorId]);
    await ctx.tx.query('DELETE FROM import_batch_rows WHERE clinic_id=$1 AND batch_id=$2', [ctx.clinicId, b.id]);
    await withAudit(ctx.tx, ctx, 'catalog.import_committed', b.id, { inserts: summary.inserts, updates: summary.updates, pricesNew: summary.pricesNew });
    return { batchId: b.id, status: 'committed', summary };
  });
}

export async function discard(ctx: ClinicContext, batchId: string, raw: z.input<typeof FinishInput>) {
  ctx = await authorize(ctx, IMPORTERS);
  const input = FinishInput.parse(raw);
  return once(ctx, `import.discard:${batchId}`, input, async () => {
    const b = await loadBatch(ctx, batchId, true);
    if (b.status !== 'staging') fail('INVALID_TRANSITION');
    await ctx.tx.query("UPDATE import_batches SET status='discarded', finished_by=$3, finished_at=now() WHERE clinic_id=$1 AND id=$2", [ctx.clinicId, b.id, ctx.actorId]);
    await ctx.tx.query('DELETE FROM import_batch_rows WHERE clinic_id=$1 AND batch_id=$2', [ctx.clinicId, b.id]);
    await withAudit(ctx.tx, ctx, 'catalog.import_discarded', b.id);
    return { batchId: b.id, status: 'discarded' };
  });
}

export async function recentBatches(ctx: ClinicContext) {
  ctx = await authorize(ctx, IMPORTERS);
  const rows = (await ctx.tx.query(`SELECT b.*, (SELECT count(*)::int FROM import_batch_rows r WHERE r.batch_id=b.id) received
    FROM import_batches b WHERE b.clinic_id=$1 ORDER BY b.created_at DESC LIMIT 20`, [ctx.clinicId])).rows;
  return rows.map(r => batchView(r, r.received));
}
