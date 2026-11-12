import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { passwordHash } from '../../src/server/security.js';
import { processFixture, T } from './process-fixture.js';

async function signIn(page: Page, identifier: string, password: string) {
  await page.getByLabel(T('auth.identifier'), { exact: true }).fill(identifier);
  await page.getByLabel(T('auth.password'), { exact: true }).fill(password);
  await page.getByRole('button', { name: T('auth.signIn'), exact: true }).click();
}

// Task 003A acceptance: administrator signs in, opens the day, creates a cashier; the cashier signs in and sees the cashier home.
for (const width of [1280, 360]) test(`administrator opens the day and creates a cashier who reaches the cashier home at ${width}px`, async ({ page }) => {
  const f = await processFixture();
  try {
    // An administrator-only staff member (not CEO, no doctor role), created the way staff management stores one.
    const adminId = randomUUID(), adminPassword = 'Synthetic-' + randomUUID();
    await f.pool.query('INSERT INTO accounts(id,login,display_name,password_hash,managed_by_clinic_id) VALUES($1,$2,$3,$4,$5)', [adminId, 'admin.browser', 'Синтетик Администратор', await passwordHash(adminPassword), f.owner.clinicId]);
    await f.pool.query("INSERT INTO memberships(id,clinic_id,user_id,status,granted_by) VALUES($1,$2,$3,'active',$4)", [randomUUID(), f.owner.clinicId, adminId, f.owner.userId]);
    await f.pool.query("INSERT INTO membership_roles(clinic_id,user_id,role,granted_by) VALUES($1,$2,'administrator',$3)", [f.owner.clinicId, adminId, f.owner.userId]);

    await page.setViewportSize({ width, height: 900 });
    await page.goto(f.origin);
    await signIn(page, 'admin.browser', adminPassword);
    await expect(page.getByRole('heading', { name: T('home.administrator.title'), level: 1 })).toBeVisible();
    await expect(page.getByText('Synthetic North Clinic', { exact: true })).toBeVisible();
    const header = page.getByRole('banner');
    await expect(header.getByText(T('day.none'), { exact: true })).toBeVisible();

    await page.getByRole('button', { name: T('day.openButton'), exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: T('day.openedNotice') })).toBeVisible();
    await expect(header.locator('[data-state="open"]')).toBeVisible();
    await expect(page.getByRole('button', { name: T('day.closeButton'), exact: true })).toBeVisible();
    const dayText = await header.locator('[data-state="open"]').innerText();

    await page.getByRole('navigation', { name: T('app.navigation') }).getByRole('button', { name: T('nav.staff'), exact: true }).click();
    await page.getByRole('button', { name: T('staff.add'), exact: true }).click();
    await page.getByLabel(T('staff.fullName'), { exact: true }).fill('Синтетик Кассир');
    await page.getByLabel(T('staff.login'), { exact: true }).fill('cashier.browser');
    await page.getByLabel(T('staff.phone')).fill('90 555-44-33');
    // Administrator cannot grant the CEO role; the box is disabled (the server also refuses it).
    await expect(page.getByRole('checkbox', { name: T('role.ceo'), exact: true })).toBeDisabled();
    await page.getByRole('checkbox', { name: T('role.cashier'), exact: true }).check();
    await page.getByRole('button', { name: T('staff.create'), exact: true }).click();
    const secret = page.getByTestId('temporary-password');
    await expect(secret).toBeVisible();
    const temporary = (await secret.innerText()).trim();
    expect(temporary).toMatch(/^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/);
    await expect(page.getByText('cashier.browser · +998905554433')).toBeVisible();
    await mkdir('work/browser-evidence', { recursive: true });
    await page.screenshot({ path: `work/browser-evidence/staff-created-${width}.png`, fullPage: true });
    await page.getByRole('button', { name: T('staff.tempDone'), exact: true }).click();
    await expect(secret).toHaveCount(0);

    await page.getByRole('button', { name: T('app.signOut'), exact: true }).click();
    await signIn(page, 'cashier.browser', temporary);
    await expect(page.getByRole('heading', { name: T('password.title') })).toBeVisible();
    const next = 'Cashier-' + randomUUID();
    await page.getByLabel(T('password.current'), { exact: true }).fill(temporary);
    await page.getByLabel(T('password.new'), { exact: true }).fill(next);
    await page.getByLabel(T('password.repeat'), { exact: true }).fill(next);
    await page.getByRole('button', { name: T('password.submit'), exact: true }).click();

    await expect(page.getByRole('heading', { name: T('home.cashier.title'), level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: T('cashier.title'), exact: true, level: 2 })).toBeVisible();
    await expect(header.locator('[data-state="open"]')).toHaveText(dayText);
    await expect(header.getByText('Синтетик Кассир', { exact: true })).toBeVisible();
    // A single-role cashier gets no section navigation, no staff screen and no day controls.
    await expect(page.getByRole('navigation', { name: T('app.navigation') })).toHaveCount(1);
    await expect(page.getByRole('button',{name:T('nav.staff'),exact:true})).toHaveCount(0);
    await expect(page.getByRole('button', { name: T('day.closeButton') })).toHaveCount(0);
    const status = await page.evaluate(async clinic => (await fetch(`/api/clinics/${clinic}/staff`)).status, f.owner.clinicId);
    expect(status).toBe(403);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await page.screenshot({ path: `work/browser-evidence/cashier-home-${width}.png`, fullPage: true });
  } finally { await f.close(); }
});
