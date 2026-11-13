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
import { ceo as CEO } from '../../src/web/i18n/ceo.uz-Cyrl.js';
import { lab as LAB } from '../../src/web/i18n/lab.uz-Cyrl.js';
import type { Role } from '../../src/modules/identity/roles.js';

/*
 * Task 025: phone layout on the synthetic demo clinic day. Every role at 390x844: no sideways scrolling and a
 * one-row header; the CEO dashboard collapses its breakdowns; first-screen screenshots at 390 and 1366 px.
 */
const OUT = 'work/browser-evidence/phone';
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
  await page.waitForTimeout(500); // let the landing screen finish loading before measuring
}
async function signOut(page: Page, phone: boolean) {
  if (phone) await page.locator('.header-menu-toggle').click();
  await page.getByRole('button', { name: T['app.signOut'], exact: true }).click();
  await expect(page.getByLabel(T['auth.identifier'], { exact: true })).toBeVisible();
}

test.use({ actionTimeout: 15000 });
test('phone layout: one-row header and no sideways scroll for every role; CEO dashboard collapses', async ({ page }) => {
  test.setTimeout(240000);
  const f = await processFixture({ ASSISTANT_SIMULATION: 'false' });
  try {
    const c = f.owner.clinicId, hash = await passwordHash(f.password), ceoId = randomUUID();
    await transaction(f.pool, async tx => {
      await tx.query('INSERT INTO accounts(id,login,display_name,password_hash,managed_by_clinic_id) VALUES($1,$2,$3,$4,$5)', [ceoId, 'phone.ceo', 'Синтетик Раҳбар', hash, c]);
      await tx.query("INSERT INTO memberships(id,clinic_id,user_id,role,clinical_access,patient_scope,status,granted_by) VALUES($1,$2,$3,'administrator',false,'assigned','active',$4)", [randomUUID(), c, ceoId, f.owner.userId]);
      await tx.query("INSERT INTO membership_roles(clinic_id,user_id,role,granted_by) VALUES($1,$2,'ceo',$3)", [c, ceoId, f.owner.userId]);
      const { ids, doctorIds } = await seedDemoStaff(tx, c, ceoId, hash, 'phone');
      await seedDemoCatalog(tx, c, ceoId, doctorIds);
      await seedDemoDay(tx, c, { ...ids, doctorIds } as Parameters<typeof seedDemoDay>[2]);
    });
    await mkdir(OUT, { recursive: true });
    const problems: string[] = [];
    for (const width of [390, 1366]) {
      const phone = width < 900;
      await page.setViewportSize({ width, height: 844 });
      for (const role of Object.keys(LOGIN) as Role[]) {
        await signIn(page, f.origin, `phone.${LOGIN[role]}`, f.password);
        const m = await page.evaluate(() => {
          const bar = document.querySelector('.topbar')!.getBoundingClientRect();
          const parts = ['.topbar .brand', '.topbar > .pill', '.header-menu-toggle'].map(s => document.querySelector(s)?.getBoundingClientRect());
          return { scroll: document.documentElement.scrollWidth, inner: window.innerWidth, bar: bar.height, height: document.documentElement.scrollHeight,
            parts: parts.map(r => r && r.width ? { top: r.top, bottom: r.bottom } : null) };
        });
        if (m.scroll > m.inner) problems.push(`${role} ${width}px: page scrolls sideways (${m.scroll}px)`);
        if (phone) {
          // One row: logo, business-day badge and menu button share a line, and the header is no taller than one touch row.
          if (m.bar > 72) problems.push(`${role}: header is ${Math.round(m.bar)}px high`);
          if (m.parts.some(p => !p)) problems.push(`${role}: header is missing the logo, day badge or menu button`);
          const rows = m.parts.filter(Boolean) as { top: number; bottom: number }[];
          if (rows.some(a => rows.some(b => a.bottom <= b.top))) problems.push(`${role}: header items are on more than one row`);
          // The menu holds the name, language, PIN and Telegram, and sign out.
          await page.locator('.header-menu-toggle').click();
          const panel = page.locator('.header-menu-panel');
          await expect(panel.locator('.lang-switch')).toBeVisible();
          await expect(panel.getByRole('button', { name: T['access.me.button'], exact: true })).toBeVisible();
          await expect(panel.getByRole('button', { name: T['app.signOut'], exact: true })).toBeVisible();
          await page.keyboard.press('Escape');
          await expect(panel.locator('.lang-switch')).toBeHidden();
          await expect(page.locator('.header-menu-toggle')).toBeFocused();
          // No tab row is cut off at the right edge.
          const clipped = await page.evaluate(() => Array.from(document.querySelectorAll('nav.sections > button, nav.sections > .tabs-more > button'))
            .filter(b => b.getBoundingClientRect().right > window.innerWidth + 0.5).map(b => b.textContent));
          if (clipped.length) problems.push(`${role}: tabs cut off: ${clipped.join(', ')}`);
          if (role === 'ceo') test.info().annotations.push({ type: 'ceo-dashboard-height-390', description: `${m.height}px` });
        } else {
          await expect(page.locator('.header-menu-toggle')).toBeHidden();
          await expect(page.getByRole('banner').locator('.lang-switch')).toBeVisible();
          await expect(page.getByRole('banner').getByRole('button', { name: T['app.signOut'], exact: true })).toBeVisible();
        }
        await page.screenshot({ path: `${OUT}/${role}-${width}.png`, fullPage: true });

        if (role === 'ceo' && phone) {
          // About three phone screens for the default view (measured 2,720 px on the demo day; 6,597 px before task 025).
          expect(m.height, 'CEO dashboard height at 390x844').toBeLessThan(3000);
          const doctors = page.locator('.ceo-breakdown').filter({ has: page.getByRole('heading', { name: CEO['ceo.doctors'], exact: true }) });
          const rows = doctors.locator('.ceo-row');
          await expect(rows).toHaveCount(3);
          const total = (await f.pool.query("SELECT count(DISTINCT performer_user_id)::int n FROM charge_lines WHERE clinic_id=$1 AND performer_user_id IS NOT NULL", [c])).rows[0].n as number;
          const allButton = doctors.locator('.ceo-all');
          const count = Number((await allButton.textContent())!.match(/\d+/)![0]);
          expect(count).toBeGreaterThan(3);
          expect(count).toBeGreaterThanOrEqual(total); // every performing doctor has a row (plus the "no doctor" row)
          // Largest first.
          const amounts = async () => (await rows.locator('.ceo-row-main b').allTextContents()).map(s => Number(s.replace(/\D/g, '')));
          const top = await amounts();
          expect(top).toEqual([...top].sort((a, b) => b - a));
          await allButton.click();
          await expect(rows).toHaveCount(count);
          const every = await amounts();
          expect(every).toEqual([...every].sort((a, b) => b - a));
          await expect(doctors).not.toContainText(/^—$/);
          await expect(doctors.locator('.ceo-row-main > span:first-child').filter({ hasText: /^—$/ })).toHaveCount(0);
          // A department chip narrows the list to that department's doctors; "All" restores it.
          const chips = doctors.locator('.ceo-chips button');
          await expect(chips.first()).toHaveAttribute('aria-pressed', 'true');
          const chip = chips.nth(1), name = (await chip.textContent())!.replace(/^#/, '');
          const members = (await f.pool.query(`SELECT a.display_name FROM doctor_profiles dp JOIN departments d ON d.clinic_id=dp.clinic_id AND d.id=dp.department_id
            JOIN accounts a ON a.id=dp.user_id WHERE dp.clinic_id=$1 AND d.name_uz_cyrl=$2`, [c, name])).rows.map(r => r.display_name as string);
          await chip.click();
          await expect(chip).toHaveAttribute('aria-pressed', 'true');
          const filtered = await doctors.locator('.ceo-row-main > span:first-child').allTextContents();
          expect(filtered.length).toBeGreaterThan(0);
          expect(filtered.length).toBeLessThan(count);
          for (const doctor of filtered) expect(members, `${doctor} belongs to ${name}`).toContain(doctor);
          await chips.first().click();
          await expect(doctors.locator('.ceo-row')).toHaveCount(3);
          // Tapping a row expands its details in place; the arrow still opens the ledger.
          const first = rows.first();
          await first.locator('.ceo-row-main').click();
          await expect(first.locator('.ceo-row-main')).toHaveAttribute('aria-expanded', 'true');
          await expect(first.locator('.ceo-performance-facts button')).toHaveText([CEO['ceo.patients'], CEO['ceo.value'], CEO['ceo.discounts'], CEO['ceo.outstanding']].map(s => new RegExp(`^${s}`)));
          await first.locator('.ceo-row-open').click();
          await expect(page.locator('.ceo-ledger h2')).toBeFocused();
          await page.getByRole('button', { name: CEO['ceo.back'], exact: true }).click();
          // Patient sources are translated; raw codes never show.
          const sources = page.locator('.ceo-breakdown').filter({ has: page.getByRole('heading', { name: CEO['ceo.sources'], exact: true }) });
          await sources.locator('.ceo-all').click().catch(() => undefined);
          await expect(sources).not.toContainText(/walk_in|referral|advertisement|social|returning/);
          await expect(sources).toContainText(CEO['ceo.source.referral']);
        }
        if (role === 'laboratory' && phone) {
          // Orders placed at registration say so; they never call the registrar the ordering doctor (task 025).
          const registrar = (await f.pool.query("SELECT display_name FROM accounts WHERE login='phone.registrar'")).rows[0].display_name as string;
          const lab = page.locator('.page');
          await expect(lab).toContainText(LAB['lab.orderedAtRegistration'].replace('{name}', registrar).replace('{role}', T['role.registrar']));
          await expect(lab).not.toContainText(LAB['lab.orderedBy'].replace('{name}', registrar));
        }
        await signOut(page, phone);
      }
    }
    expect([...new Set(problems)]).toEqual([]);
  } finally { await f.close(); }
});
