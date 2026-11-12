import { createReadStream } from 'node:fs';
import { Readable, pipeline } from 'node:stream';
import { createInflateRaw } from 'node:zlib';
import { readDt, type DtExtract, type Inflater, type ReadOptions } from './dt.js';

/** Node adapter: raw deflate through zlib, streamed, never holding the whole dump in memory. */
export const nodeInflate: Inflater = compressed =>
  // pipeline (not pipe) so a source error, such as a bad header, reaches the reader instead of escaping.
  pipeline(Readable.from(compressed), createInflateRaw({ chunkSize: 1 << 16 }), () => {}) as AsyncIterable<Uint8Array>;

/** Reads a .dt file from disk. Used by tests and by scripts/inspect-1c-dump.ts for local real-file runs. */
export function readDtFile(path: string, options?: ReadOptions): Promise<DtExtract> {
  return readDt(createReadStream(path, { highWaterMark: 1 << 16 }) as AsyncIterable<Uint8Array>, nodeInflate, options);
}
export async function* bytes(buffer: Uint8Array, chunk = 7919): AsyncIterable<Uint8Array> {
  for (let i = 0; i < buffer.length; i += chunk) yield buffer.subarray(i, i + chunk);
}
