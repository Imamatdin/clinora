import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { processFixture, T } from './process-fixture.js';
import { passwordHash } from '../../src/server/security.js';
import { catalogUzCyrl } from '../../src/web/i18n/catalog.uz-Cyrl.js';
import { sampleSections, synthDt, PATIENT_MARKER } from '../../src/modules/import1c/synthetic.js';

const C = (key: keyof typeof catalogUzCyrl, vars: Record<string, string | number> = {}) => catalogUzCyrl[key].replace(/\{(\w+)\}/g, (_, n: string) => String(vars[n]));

test('administrator imports a synthetic 1C dump in the browser, previews, commits, finds a service in Latin and sets a new price', async ({ page }) => {
  const f = await processFixture();
  try {
    const c = f.owner.clinicId, adminId = randomUUID();
    await f.pool.query("INSERT INTO accounts(id,email,display_name,password_hash) VALUES($1,'admin.b005@example.test','Синтетик Администратор',$2)", [adminId, await passwordHash(f.password)]);
    await f.pool.query("INSERT INTO memberships(id,clinic_id,user_id,status,granted_by) VALUES($1,$2,$3,'active',$4)", [randomUUID(), c, adminId, f.owner.userId]);
    await f.pool.query("INSERT INTO membership_roles(clinic_id,user_id,role,granted_by) VALUES($1,$2,'administrator',$3)", [c, adminId, f.owner.userId]);
    await mkdir('work/browser-evidence', { recursive: true });
    const dump = 'work/browser-evidence/synthetic-clinic.dt';
    await writeFile(dump, synthDt(sampleSections()));
    const sent: string[] = [];
    page.on('request', r => { if (r.method() === 'POST') sent.push(r.postData() ?? ''); });

    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto(f.origin);
    await page.getByLabel(T('auth.identifier'), { exact: true }).fill('admin.b005@example.test');
    await page.getByLabel(T('auth.password'), { exact: true }).fill(f.password);
    await page.getByRole('button', { name: T('auth.signIn'), exact: true }).click();
    const nav = page.getByRole('button', { name: T('module.catalog'), exact: true });
    await nav.click(); // administrators see several modules (cashier, pharmacy, catalog)
    await expect(page.getByRole('heading', { name: C('catalog.title'), exact: true })).toBeVisible();

    await page.getByRole('tab', { name: C('catalog.tab.import'), exact: true }).click();
    await page.getByLabel(C('catalog.import.file'), { exact: true }).setInputFiles(dump);
    await expect(page.getByText(C('catalog.import.found', { count: 17 }), { exact: true })).toBeVisible();
    await expect(page.getByText(`Справочник.БЕМОРЛАР: ${C('catalog.import.skipped')}`)).toBeVisible();
    await page.getByRole('button', { name: C('catalog.import.upload'), exact: true }).click();
    await expect(page.getByRole('heading', { name: C('catalog.import.preview'), exact: true })).toBeVisible();
    await expect(page.getByText(C('catalog.import.rejectedTitle', { count: 4 }))).toBeVisible();
    await page.screenshot({ path: 'work/browser-evidence/catalog-import-preview-360.png', fullPage: true });
    expect(await f.pool.query('SELECT count(*)::int n FROM services WHERE clinic_id=$1', [c]).then(r => r.rows[0].n)).toBe(0);
    await page.getByRole('button', { name: C('catalog.import.commit'), exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: C('catalog.import.commit'), exact: true }).click();
    await expect(page.getByText(C('catalog.import.committed', { new: 13, changed: 0, prices: 4 }), { exact: true })).toBeVisible();
    expect(sent.join('\n')).not.toContain(PATIENT_MARKER); // the dump's patient records never left the browser

    await page.getByRole('tab', { name: C('catalog.tab.lists'), exact: true }).click();
    await page.getByLabel(C('catalog.search'), { exact: true }).fill('ultratovush');
    await page.getByRole('button', { name: C('catalog.find'), exact: true }).click();
    const item = page.locator('.catalog-items > li', { hasText: 'Нурланиш диагностика Ультратовуш' });
    await expect(item).toContainText('150 000 сўм');
    await expect(item).toContainText('10902002002000003');
    await item.getByRole('button', { name: C('catalog.setPrice'), exact: true }).click();
    await page.getByLabel(C('catalog.price.amount'), { exact: true }).fill('175000');
    await page.locator('.catalog-panel').getByRole('button', { name: C('catalog.setPrice'), exact: true }).click();
    await expect(page.getByText(C('catalog.price.confirm', { amount: '175 000 сўм' }), { exact: true })).toBeVisible();
    await page.getByRole('alertdialog').getByRole('button', { name: C('catalog.save'), exact: true }).click();
    await expect(page.getByText(C('catalog.price.set'), { exact: true })).toBeVisible();
    await expect(item).toContainText('175 000 сўм');
    const history = (await f.pool.query("SELECT p.price_uzs::text p FROM service_prices p JOIN services s ON s.id=p.service_id WHERE s.clinic_id=$1 AND s.code_1c='МУОЛАЖА/10902002002000003' ORDER BY p.effective_from", [c])).rows.map(r => r.p);
    expect(history).toEqual(['150000', '175000']);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: 'work/browser-evidence/catalog-list-360.png', fullPage: true });
  } finally { await f.close(); }
});
