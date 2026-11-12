import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBinary, scalar, list } from '../src/modules/import1c/binary.js';
import { DtError, readDt } from '../src/modules/import1c/dt.js';
import { bytes, nodeInflate } from '../src/modules/import1c/node.js';
import { synthDt, SYNTH_REF } from '../src/modules/import1c/synthetic.js';

// Hand-written bytes independent of the fixture writer: all numeric and length tags, flag order.
test('binary tags preserve integers, lengths, GUID bytes and combined structural flags', () => {
  const b = Buffer.from([
    0x40, 0x02, 0x03, 0x8b, 255, 0x8c, 128, 0x8d, 0x34, 0x12, 0x8e, 2, 0,
    0x8f, 0xff, 0xff, 0xff, 0xff, 0x90, 1, 0, 0, 0,
    0x91, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f,
    0x97, 1, 0x16, 0x04, 0x98, 1, 0, 65, 0, 0x99, 1, 0, 0, 0, 0, 0, 0, 0, 66, 0,
    0x9a, 1, 67, 0x9b, 1, 0, 68, 0x9c, 1, 0, 0, 0, 0, 0, 0, 0, 69,
    0x95, ...Array.from({length: 16}, (_, i) => i), 0x96, 0xe1, 0x20
  ]);
  const root = parseBinary(b);
  assert.deepEqual(list(root[0]).map(scalar), ['12', '255', '-128', '4660', '-2', '4294967295', '-1', '9223372036854775807', 'Ж', 'A', 'B', 'C', 'D', 'E', '000102030405060708090a0b0c0d0e0f']);
  assert.deepEqual(list(root[1]).map(scalar), ['0']);
  for (const cut of [Buffer.from([0x17, 1, 65]), Buffer.from([0x40]), Buffer.from([0x11, 0])]) assert.throws(() => parseBinary(cut), (e: unknown) => e instanceof DtError && e.code === 'TRUNCATED');
  assert.throws(() => parseBinary(Buffer.from([0x20])), DtError);
  assert.throws(() => parseBinary(Buffer.from([0x19, ...Array(8).fill(255)])), (e: unknown) => e instanceof DtError && e.code === 'TOO_LARGE');
});

test('catalog resolution follows metadata and row flags; tax classifiers never become groups', async () => {
  const x = await readDt(bytes(synthDt([
    { name: 'Справочник.МИХИЛАР', records: [[['Ссылка', {ref: SYNTH_REF(1)}], ['Код', 'TAX'], ['Наименование', '10902002002000003']]] },
    { name: 'Справочник.МУОЛАЖА', records: [[['Ссылка', {ref: SYNTH_REF(2)}], ['Наименование', 'Синтетик'], ['МИХИ', {ref: SYNTH_REF(1)}], ['НАРХИ', {atom: '0'}]]] },
    { name: 'Справочник.Товары', records: [[['Код', 'G1'], ['Наименование', 'Синтетик товар'], ['СотувНархи', {atom: '15000'}]]] },
    { name: 'Справочник.Расходлар', records: [[['Код', 'E1'], ['Наименование', 'Синтетик харажат']]] }
  ])), nodeInflate);
  assert.equal(x.rows.length, 3);
  assert.equal(x.rows[0]!.mxikCode, '10902002002000003');
  assert.equal(x.rows[0]!.priceUzs, '0');
  assert.ok(x.rows[0]!.code?.startsWith('МУОЛАЖА/'));
  assert.equal(x.rows[1]!.kind, 'good');
  assert.equal(x.rows[1]!.priceUzs, '15000');
  assert.equal(x.rows[2]!.object, 'expenseType');
});
