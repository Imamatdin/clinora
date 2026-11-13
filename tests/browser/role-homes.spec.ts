import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { processFixture } from './process-fixture.js';
import { passwordHash } from '../../src/server/security.js';
import { transaction } from '../../src/server/database.js';
import { seedDemoStaff } from '../../src/server/demo-staff.js';
import { seedDemoCatalog } from '../../src/server/demo-catalog.js';
import { DICTIONARIES, LOCALE_LABELS, LOCALES, type UiKey } from '../../src/web/i18n/index.js';
import { MODULES, modulesFor } from '../../src/web/modules.js';
import type { Role } from '../../src/modules/identity/roles.js';

/*
 * Task 017: every role lands on its main job, sees only its own modules, and the screen follows the ease-of-use
 * rules (no icon-only buttons, touch targets of at least 48 px, no sideways scrolling) in all three languages.
 * Screenshots of every role home in uz-Cyrl, uz-Latn and ru are kept as CI artifacts.
 */
const OUT = 'work/browser-evidence/role-homes';
/** The module each role lands on: its main job. */
const LANDING: Record<Role, string> = { ceo: 'dashboard', administrator: 'cashier', registrar: 'registration', doctor: 'doctor', laboratory: 'lab', cashier: 'cashier', inpatient: 'inpatient', pharmacy: 'pharmacy' };
const LOGIN: Record<Exclude<Role, 'ceo'>, string> = { administrator: 'admin', registrar: 'registrar', doctor: 'doctor', laboratory: 'lab', cashier: 'cashier', inpatient: 'inpatient', pharmacy: 'pharmacy' };

test.use({ actionTimeout: 15000 });
test('role homes: landing module, own navigation and ease-of-use rules in three languages', async ({ page }) => {
  test.setTimeout(240000);
  const f = await processFixture({ ASSISTANT_SIMULATION: 'false' });
  try {
    const c = f.owner.clinicId, hash = await passwordHash(f.password);
    // A CEO-only account, so the CEO home is the CEO's alone (the fixture owner also holds other roles).
    const ceo = randomUUID();
    await transaction(f.pool, async tx => {
      const s = await seedDemoStaff(tx, c, f.owner.userId, hash, 'home');
      await seedDemoCatalog(tx, c, f.owner.userId, s.doctorIds);
      await tx.query('INSERT INTO accounts(id,login,display_name,password_hash,managed_by_clinic_id) VALUES($1,$2,$3,$4,$5)', [ceo, 'home.ceo', 'Синтетик Раҳбар', hash, c]);
      await tx.query("INSERT INTO memberships(id,clinic_id,user_id,role,clinical_access,patient_scope,status,granted_by) VALUES($1,$2,$3,'administrator',false,'assigned','active',$4)", [randomUUID(), c, ceo, f.owner.userId]);
      await tx.query("INSERT INTO membership_roles(clinic_id,user_id,role,granted_by) VALUES($1,$2,'ceo',$3)", [c, ceo, f.owner.userId]);
      await tx.query("INSERT INTO business_days(id,clinic_id,business_date,status,opened_by) VALUES($1,$2,(now() AT TIME ZONE 'Asia/Tashkent')::date,'open',$3)", [randomUUID(), c, f.owner.userId]);
    });
    await mkdir(OUT, { recursive: true });
    const problems: string[] = [];
    for (const width of [360, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      for (const role of Object.keys(LANDING) as Role[]) {
        const login = role === 'ceo' ? 'home.ceo' : `home.${LOGIN[role]}`;
        await page.goto(f.origin);
        await page.evaluate(() => { try { localStorage.removeItem('clinora.locale'); } catch { /* fresh profile */ } });
        await page.goto(f.origin);
        const T0 = DICTIONARIES['uz-Cyrl'];
        await page.getByLabel(T0['auth.identifier'], { exact: true }).fill(login);
        await page.getByLabel(T0['auth.password'], { exact: true }).fill(f.password);
        await page.getByRole('button', { name: T0['auth.signIn'], exact: true }).click();
        for (const locale of LOCALES) {
          const D = DICTIONARIES[locale], T = (k: UiKey) => D[k];
          await page.getByRole('banner').locator('.lang-switch').getByRole('button', { name: LOCALE_LABELS[locale], exact: true }).click();
          await expect(page.getByRole('banner').getByRole('group', { name: T('app.language') })).toBeVisible();
          await expect(page.getByRole('heading', { level: 1, name: T(`home.${role}.title` as UiKey) })).toBeVisible();
          await expect(page.locator('html')).toHaveAttribute('lang', locale);
          // Navigation lists exactly this role's modules, the landing module first and current.
          const mine = modulesFor(role, MODULES);
          expect(mine[0]!.id, `${role} lands on its main job`).toBe(LANDING[role]);
          if (mine.length > 1) {
            const tabs = page.locator('.role-modules > nav.sections button');
            await expect(tabs).toHaveText(mine.map(m => T(m.label)));
            await expect(tabs.first()).toHaveAttribute('aria-current', 'page');
          }
          await page.waitForTimeout(300); // let the landing screen finish loading before measuring
          // Ease-of-use checks on every visible button and the page width.
          const found = await page.evaluate(() => {
            const out: string[] = [];
            for (const b of Array.from(document.querySelectorAll('button'))) {
              const r = b.getBoundingClientRect();
              if (!r.width || !r.height || getComputedStyle(b).visibility === 'hidden') continue;
              const text = (b.textContent ?? '').trim();
              if (!/[\p{L}\p{N}]/u.test(text)) out.push(`icon-only button "${b.getAttribute('aria-label') ?? text}"`);
              if (r.height < 47.5) out.push(`button "${text.slice(0, 30)}" is ${Math.round(r.height)}px high`);
            }
            if (document.documentElement.scrollWidth > window.innerWidth) out.push(`page scrolls sideways (${document.documentElement.scrollWidth}px)`);
            return out;
          });
          problems.push(...found.map(p => `${role} ${locale} ${width}px: ${p}`));
          await page.screenshot({ path: `${OUT}/${role}-${locale}-${width}.png`, fullPage: true });
        }
        await page.getByRole('button', { name: DICTIONARIES.ru['app.signOut'], exact: true }).click();
        await expect(page.getByLabel(DICTIONARIES.ru['auth.identifier'], { exact: true })).toBeVisible();
      }
    }
    expect([...new Set(problems)]).toEqual([]);
  } finally { await f.close(); }
});
