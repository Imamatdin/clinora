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
import { go, headerButton } from './ui.js';

/*
 * Task 028: screenshots of every role on the synthetic demo clinic day, at 390 and 1440 px, in color and in
 * greyscale (docs/DESIGN.md: with color removed, structure must still read). Uploaded by CI as the
 * synthetic-browser-evidence artifact. Sign-in, Settings, and the doctor, cashier and registration screens mid-task
 * are captured too. Also checks the type contract: the page renders in the bundled Onest, names in the bundled serif.
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
async function signOut(page: Page) {
  await headerButton(page, T['app.signOut']);
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
test('design screenshots: every role at 390 and 1440, color and greyscale, in the bundled fonts', async ({ browser }) => {
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
    for (const width of [390, 1440]) {
      const phone = width < 900;
      // Phones at device scale 2 (what a person sees); the desktop capture at 1 keeps the files reviewable.
      const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, deviceScaleFactor: phone ? 2 : 1 });
      const page = await context.newPage();
      await page.goto(f.origin); await expect(page.getByLabel(T['auth.identifier'], { exact: true })).toBeVisible(); await shoot(page, 'sign-in', width);
      for (const role of Object.keys(LOGIN) as Role[]) {
        await signIn(page, f.origin, `shot.${LOGIN[role]}`, f.password);
        const family = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
        expect(family).toMatch(/^"?Onest"?/);
        expect(await page.evaluate(() => document.fonts.check('16px Onest', 'Ўзбекча қўғҳ ʻ'))).toBe(true);
        // Names are set in the bundled serif: its Cyrillic, extended Cyrillic and Latin subsets all load from this origin.
        expect(await page.evaluate(async () => (await document.fonts.load('600 16px "Source Serif 4"', 'Ҳамидов Қўчқор Ғайрат oʻgʻli')).length)).toBeGreaterThanOrEqual(3);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await shoot(page, role, width);
        if (role === 'doctor') {
          // Call the next patient and open the visit: the doctor's working screen.
          const dr = page.locator('section.dr');
          const act = dr.locator('.dr-current button.primary'), visit = dr.locator('.dr-visit');
          await act.click(); // call the next patient (or, on the second pass, reopen the visit already started)
          await page.waitForTimeout(1200); // the queue reloads, then either the visit is open or the button now says "start"
          if (!await visit.isVisible()) await act.click();
          await expect(visit).toBeVisible();
          await shoot(page, 'doctor-visit', width);
        }
        if (role === 'cashier') {
          const cash = page.locator('section.cashier');
          // An outpatient who still owes money, so the bill shows a balance due.
          const owing = (await f.pool.query(`SELECT p.patient_no,p.full_name FROM visits v JOIN patients p ON p.clinic_id=v.clinic_id AND p.id=v.patient_id
            WHERE v.clinic_id=$1 AND v.type='outpatient' AND (SELECT coalesce(sum(quantity*unit_price_uzs),0) FROM charge_lines l WHERE l.clinic_id=v.clinic_id AND l.visit_id=v.id AND l.status<>'cancelled')
              > (SELECT coalesce(sum(CASE kind WHEN 'payment' THEN amount_uzs ELSE -amount_uzs END),0) FROM payments x WHERE x.clinic_id=v.clinic_id AND x.visit_id=v.id)
            ORDER BY p.patient_no LIMIT 1`, [c])).rows[0] as { patient_no: number; full_name: string };
          await cash.getByLabel(T['cashier.search'], { exact: true }).fill(String(owing.patient_no));
          await cash.getByRole('button', { name: T['cashier.find'], exact: true }).click();
          await cash.getByRole('button', { name: `${owing.patient_no} · ${owing.full_name}`, exact: true }).click();
          await expect(cash.getByRole('heading', { name: owing.full_name, exact: true })).toBeVisible();
          await cash.getByLabel(T['cashier.given'], { exact: true }).fill('200000');
          await shoot(page, 'cashier-bill', width);
        }
        if (role === 'registrar') {
          const reg = page.locator('section.registration');
          await reg.getByLabel(REG['registration.search'], { exact: true }).fill('Каримова');
          await expect(reg.locator('.registration-results li').first()).toBeVisible(); // results appear as she types
          await shoot(page, 'registration-results', width);
          await reg.locator('.registration-results button').first().click();
          await reg.locator('.registration-point').first().getByRole('checkbox').check();
          await shoot(page, 'registration-route', width);
          await reg.getByRole('button', { name: REG['registration.back'], exact: true }).click();
          await reg.getByRole('button', { name: REG['registration.new'], exact: true }).click();
          await shoot(page, 'registration-form', width);
          await reg.getByRole('button', { name: REG['registration.back'], exact: true }).click();
        }
        if (role === 'ceo') {
          await go(page, 'payroll');
          await page.locator('.ceo-dates button').click();
          await expect(page.locator('.ceo-pay-results')).toBeVisible();
          await shoot(page, 'payroll', width);
          await go(page, 'reports'); await expect(page.locator('.ceo-report')).toBeVisible(); await shoot(page, 'cash-report', width);
          await go(page, 'settings'); await shoot(page, 'settings', width);
        }
        if (role === 'administrator') {
          await go(page, 'staff'); await expect(page.locator('.staff-list > li').first()).toBeVisible(); await shoot(page, 'staff', width);
          await go(page, 'catalog'); await page.waitForTimeout(600); await shoot(page, 'catalog', width);
        }
        if (role === 'laboratory') {
          await page.locator('.dr-orders button').first().click();
          await expect(page.locator('.lab-order')).toBeVisible();
          await shoot(page, 'lab-order', width);
        }
        if (role === 'inpatient') {
          await page.locator('.stays button').first().click();
          await expect(page.getByTestId('inpatient-due')).toBeVisible();
          await shoot(page, 'ward-stay', width);
        }
        await signOut(page);
      }
      await context.close();
    }
  } finally { await f.close(); }
});
