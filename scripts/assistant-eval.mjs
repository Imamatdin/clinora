// Measured, not claimed: runs the fixed A1 speech set through the configured REAL adapters.
// Usage: AISHA_API_KEY=... VERTEX_API_KEY=... EVAL_DIR=<folder with E01.ogg ... E10.ogg> npm run assistant:eval
// Recordings are fictional consultations read by consenting people on a phone. Never commit audio or keys.
// Output: per-case term recall, word error rate, missed fields, latency. Prints no transcript text unless EVAL_SHOW=true.
import { readdir, readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { providersFromEnv } from '../src/modules/assistant/providers.ts';
import { validateProposals } from '../src/modules/assistant/form.ts';
import { EVAL_SET } from '../src/modules/assistant/eval-set.ts';

const p = providersFromEnv();
if ((p.stt.simulated || p.extractor.simulated || p.stt.name === 'unavailable') && process.env.ALLOW_SIMULATED_EVAL !== 'true')
  throw new Error('Evaluation needs real adapters (AISHA_API_KEY and VERTEX_* credentials). Simulated results are not measurements.');
if (!process.env.EVAL_DIR) throw new Error('EVAL_DIR required');
const MIME = { '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.webm': 'audio/webm', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.mp3': 'audio/mpeg' };
const norm = s => s.toLowerCase().replace(/[ʻʼ'`’]/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
function wer(ref, hyp) {
  const r = norm(ref), h = norm(hyp), d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]);
  for (let j = 1; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++) for (let j = 1; j <= h.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
  return r.length ? d[r.length][h.length] / r.length : 0;
}
const files = await readdir(process.env.EVAL_DIR);
const rows = [];
for (const c of EVAL_SET) {
  const file = files.find(f => f.startsWith(c.id) && MIME[extname(f)]);
  if (!file) { rows.push({ case: c.id, status: 'no recording' }); continue; }
  const audio = await readFile(join(process.env.EVAL_DIR, file));
  const t0 = Date.now();
  let stt;
  try { stt = await p.stt.transcribe({ audio, mimeType: MIME[extname(file)] }); } catch (e) { rows.push({ case: c.id, status: 'stt failed: ' + e.message }); continue; }
  const sttMs = Date.now() - t0, hyp = stt.segments.map(s => s.text).join(' '), ref = c.lines.map(l => l[1]).join(' ');
  const recalled = c.terms.filter(term => norm(hyp).join(' ').includes(norm(term).join(' ')));
  const segments = stt.segments.map(s => ({ id: randomUUID(), text: s.text, speaker: s.speaker }));
  const t1 = Date.now();
  let accepted = [], rejected = [], extractMs = 0, extractError = '';
  try { const raw = await p.extractor.extract({ segments, today: '2026-11-19' }); extractMs = Date.now() - t1; ({ accepted, rejected } = validateProposals(raw, new Map(segments.map(s => [s.id, s])))); }
  catch (e) { extractError = e.message; }
  const got = new Set(accepted.map(a => a.field));
  rows.push({ case: c.id, lang: c.language, wer: wer(ref, hyp).toFixed(2), terms: `${recalled.length}/${c.terms.length}`, missedTerms: c.terms.filter(x => !recalled.includes(x)).join(', '),
    missedFields: c.fields.filter(f => !got.has(f)).join(', ') || '-', extraFields: [...got].filter(f => !c.fields.includes(f)).join(', ') || '-', rejected: rejected.length,
    sttMs, extractMs, status: extractError || 'ok' });
  if (process.env.EVAL_SHOW === 'true') console.log(c.id, hyp);
}
console.table(rows);
console.log(`STT ${p.stt.name}, extractor ${p.extractor.name} ${p.extractor.model ?? ''}. Term recall and WER are against the scripted text; fields need clinician review before any accuracy claim.`);
