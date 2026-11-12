import { readDt, type DtExtract, type Inflater } from '../../modules/import1c/dt.js';
import { readXlsx } from '../../modules/import1c/table.js';
import { parseCsv } from '../../modules/import1c/table.js';
import type { ImportRow } from '../../modules/import1c/model.js';

/*
 * Browser side of the import: the file is read here, on the administrator's computer, with the same
 * reader the server tests use. Only catalog rows leave the browser, so a clinic's patient records in
 * the .dt never travel over the network or reach the server.
 */

async function* iterate(stream: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  try { for (;;) { const { done, value } = await reader.read(); if (done) return; yield value; } } finally { reader.releaseLock(); }
}
function fromIterable(source: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const it = source[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) { try { const { done, value } = await it.next(); if (done) controller.close(); else controller.enqueue(value); } catch (e) { controller.error(e); } },
    async cancel() { await it.return?.(); }
  });
}
export const supported = () => typeof DecompressionStream === 'function';
const browserInflate: Inflater = compressed => iterate(fromIterable(compressed).pipeThrough(new DecompressionStream('deflate-raw') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>));
const inflateRaw = async (data: Uint8Array) => new Uint8Array(await new Response(new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());

export const readDtInBrowser = (file: File): Promise<DtExtract> => readDt(iterate(file.stream()), browserInflate);
export async function readTableInBrowser(file: File): Promise<string[][]> {
  if (/\.xlsx$/i.test(file.name)) return readXlsx(new Uint8Array(await file.arrayBuffer()), inflateRaw);
  return parseCsv(await file.text());
}

/** Content hash of the staged rows (same file, same rows, same hash). */
export async function contentHash(rows: ImportRow[]): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(rows)));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
/** Splits rows into pages that stay under the API's 100 kB request body limit. */
export function pages(rows: ImportRow[], maxBytes = 80_000, maxRows = 500): { offset: number; rows: ImportRow[] }[] {
  const out: { offset: number; rows: ImportRow[] }[] = [];
  let current: ImportRow[] = [], size = 0, offset = 0;
  rows.forEach((row, i) => {
    const bytes = new TextEncoder().encode(JSON.stringify(row)).length + 1;
    if (current.length && (size + bytes > maxBytes || current.length >= maxRows)) { out.push({ offset, rows: current }); current = []; size = 0; offset = i; }
    current.push(row); size += bytes;
  });
  if (current.length) out.push({ offset, rows: current });
  return out;
}
