/*
 * Streaming tokenizer for 1C's tagged ("internal") serialization: brace lists `{ ... }`, comma
 * separators, quoted strings with `""` as an escaped quote, and bare atoms (numbers, UUIDs, flags).
 * Strings may be single-byte/UTF-8 or UTF-16LE (a quote followed by a zero byte); structural
 * characters may be UTF-16LE too, so zero bytes outside strings are ignored.
 *
 * Privacy property: the sink decides, before each string or atom is read, whether it wants the value.
 * When it does not, the tokenizer only finds where the value ends. Nothing is decoded or buffered,
 * so patient and document objects are never read into memory as text.
 */

export type TokenSink = {
  /** Called at the start of every string or atom. False: the value is skipped without decoding. */
  want(kind: 'string' | 'atom'): boolean;
  open(): void;
  close(): void;
  /** `value` is null when the sink did not want it (or it exceeded the size limit). */
  string(value: string | null): void;
  atom(value: string | null): void;
};

export class TokenError extends Error {
  constructor(public readonly reason: 'TRUNCATED' | 'UNBALANCED' | 'ATOM_TOO_LONG') { super(reason); }
}

const MAX_KEPT_STRING = 64 * 1024;
const MAX_ATOM = 512;
const utf8 = new TextDecoder('utf-8');
const utf16 = new TextDecoder('utf-16le');

class Bytes {
  private data = new Uint8Array(256); length = 0; overflow = false;
  reset() { this.length = 0; this.overflow = false; }
  append(src: Uint8Array, from: number, to: number) {
    if (this.overflow) return;
    const n = to - from;
    if (this.length + n > MAX_KEPT_STRING) { this.overflow = true; return; }
    if (this.length + n > this.data.length) {
      const next = new Uint8Array(Math.max(this.data.length * 2, this.length + n)); next.set(this.data.subarray(0, this.length)); this.data = next;
    }
    this.data.set(src.subarray(from, to), this.length); this.length += n;
  }
  view() { return this.data.subarray(0, this.length); }
}

const isSpace = (b: number) => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d || b === 0x00 || b === 0xef || b === 0xbb || b === 0xbf || b === 0xff || b === 0xfe;

export class Tokenizer {
  private state: 'base' | 'atom' | 's8' | 's16' = 'base';
  private keep = false;
  private readonly buf = new Bytes();
  private atomLength = 0;
  private carry: Uint8Array = new Uint8Array(0);
  private depth = 0;

  constructor(private readonly sink: TokenSink) {}

  /** Feed the next inflated chunk. Call finish() after the last one. */
  push(chunk: Uint8Array): void { this.run(chunk, false); }
  finish(): void {
    this.run(new Uint8Array(0), true);
    if (this.state === 'atom') this.endAtom();
    if (this.state !== 'base') throw new TokenError('TRUNCATED');
    if (this.depth !== 0) throw new TokenError('TRUNCATED');
  }

  private endAtom() {
    this.sink.atom(this.keep ? utf8.decode(this.buf.view()) : null);
    this.state = 'base';
  }

  private run(chunk: Uint8Array, final: boolean): void {
    let data = chunk;
    if (this.carry.length) { data = new Uint8Array(this.carry.length + chunk.length); data.set(this.carry); data.set(chunk, this.carry.length); this.carry = new Uint8Array(0); }
    let i = 0;
    const n = data.length;
    while (i < n) {
      if (this.state === 's8') {
        const j = data.indexOf(0x22, i);
        if (j < 0) { if (this.keep) this.buf.append(data, i, n); i = n; break; }
        if (j + 1 >= n && !final) { if (this.keep) this.buf.append(data, i, j); this.carry = data.slice(j); return; }
        if (data[j + 1] === 0x22) { if (this.keep) this.buf.append(data, i, j + 1); i = j + 2; continue; }
        if (this.keep) this.buf.append(data, i, j);
        this.sink.string(this.keep && !this.buf.overflow ? utf8.decode(this.buf.view()) : null);
        this.state = 'base'; i = j + 1; continue;
      }
      if (this.state === 's16') {
        if (i + 1 >= n) { if (!final) { this.carry = data.slice(i); return; } throw new TokenError('TRUNCATED'); }
        if (data[i] === 0x22 && data[i + 1] === 0x00) {
          if (i + 3 >= n && !final) { this.carry = data.slice(i); return; }
          if (data[i + 2] === 0x22 && data[i + 3] === 0x00) { if (this.keep) this.buf.append(data, i, i + 2); i += 4; continue; }
          this.sink.string(this.keep && !this.buf.overflow ? utf16.decode(this.buf.view()) : null);
          this.state = 'base'; i += 2; continue;
        }
        if (this.keep) this.buf.append(data, i, i + 2);
        i += 2; continue;
      }
      const b = data[i]!;
      if (this.state === 'atom') {
        if (b === 0x00) { i++; continue; } // high byte of a UTF-16LE atom character
        if (b === 0x7b || b === 0x7d || b === 0x2c || b === 0x22 || isSpace(b)) { this.endAtom(); continue; }
        if (++this.atomLength > MAX_ATOM) throw new TokenError('ATOM_TOO_LONG');
        if (this.keep) this.buf.append(data, i, i + 1);
        i++; continue;
      }
      // base
      if (isSpace(b) || b === 0x2c) { i++; continue; }
      if (b === 0x7b) { this.depth++; this.sink.open(); i++; continue; }
      if (b === 0x7d) { if (--this.depth < 0) throw new TokenError('UNBALANCED'); this.sink.close(); i++; continue; }
      if (b === 0x22) {
        if (i + 1 >= n && !final) { this.carry = data.slice(i); return; }
        const wide = data[i + 1] === 0x00;
        this.keep = this.sink.want('string'); this.buf.reset();
        this.state = wide ? 's16' : 's8'; i += wide ? 2 : 1; continue;
      }
      this.keep = this.sink.want('atom'); this.buf.reset(); this.atomLength = 1;
      if (this.keep) this.buf.append(data, i, i + 1);
      this.state = 'atom'; i++;
    }
  }
}
