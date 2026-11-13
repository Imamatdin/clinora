import test from 'node:test';
import assert from 'node:assert/strict';
import { httpFixture } from '../integration/fixture.js';
import { passwordHash } from '../../src/server/security.js';
import { seedHistory } from './seed.js';

/*
 * Task 024 load test: two years at 150 outpatients and 20 inpatient admissions a day.
 * Every operation runs through the HTTP API (session check, role check, JSON response) and must
 * finish under LIMIT_MS on the CI database (GitHub-hosted runner, PostgreSQL service container).
 * Timings are printed on one "# load:" line for the handoff. LOAD_DAYS shortens local runs.
 */
const LIMIT_MS = 2000;
const days = Number(process.env.LOAD_DAYS ?? 730);

test(`reports stay under ${LIMIT_MS} ms with ${days} days of history`, { timeout: 15 * 60_000 }, async () => {
  const f = await httpFixture();
  try {
    const started = performance.now();
    const seed = await seedHistory(f.pool, f.owner.clinicId, f.owner.userId, days);
    const seedMs = Math.round(performance.now() - started);
    // One seeded doctor gets a synthetic sign-in so the doctor's own earnings view is measured.
    await f.pool.query('UPDATE accounts SET email=$2,password_hash=$3 WHERE id=$1', [seed.doctors[0], 'load.doctor@example.test', await passwordHash(f.password)]);
    const ceo = f.client(), doctor = f.client();
    await ceo.login(); await doctor.login('load.doctor@example.test');
    const base = `/api/clinics/${f.owner.clinicId}`;
    const shift = (date: string, n: number) => new Date(Date.parse(date) + n * 86400000).toISOString().slice(0, 10);
    const today = seed.today, monthAgo = shift(today, -29);
    const firstOfMonth = today.slice(0, 8) + '01', prevTo = shift(firstOfMonth, -1), prevFrom = prevTo.slice(0, 8) + '01';
    const timings: Record<string, number> = {}, sizes: Record<string, number> = {};
    const run = async (name: string, who: typeof ceo, path: string, body: unknown) => {
      const t0 = performance.now();
      const r = await who.request(base + path, body); const text = await r.text();
      timings[name] = Math.round(performance.now() - t0); sizes[name] = text.length;
      assert.equal(r.status, 200, `${name}: ${text.slice(0, 300)}`);
      return JSON.parse(text);
    };
    const dayToday = await run('dashboard today', ceo, '/reports/dashboard', { from: today, to: today });
    const month = await run('dashboard 30 days', ceo, '/reports/dashboard', { from: monthAgo, to: today });
    const own = await run('doctor earnings 30 days (doctor)', doctor, '/payroll/earnings', { from: monthAgo, to: today });
    await run('payroll report 30 days (CEO)', ceo, '/payroll/earnings', { from: monthAgo, to: today });
    const payroll = await run('payroll finalize last month', ceo, '/payroll/finalize', { from: prevFrom, to: prevTo });
    const dayId = (await f.pool.query("SELECT id FROM business_days WHERE clinic_id=$1 AND status='open'", [f.owner.clinicId])).rows[0].id;
    await run('day close', ceo, `/business-days/${dayId}/close`, {});

    // Full export: streamed, so recorded for the handoff but not held to the 2 s report target.
    const t0 = performance.now();
    const archive = await ceo.request(base + '/reports/full-export', {});
    assert.equal(archive.status, 200); assert.equal(archive.headers.get('content-length'), null);
    let exportBytes = 0; const reader = archive.body!.getReader();
    for (let r = await reader.read(); !r.done; r = await reader.read()) exportBytes += r.value.length;
    const exportMs = Math.round(performance.now() - t0);
    assert.ok(exportBytes > 1_000_000, String(exportBytes));
    // Sanity: the measured requests really carried the stated volume.
    assert.ok(Number(dayToday.totals.patients) >= 150, String(dayToday.totals.patients));
    assert.ok(BigInt(month.totals.collected) > 0n);
    assert.ok(BigInt(dayToday.totals.outstanding) > BigInt(month.totals.value) / 100n, 'debts from earlier months are in outstanding');
    assert.ok(own.lines.length > 100 && own.lines.every((l: { user_id: string }) => l.user_id === seed.doctors[0]));
    assert.ok(payroll.lines.length > 1000);
    process.stdout.write(`# load: ${JSON.stringify({ days, seedMs, counts: seed.counts, timings, responseBytes: sizes, fullExport: { ms: exportMs, bytes: exportBytes } })}\n`);
    for (const [name, ms] of Object.entries(timings)) assert.ok(ms < LIMIT_MS, `${name} took ${ms} ms (limit ${LIMIT_MS})`);
  } finally { await f.close(); }
});
