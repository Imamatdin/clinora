import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { processFixture } from './process-fixture.js';
import { DICTIONARIES } from '../../src/web/i18n/index.js';

/*
 * Show/hide password on the sign-in and change-password forms. The input keeps the label as its accessible name,
 * the toggle is its own button with aria-pressed, and the field is masked again after the form is submitted.
 */
const T = DICTIONARIES['uz-Cyrl'];

test('password fields can be shown and hidden, at 390 and 1366 px', async ({ browser }) => {
  const f = await processFixture();
  try {
    await mkdir('work/browser-evidence/redesign', { recursive: true });
    for (const width of [390, 1366]) {
      const context = await browser.newContext({ viewport: { width, height: 844 } });
      const page = await context.newPage();
      await page.goto(f.origin);
      const password = page.getByLabel(T['auth.password'], { exact: true });
      const toggle = page.getByRole('button', { name: T['auth.showPassword'], exact: true });
      await page.getByLabel(T['auth.identifier'], { exact: true }).fill('owner@example.test');
      await password.fill(f.password);
      await expect(password).toHaveAttribute('type', 'password');
      await expect(toggle).toHaveAttribute('aria-pressed', 'false');
      await toggle.click();
      await expect(password).toHaveAttribute('type', 'text');
      await expect(password).toHaveValue(f.password);
      const hide = page.getByRole('button', { name: T['auth.hidePassword'], exact: true });
      await expect(hide).toHaveAttribute('aria-pressed', 'true');
      await page.screenshot({ path: `work/browser-evidence/redesign/sign-in-shown-${width}.png`, fullPage: true });
      // The toggle sits inside the field's box and does not cover the typed text.
      const [field, button] = await Promise.all([password.boundingBox(), hide.boundingBox()]);
      expect(button!.x + button!.width).toBeLessThanOrEqual(field!.x + field!.width + 0.5);
      expect(button!.height).toBeGreaterThanOrEqual(44);
      await hide.click();
      await expect(password).toHaveAttribute('type', 'password');
      // Shown at submit time: the request still signs in, and nothing is left visible.
      await page.getByRole('button', { name: T['auth.showPassword'], exact: true }).click();
      await page.getByRole('button', { name: T['auth.signIn'], exact: true }).click();
      await expect(page.locator('main.page')).toBeVisible();
      await context.close();
    }
    // The change-password form uses the same field for all three passwords.
    await f.pool.query("UPDATE accounts SET must_change_password=true WHERE id=$1", [f.owner.userId]);
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto(f.origin);
    await page.getByLabel(T['auth.identifier'], { exact: true }).fill('owner@example.test');
    await page.getByLabel(T['auth.password'], { exact: true }).fill(f.password);
    await page.getByRole('button', { name: T['auth.signIn'], exact: true }).click();
    await expect(page.getByRole('heading', { name: T['password.title'], exact: true })).toBeVisible();
    for (const key of ['password.current', 'password.new', 'password.repeat'] as const)
      await expect(page.getByLabel(T[key], { exact: true })).toHaveAttribute('type', 'password');
    await expect(page.getByRole('button', { name: T['auth.showPassword'], exact: true })).toHaveCount(3);
    await page.getByRole('button', { name: T['auth.showPassword'], exact: true }).nth(1).click();
    await expect(page.getByLabel(T['password.new'], { exact: true })).toHaveAttribute('type', 'text');
    await expect(page.getByLabel(T['password.current'], { exact: true })).toHaveAttribute('type', 'password');
    await context.close();
  } finally { await f.close(); }
});
