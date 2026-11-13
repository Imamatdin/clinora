import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { processFixture, T } from './process-fixture.js';
import { assistant } from '../../src/web/i18n/assistant.uz-Cyrl.js';
import { assistantUzLatn } from '../../src/web/i18n/assistant.uz-Latn.js';
import { assistantRu } from '../../src/web/i18n/assistant.ru.js';
import type { AKey } from '../../src/web/assistant/i18n.js';
import { tab } from './ui.js';

/** Panel strings by short key, from the registered feature dictionaries. */
const strip = (d: Record<string, string>) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k.slice('assistant.'.length), v])) as Record<AKey, string>;
const assistantDictionaries = { 'uz-Cyrl': strip(assistant), 'uz-Latn': strip(assistantUzLatn), ru: strip(assistantRu) };

// The compiled server picks providers from the environment: simulated adapters, labelled in the UI.
process.env.ASSISTANT_SIMULATION = 'true';
const A = assistantDictionaries['uz-Cyrl'];
// Chromium's fake microphone feeds a real MediaRecorder stream through the real chunk upload path.
test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'], ...(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {}) }, permissions: ['microphone'] });

/** Task 017: the notebook is folded into the visit screen; the assistant opens from a called patient. */
async function openVisit(page: Page, f: Awaited<ReturnType<typeof processFixture>>, name: string) {
  const c = f.owner.clinicId, u = f.owner.userId, k = () => randomUUID(), day = k(), point = k(), patient = k(), visit = k();
  await f.pool.query("INSERT INTO business_days(id,clinic_id,business_date,status,opened_by) VALUES($1,$2,(now() AT TIME ZONE 'Asia/Tashkent')::date,'open',$3)", [day, c, u]);
  await f.pool.query("INSERT INTO queue_points(id,clinic_id,kind,user_id,name_uz_cyrl) VALUES($1,$2,'doctor',$3,'Синтетик хона 3')", [point, c, u]);
  await f.pool.query("INSERT INTO patients(id,clinic_id,display_name,full_name,provenance) VALUES($1,$2,$3,$3,'{}')", [patient, c, name]);
  await f.pool.query('INSERT INTO patient_assignments(clinic_id,patient_id,user_id) VALUES($1,$2,$3)', [c, patient, u]);
  await f.pool.query("INSERT INTO visits(id,clinic_id,patient_id,business_day_id,type,created_by) VALUES($1,$2,$3,$4,'outpatient',$5)", [visit, c, patient, day, u]);
  await f.pool.query('INSERT INTO queue_tickets(id,clinic_id,business_day_id,visit_id,queue_point_id,number) VALUES($1,$2,$3,$4,$5,1)', [k(), c, day, visit, point]);
  await page.goto(f.origin);
  await page.getByLabel(T('auth.identifier'), { exact: true }).fill('owner@example.test');
  await page.getByLabel(T('auth.password'), { exact: true }).fill(f.password);
  await page.getByRole('button', { name: T('auth.signIn'), exact: true }).click();
  await tab(page, T('role.doctor'));
  await page.getByRole('button', { name: T('doctor.callNext'), exact: true }).click();
  await page.getByRole('button', { name: T('doctor.start'), exact: true }).click();
  await expect(page.getByRole('heading', { name: A.title })).toBeVisible();
}
async function reviewAndApprove(page: Page) {
  const panel = page.locator('.assistant');
  await expect(panel.getByText(A.doneNotice)).toBeVisible({ timeout: 30000 });
  await expect(panel.getByText(A.simulatedBanner)).toBeVisible();
  // Source words open on tap.
  await panel.getByRole('button', { name: A.source }).first().click();
  await expect(panel.locator('blockquote.source')).toBeVisible();
  // Edit one field, accept the rest one by one.
  const complaints = panel.locator('.gp-field').first();
  await complaints.getByRole('button', { name: A.edit, exact: true }).click();
  await complaints.getByLabel(A['field.complaints']).fill('Бош ва томоқ оғриғи, қуруқ йўтал, 3 кун.');
  await complaints.getByRole('button', { name: A.save, exact: true }).click();
  await expect(complaints.getByText(A['status.edited'])).toBeVisible();
  const accepts = panel.getByRole('button', { name: A.accept, exact: true });
  for (let n = await accepts.count(); n > 0; n--) {
    await accepts.first().click();
    await expect(accepts).toHaveCount(n - 1); // Wait for the server round trip before the next field.
  }
  await expect(panel.getByText(A.ready)).toBeVisible();
  page.once('dialog', d => void d.accept());
  await panel.getByRole('button', { name: A.approve }).click();
  await expect(panel.getByRole('link', { name: A.openPdf })).toBeVisible();
  const href = await panel.getByRole('link', { name: A.openPdf }).getAttribute('href');
  const pdf = await page.request.get(new URL(href!, page.url()).toString());
  expect(pdf.status()).toBe(200);
  expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');
}

for (const width of [1280, 390]) test(`doctor records with the microphone, reviews field by field and approves at ${width}px`, async ({ page }) => {
  const f = await processFixture();
  try {
    await page.setViewportSize({ width, height: 900 });
    await openVisit(page, f, 'Fictional Dilnoza — demo only');
    const panel = page.locator('.assistant');
    const start = panel.getByRole('button', { name: A.start, exact: true });
    await expect(start).toBeDisabled(); // Recording needs the consent acknowledgement first.
    await panel.getByLabel(A.consent).check();
    await start.click();
    await expect(panel.locator('.rec-indicator')).toBeVisible();
    await page.waitForTimeout(6500); // At least one 5-second chunk uploads while recording.
    await panel.getByRole('button', { name: A.stop, exact: true }).click();
    await reviewAndApprove(page);
    const chunks = await f.pool.query('SELECT count(*) n FROM assistant_audio_chunks');
    expect(Number(chunks.rows[0].n)).toBeGreaterThanOrEqual(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await mkdir('work/browser-evidence', { recursive: true });
    await page.screenshot({ path: `work/browser-evidence/assistant-${width}.png`, fullPage: true });
  } finally { await f.close(); }
});

test('language switch and simulated demo fallback', async ({ page }) => {
  const f = await processFixture();
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openVisit(page, f, 'Fictional Fallback — demo only');
    const panel = page.locator('.assistant');
    // One header switch changes every screen, the assistant panel included (task 017).
    const languages = page.getByRole('banner').locator('.lang-switch'); // its label changes with the language
    await languages.getByRole('button', { name: 'Рус', exact: true }).click();
    await expect(panel.getByRole('heading', { name: assistantDictionaries.ru.title })).toBeVisible();
    await languages.getByRole('button', { name: 'Oʻzb', exact: true }).click();
    await expect(panel.getByRole('heading', { name: assistantDictionaries['uz-Latn'].title })).toBeVisible();
    await languages.getByRole('button', { name: 'Ўзб', exact: true }).click();
    await panel.getByRole('button', { name: A.demoRun }).click();
    await reviewAndApprove(page);
  } finally { await f.close(); }
});
