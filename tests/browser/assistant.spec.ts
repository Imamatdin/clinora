import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { processFixture, T } from './process-fixture.js';
import { assistant } from '../../src/web/i18n/assistant.uz-Cyrl.js';
import { assistantUzLatn } from '../../src/web/i18n/assistant.uz-Latn.js';
import { assistantRu } from '../../src/web/i18n/assistant.ru.js';
import type { AKey } from '../../src/web/assistant/i18n.js';

/** Panel strings by short key, from the registered feature dictionaries. */
const strip = (d: Record<string, string>) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k.slice('assistant.'.length), v])) as Record<AKey, string>;
const assistantDictionaries = { 'uz-Cyrl': strip(assistant), 'uz-Latn': strip(assistantUzLatn), ru: strip(assistantRu) };

// The compiled server picks providers from the environment: simulated adapters, labelled in the UI.
process.env.ASSISTANT_SIMULATION = 'true';
const A = assistantDictionaries['uz-Cyrl'];
// Chromium's fake microphone feeds a real MediaRecorder stream through the real chunk upload path.
test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'], ...(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {}) }, permissions: ['microphone'] });

async function openVisit(page: Page, origin: string, password: string, name: string) {
  await page.goto(origin);
  await page.getByLabel(T('auth.identifier'), { exact: true }).fill('owner@example.test');
  await page.getByLabel(T('auth.password'), { exact: true }).fill(password);
  await page.getByRole('button', { name: T('auth.signIn'), exact: true }).click();
  await page.getByRole('navigation', { name: T('app.navigation') }).getByRole('button', { name: T('role.doctor'), exact: true }).click();
  await page.getByRole('button', { name: T('notebook.newPatient'), exact: true }).click();
  await page.getByLabel(T('notebook.patientName'), { exact: true }).fill(name);
  await page.getByRole('button', { name: T('notebook.createPatient'), exact: true }).click();
  await page.getByRole('button', { name: T('notebook.newEncounter') }).click();
  await page.getByLabel(T('notebook.visitDate'), { exact: true }).fill('2026-11-19');
  await page.getByLabel(T('notebook.location'), { exact: true }).fill('Synthetic room 3');
  await page.getByRole('button', { name: T('notebook.createEncounter'), exact: true }).click();
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
    await openVisit(page, f.origin, f.password, 'Fictional Dilnoza — demo only');
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
    await openVisit(page, f.origin, f.password, 'Fictional Fallback — demo only');
    const panel = page.locator('.assistant');
    await panel.getByRole('button', { name: 'Рус', exact: true }).click();
    await expect(panel.getByRole('heading', { name: assistantDictionaries.ru.title })).toBeVisible();
    await panel.getByRole('button', { name: 'Oʻzb', exact: true }).click();
    await expect(panel.getByRole('heading', { name: assistantDictionaries['uz-Latn'].title })).toBeVisible();
    await panel.getByRole('button', { name: 'Ўзб', exact: true }).click();
    await panel.getByRole('button', { name: A.demoRun }).click();
    await reviewAndApprove(page);
  } finally { await f.close(); }
});
