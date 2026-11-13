import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { processFixture } from './process-fixture.js';
import { passwordHash } from '../../src/server/security.js';
import { transaction } from '../../src/server/database.js';
import { seedDemoStaff } from '../../src/server/demo-staff.js';
import { seedDemoCatalog } from '../../src/server/demo-catalog.js';
import { seedDemoDay } from '../../src/server/demo-day.js';
import { DICTIONARIES } from '../../src/web/i18n/index.js';
import { registration as REG } from '../../src/web/i18n/registration.uz-Cyrl.js';
import type { Role } from '../../src/modules/identity/roles.js';

/*
 * Task 026: screenshots of every role on the synthetic demo clinic day, at 390 and 1366 px, in color and in
 * greyscale (rule 8: with color removed, sections and rows must still read). Full page, uploaded by CI as the
 * synthetic-browser-evidence artifact. The cashier and registration screens are also captured mid-task.
 * Also checks the type contract: the page renders in the bundled Onest, not a fallback.
 */
const OUT = 'work/browser-evidence/redesign';
const T = DICTIONARIES['uz-Cyrl'];
const LOGIN: Record<Role, string> = { ceo: 'ceo', administrator: 'admin', registrar: 'registrar', doctor: 'doctor', laboratory: 'lab', cashier: 'cashier', inpatient: 'inpatient', pharmacy: 'pharmacy' };

async function signIn(page: Page, origin: string, login: string, password: string) {
  await page.goto(origin);
  await page.evaluate(() => { try { localStorage.removeItem('clinora.locale'); } catch { /* fresh profile */ } });
  await page.goto(origin);
  await page.getByLabel(T['auth.identifier'], { exact: true }).fill(login);
  await page.getByLabel(T['auth.password'], { exact: true }).fill(password);
  await page.getByRole('button', { name: T['auth.signIn'], exact: true }).click();
  await expect(page.locator('main.page')).toBeVisible();
  await page.waitForTimeout(500);
}
async function signOut(page: Page, phone: boolean) {
  if (phone) await page.locator('.header-menu-toggle').click();
  await page.getByRole('button', { name: T['app.signOut'], exact: true }).click();
  await expect(page.getByLabel(T['auth.identifier'], { exact: true })).toBeVisible();
}
async function shoot(page: Page, name: string, width: number) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${OUT}/${name}-${width}.png`, fullPage: true });
  // CSSOM, not a <style> tag: the app's CSP (style-src 'self') blocks inline style elements.
  await page.evaluate(() => { document.documentElement.style.filter = 'grayscale(1)'; });
  await page.screenshot({ path: `${OUT}/${name}-${width}-grey.png`, fullPage: true });
  await page.evaluate(() => { document.documentElement.style.filter = ''; });
}

test.use({ actionTimeout: 15000 });
test('redesign screenshots: every role at 390 and 1366, color and greyscale, in the bundled font', async ({ browser }) => {
  test.setTimeout(300000);
  const f = await processFixture({ ASSISTANT_SIMULATION: 'false' });
  try {
    const c = f.owner.clinicId, hash = await passwordHash(f.password), ceoId = randomUUID();
    await transaction(f.pool, async tx => {
      await tx.query('INSERT INTO accounts(id,login,display_name,password_hash,managed_by_clinic_id) VALUES($1,$2,$3,$4,$5)', [ceoId, 'shot.ceo', 'Синтетик Раҳбар', hash, c]);
      await tx.query("INSERT INTO memberships(id,clinic_id,user_id,role,clinical_access,patient_scope,status,granted_by) VALUES($1,$2,$3,'administrator',false,'assigned','active',$4)", [randomUUID(), c, ceoId, f.owner.userId]);
      await tx.query("INSERT INTO membership_roles(clinic_id,user_id,role,granted_by) VALUES($1,$2,'ceo',$3)", [c, ceoId, f.owner.userId]);
      const { ids, doctorIds } = await seedDemoStaff(tx, c, ceoId, hash, 'shot');
      await seedDemoCatalog(tx, c, ceoId, doctorIds);
      await seedDemoDay(tx, c, { ...ids, doctorIds } as Parameters<typeof seedDemoDay>[2]);
    });
    await mkdir(OUT, { recursive: true });
    for (const width of [390, 1366]) {
      const phone = width < 900;
      // Phones at device scale 2 (what a person sees); the desktop capture at 1 keeps the files reviewable.
      const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, deviceScaleFactor: phone ? 2 : 1 });
      const page = await context.newPage();
      for (const role of Object.keys(LOGIN) as Role[]) {
        await signIn(page, f.origin, `shot.${LOGIN[role]}`, f.password);
        const family = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
        expect(family).toMatch(/^"?Onest"?/);
        expect(await page.evaluate(() => document.fonts.check('16px Onest', 'Ўзбекча қўғҳ ʻ'))).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await shoot(page, role, width);
        if (role === 'cashier') {
          const cash = page.locator('section.cashier');
          // An outpatient who still owes money, so the bill shows a balance due.
          const owing = (await f.pool.query(`SELECT p.patient_no,p.full_name FROM visits v JOIN patients p ON p.clinic_id=v.clinic_id AND p.id=v.patient_id
            WHERE v.clinic_id=$1 AND v.type='outpatient' AND (SELECT coalesce(sum(quantity*unit_price_uzs),0) FROM charge_lines l WHERE l.clinic_id=v.clinic_id AND l.visit_id=v.id AND l.status<>'cancelled')
              > (SELECT coalesce(sum(CASE kind WHEN 'payment' THEN amount_uzs ELSE -amount_uzs END),0) FROM payments x WHERE x.clinic_id=v.clinic_id AND x.visit_id=v.id)
            ORDER BY p.patient_no LIMIT 1`, [c])).rows[0] as { patient_no: number; full_name: string };
          const no = owing.patient_no, surname = owing.full_name.split(' ')[0]!;
          await cash.getByLabel(T['cashier.search'], { exact: true }).fill(String(no));
          await cash.getByRole('button', { name: T['cashier.find'], exact: true }).click();
          await cash.getByRole('button', { name: new RegExp(`^${no} · ${surname}`) }).click();
          await expect(cash.getByRole('heading', { name: owing.full_name, exact: true })).toBeVisible();
          await shoot(page, 'cashier-bill', width);
        }
        if (role === 'registrar') {
          const reg = page.locator('section.registration');
          await reg.getByLabel(REG['registration.search'], { exact: true }).fill('Каримова');
          await reg.getByRole('button', { name: REG['registration.find'], exact: true }).click();
          await expect(reg.locator('.registration-results li').first()).toBeVisible();
          await shoot(page, 'registration-results', width);
          await reg.locator('.registration-results button').first().click();
          await reg.locator('.registration-point').first().getByRole('checkbox').check();
          await shoot(page, 'registration-route', width);
          await reg.getByText(REG['registration.more'], { exact: true }).click();
          await reg.getByRole('button', { name: REG['registration.back'], exact: true }).click();
          await reg.getByRole('button', { name: REG['registration.new'], exact: true }).click();
          await shoot(page, 'registration-form', width);
          await reg.getByRole('button', { name: REG['registration.back'], exact: true }).click();
        }
        await signOut(page, phone);
      }
      await context.close();
    }
  } finally { await f.close(); }
});
