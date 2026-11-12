import { DtError } from './dt.js';

type Span = { kind: 'utf16' | 'bytes' | 'guid'; bytes: Uint8Array };
export type BinaryNode = string | bigint | Span | BinaryNode[];
export const list = (n: BinaryNode | undefined): BinaryNode[] => Array.isArray(n) ? n : [];
export function scalar(n: BinaryNode | undefined): string | null {
  if (n === undefined || Array.isArray(n)) return null;
  if (typeof n === 'string' || typeof n === 'bigint') return String(n);
  if (n.kind === 'utf16') return new TextDecoder('utf-16le', { fatal: true }).decode(n.bytes);
  if (n.kind === 'bytes' && n.bytes.every(b => b >= 32 && b < 127)) return new TextDecoder().decode(n.bytes);
  return [...n.bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Index values as spans: parsing the entire binary grammar never decodes a patient string. */
export function parseBinary(data: Uint8Array): BinaryNode[] {
  const root: BinaryNode[] = [], stack = [root]; let i = 0, digit = false, nodes = 0;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const need = (n: number) => { if (!Number.isSafeInteger(n) || n < 0 || i + n > data.length) throw new DtError('TRUNCATED', i); };
  const uint = (n: number) => { need(n); let v: bigint; if (n === 1) v = BigInt(view.getUint8(i)); else if (n === 2) v = BigInt(view.getUint16(i, true)); else if (n === 4) v = BigInt(view.getUint32(i, true)); else v = view.getBigUint64(i, true); i += n; return v; };
  while (i < data.length) {
    const offset = i, t = data[i++]!;
    if (++nodes > 2_000_000) throw new DtError('TOO_LARGE', offset);
    if (t & 0x20) { if (stack.length === 1) throw new DtError('UNRECOGNIZED_LAYOUT', offset, t); stack.pop(); digit = false; }
    if (t & 0x80) digit = false;
    if (t & 0x40) { if (stack.length > 128) throw new DtError('TOO_LARGE', offset); const a: BinaryNode[] = []; stack.at(-1)!.push(a); stack.push(a); digit = false; }
    const base = t & 31, cur = stack.at(-1)!;
    if (base === 0) continue;
    if (base >= 1 && base <= 10) { const d = String(base - 1); if (digit) cur[cur.length - 1] = String(cur.at(-1)) + d; else cur.push(d); digit = true; continue; }
    digit = false;
    if (base >= 0x0b && base <= 0x10) { const n = 1 << Math.floor((base - 0x0b) / 2); const v = uint(n); cur.push(base % 2 ? v : -v); }
    else if (base === 0x11) { need(8); cur.push(view.getBigInt64(i, true)); i += 8; }
    else if (base === 0x15) { need(16); cur.push({ kind: 'guid', bytes: data.subarray(i, i + 16) }); i += 16; }
    else if (base === 0x16) continue;
    else if (base >= 0x17 && base <= 0x1c) {
      const wide = base <= 0x19, n = [1, 2, 8][(base - (wide ? 0x17 : 0x1a))]!;
      const length = uint(n) * (wide ? 2n : 1n);
      if (length > BigInt(Number.MAX_SAFE_INTEGER)) throw new DtError('TOO_LARGE', offset);
      const len = Number(length); need(len); cur.push({ kind: wide ? 'utf16' : 'bytes', bytes: data.subarray(i, i + len) }); i += len;
    } else throw new DtError('UNRECOGNIZED_LAYOUT', offset, t);
  }
  if (stack.length !== 1) throw new DtError('TRUNCATED', i);
  return root;
}
