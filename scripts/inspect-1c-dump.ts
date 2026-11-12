// Local-only summary of a clinic 1C dump for the task-005 handoff. Never run in CI; never commit dumps.
//   node --import tsx scripts/inspect-1c-dump.ts data/private/clinic.dt
// Prints: header version, every top-level object name (patients and documents by NAME ONLY), record
// counts and field names of the catalog objects, where prices are stored, structure (field names only)
// of Мумкун and Каровчи, rejected-row reasons, and up to 5 sample services with prices. It prints no
// patient, caretaker or document values: those objects are skipped by the reader without being decoded.
// If the layout is not recognized it prints a byte-pattern probe instead (statistics and object names only).
import { createReadStream } from 'node:fs';
import { DtError, probeLayout } from '../src/modules/import1c/dt.js';
import { nodeInflate, readDtFile } from '../src/modules/import1c/node.js';

const path = process.argv[2];
if (!path) { console.error('Usage: node --import tsx scripts/inspect-1c-dump.ts <file.dt>'); process.exit(2); }
try {
  const x = await readDtFile(path);
  const count = new Map<string, { ok: number; rejected: Map<string, number> }>();
  for (const r of x.rows) {
    const key = `${r.object} <- ${r.source}`, c = count.get(key) ?? { ok: 0, rejected: new Map() };
    if (r.rejected) c.rejected.set(r.rejected, (c.rejected.get(r.rejected) ?? 0) + 1); else c.ok++;
    count.set(key, c);
  }
  console.log(`format version: ${x.version}; inflated ${(x.inflatedBytes / 1048576).toFixed(1)} MiB`);
  console.log('\nobjects in the dump:');
  for (const o of x.objects) console.log(`  ${o.mode.padEnd(14)} ${o.name}${o.records !== undefined ? `  records=${o.records}` : ''}${o.fields ? `  fields=${o.fields.join(', ')}` : ''}`);
  console.log('\nimport rows per object:');
  for (const [k, c] of count) console.log(`  ${k}: ok=${c.ok}${c.rejected.size ? ' rejected=' + [...c.rejected].map(([r, n]) => `${r}:${n}`).join(',') : ''}`);
  console.log(`\nprices found in: ${x.priceSources.join(', ') || 'nowhere (no price field or price register recognized)'}`);
  console.log('\nstructure only (no values read):');
  for (const s of x.structure) console.log(`  ${s.name}: records=${s.records}; fields=${s.fields.map(f => `${f.name}[${f.kinds.join('/')}]`).join(', ')}`);
  console.log('\nsample services:');
  for (const r of x.rows.filter(r => r.object === 'service' && !r.rejected).slice(0, 5))
    console.log(`  ${r.code} | ${r.kind} | ${r.nameUzCyrl} | ${r.nameUzLatn ?? '-'} | ${r.nameRu ?? '-'} | ${r.priceUzs ?? 'no price'}`);
} catch (error) {
  console.error(error instanceof DtError ? `Reader stopped: ${error.code}` : 'Reader failed unexpectedly');
  if (error instanceof DtError && ['UNRECOGNIZED_LAYOUT', 'TRUNCATED'].includes(error.code)) {
    // Layout differs from the reader's assumption: print byte statistics and metadata names only, for the builder.
    const probe = await probeLayout(createReadStream(path, { highWaterMark: 1 << 16 }) as AsyncIterable<Uint8Array>, nodeInflate);
    console.log(JSON.stringify({ ...probe, metadataNames: probe.metadataNames.sort((a, b) => a.firstOffset - b.firstOffset) }, null, 1));
  }
  process.exit(1);
}
