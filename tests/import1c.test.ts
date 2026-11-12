import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { DtError, checkHeader, inferKind, parsePeriod, parsePrice, readDt } from '../src/modules/import1c/dt.js';
import { bytes, nodeInflate } from '../src/modules/import1c/node.js';
import { PATIENT_MARKER, sampleSections, synthBody, synthDt } from '../src/modules/import1c/synthetic.js';
import { guessMapping, parseCsv, readXlsx, rowsFromTable, TableError } from '../src/modules/import1c/table.js';
import { ImportRow } from '../src/modules/import1c/model.js';
import { fold } from '../src/modules/catalog/shared.js';

const read = (file: Uint8Array, chunk = 4093) => readDt(bytes(file, chunk), nodeInflate);
const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return e instanceof DtError ? e.code : String(e); } };

test('verified binary .dt parses catalogs across encodings and chunk boundaries', async () => {
  for (const encoding of ['mixed', 'utf16', 'utf8'] as const) for (const chunk of [1, 3, 997, 1 << 20]) {
    const x = await read(synthDt(sampleSections(), { encoding }), chunk);
    assert.equal(x.version, '3');
    const ok = x.rows.filter(r => !r.rejected);
    const count = (o: string) => ok.filter(r => r.object === o).length;
    assert.deepEqual([count('department'), count('serviceGroup'), count('service'), count('doctor'), count('district'), count('mahalla'), count('roomType')], [2, 2, 5, 1, 1, 2, 1]);
    const uzi = x.rows.find(r => r.code === 'МУОЛАЖА/10902002002000003')!;
    assert.deepEqual([uzi.priceUzs, uzi.kind, uzi.department, uzi.mxikCode, uzi.group], ['150000', 'diagnostic', 'БУЛИМ/01', '10902002002000003', null]);
    assert.equal(x.rows.find(r => r.code === 'Анализ/A01')!.referenceRange, '4–9');
    assert.deepEqual(x.rows.filter(r => r.rejected).map(r => r.rejected).sort(), ['FOLDER', 'FRACTIONAL_PRICE', 'NO_NAME']);
    assert.deepEqual(x.priceSources.sort(), ['Анализ.Цена', 'МУОЛАЖА.НАРХИ', 'ХоналарТипи.КунликЁтокПули'].sort());
    for (const row of x.rows) ImportRow.parse(row);
  }
});

test('patient, caretaker, document and staff secret values never enter a decoder', async () => {
  const Original = globalThis.TextDecoder;
  const decoded: string[] = [];
  globalThis.TextDecoder = class extends Original {
    override decode(...args: Parameters<TextDecoder['decode']>) { const text = super.decode(...args); decoded.push(text); return text; }
  };
  try {
    const x = await read(synthDt(sampleSections()));
    const out = JSON.stringify(x);
    for (const marker of [PATIENT_MARKER, 'STAFFSECRET', '998901234567', '777777']) {
      assert.ok(!out.includes(marker)); assert.ok(!decoded.some(s => s.includes(marker)), marker);
    }
    assert.ok(x.objects.some(o => o.name === 'Справочник.Каровчи' && o.mode === 'skipped'));
    assert.ok(x.objects.filter(o => o.mode === 'skipped').every(o => o.records === undefined && o.fields === undefined));
  } finally { globalThis.TextDecoder = Original; }
});

test('corrupt, truncated, unsupported and oversized files fail clearly', async () => {
  const good = synthDt(sampleSections());
  const flipped = Buffer.from(good); for (let i = 40; i < 60; i++) flipped[i] = flipped[i]! ^ 0xa5;
  assert.ok(['CORRUPT', 'TRUNCATED', 'UNRECOGNIZED_LAYOUT'].includes(await code(read(flipped))));
  assert.ok(['CORRUPT', 'TRUNCATED'].includes(await code(read(good.subarray(0, Math.floor(good.length / 2))))));
  assert.equal(await code(read(Buffer.concat([Buffer.from('1CIBDmpF3'), deflateRawSync(synthBody(sampleSections()).subarray(0, 3000))]))), 'TRUNCATED');
  assert.equal(await code(read(Buffer.from('PK not a dump'))), 'NOT_A_DT');
  assert.equal(await code(read(Buffer.from('1CIB'))), 'NOT_A_DT');
  assert.equal(await code(read(synthDt(sampleSections(), { version: '4' }))), 'UNRECOGNIZED_LAYOUT');
  await assert.rejects(read(Buffer.concat([Buffer.from('1CIBDmpF3'), deflateRawSync(Buffer.from([0x12]))])), (e: unknown) => e instanceof DtError && e.offset === 0 && e.tag === 0x12);
  assert.equal(await code(readDt(bytes(good), nodeInflate, { maxInflatedBytes: 100 })), 'TOO_LARGE');
  assert.equal(await code(readDt(bytes(good), nodeInflate, { maxRecords: 1 })), 'TOO_LARGE');
  assert.throws(() => checkHeader(Buffer.from('1CIBDmpFX')), DtError);
});

test('prices, periods and kinds parse without floats or guesses', () => {
  assert.deepEqual(parsePrice('150000.00'), { priceUzs: '150000' });
  assert.deepEqual(parsePrice('1 250 000,00'), { priceUzs: '1250000' });
  assert.deepEqual(parsePrice('99999999999999.00'), { priceUzs: '99999999999999' });
  assert.deepEqual(parsePrice('10.5'), { rejected: 'FRACTIONAL_PRICE' });
  assert.deepEqual(parsePrice('-5'), { rejected: 'BAD_PRICE' });
  assert.deepEqual(parsePrice('abc'), { rejected: 'BAD_PRICE' });
  assert.equal(parsePeriod('20260115000000'), '2026-01-15');
  assert.equal(parsePeriod('15.01.2026'), '2026-01-15');
  assert.equal(parsePeriod('nonsense'), null);
  assert.equal(inferKind('Гастроэнтеролог кўриги'), 'consultation');
  assert.equal(inferKind('Лучевая диагностика Ультразвуковое исследование (УЗИ)'), 'diagnostic');
  assert.equal(inferKind('Аппендэктомия'), 'surgery');
  assert.equal(inferKind('Перевязка'), 'procedure');
});

/** Minimal stored/deflated zip writer, enough to build a test .xlsx. */
function zip(files: Record<string, string>): Uint8Array {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBuf = Buffer.from(name), data = deflateRawSync(Buffer.from(text));
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(data.length, 18); local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(data.length, 20);
    central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data); centrals.push(central, nameBuf); offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
const inflate = async (d: Uint8Array) => new Uint8Array(inflateRawSync(d));

test('xlsx and csv exports map to the same import rows', async () => {
  const xlsx = zip({
    'xl/workbook.xml': '<workbook><sheets><sheet name="Хизматлар" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<sst><si><t>Код</t></si><si><t>Наименование</t></si><si><t>Нархи</t></si><si><t>Терапевт кўриги &amp; маслаҳат</t></si><si><r><t>Qon </t></r><r><t>tahlili</t></r></si></sst>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>' +
      '<row r="2"><c r="A2"><v>101</v></c><c r="B2" t="s"><v>3</v></c><c r="C2"><v>100000</v></c></row>' +
      '<row r="3"><c r="A3" t="inlineStr"><is><t>102</t></is></c><c r="B3" t="s"><v>4</v></c><c r="C3"><v>45000.5</v></c></row>' +
      '<row r="4"><c r="C4"><v>1</v></c></row></sheetData></worksheet>'
  });
  const table = await readXlsx(xlsx, inflate);
  assert.deepEqual(table[1], ['101', 'Терапевт кўриги & маслаҳат', '100000']);
  const mapping = guessMapping(table[0]!);
  assert.deepEqual(mapping, { code: 0, nameUzCyrl: 1, priceUzs: 2 });
  const rows = rowsFromTable(table, 'service', mapping, { headerRow: true, kind: 'consultation', source: 'Хизматлар.xlsx' });
  assert.deepEqual(rows.map(r => [r.code, r.priceUzs ?? null, r.rejected]), [['101', '100000', null], ['102', null, 'FRACTIONAL_PRICE'], [null, '1', 'NO_NAME']]);
  for (const row of rows) ImportRow.parse(row);

  const csv = parseCsv('﻿Код;Номи;Нархи;Булим\r\n101;"Терапевт ""кўриги""";100 000;Терапия\n\n102;Қон таҳлили;45000;\n');
  assert.deepEqual(csv, [['Код', 'Номи', 'Нархи', 'Булим'], ['101', 'Терапевт "кўриги"', '100 000', 'Терапия'], ['102', 'Қон таҳлили', '45000', '']]);
  const csvRows = rowsFromTable(csv, 'service', guessMapping(csv[0]!), { headerRow: true, kind: 'lab', source: 'csv' });
  assert.deepEqual(csvRows.map(r => [r.priceUzs, r.department, r.kind]), [['100000', 'Терапия', 'lab'], ['45000', null, 'lab']]);
  await assert.rejects(readXlsx(new TextEncoder().encode('not a zip'), inflate), TableError);
  assert.throws(() => parseCsv('\n\n'), TableError);
});

test('fold matches Cyrillic, Latin and Russian spellings', () => {
  assert.equal(fold('Ҳасанов'), fold('Hasanov'));
  assert.equal(fold('Хасанов'), fold('Xasanov'));
  assert.equal(fold('Ўзбекистон'), fold('Oʻzbekiston'));
  assert.equal(fold('Ультратовуш'), fold('Ultratovush'));
});
