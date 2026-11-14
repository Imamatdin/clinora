import { expect, type Page } from '@playwright/test';

/*
 * Task 028 shell helpers. Navigation is one flat list: a left rail from 900 px, a bottom bar on phones (up to
 * five places; with more, the fifth is "More" and opens the rest as a sheet). The header holds only the clinic,
 * the business day and the person; language, PIN, Telegram, install and sign out live on the Settings screen.
 */

const shell = (page: Page) => page.locator('nav.rail, nav.bottombar').first();

/** Open a place by its navigation id (module id, 'staff' or 'settings'), through the "More" sheet on phones when needed. */
export async function go(page: Page, id: string) {
  await expect(shell(page)).toBeAttached();
  const direct = page.locator(`nav.rail [data-nav="${id}"], nav.bottombar [data-nav="${id}"]`).locator('visible=true').first();
  if (!await direct.count()) await page.locator('.more-toggle').click();
  await page.locator(`[data-nav="${id}"]`).locator('visible=true').first().click();
}

/**
 * Open a place by its label. A role name is not a place any more (every screen a person's roles allow is in the
 * one list), so a label with no matching place is skipped when `optional` is set.
 */
export async function tab(page: Page, name: string, optional = false) {
  await expect(shell(page)).toBeAttached();
  const button = page.getByRole('navigation').getByRole('button', { name, exact: true }).locator('visible=true').first();
  if (await button.count()) { await button.click(); return; }
  const more = page.locator('.more-toggle');
  if (await more.isVisible()) {
    await more.click();
    const item = page.getByRole('dialog').getByRole('button', { name, exact: true });
    if (await item.count()) { await item.click(); return; }
    await page.keyboard.press('Escape');
  }
  if (!optional) await button.click(); // fails with the locator in the message
}

export const openSettings = (page: Page) => go(page, 'settings');

/** Click an account button: "switch user" sits in the header on shared PCs; sign out and the rest are in Settings. */
export async function headerButton(page: Page, name: string) {
  const inHeader = page.getByRole('banner').getByRole('button', { name, exact: true });
  if (await inHeader.isVisible()) { await inHeader.click(); return; }
  await openSettings(page);
  await page.getByRole('main').getByRole('button', { name, exact: true }).click();
}

/** Assert an account button exists (header or Settings). Leaves the person on the screen they were on. */
export async function expectHeaderButton(page: Page, name: string) {
  const inHeader = page.getByRole('banner').getByRole('button', { name, exact: true });
  if (await inHeader.isVisible()) return;
  const current = await page.locator('[aria-current="page"][data-nav]').locator('visible=true').first().getAttribute('data-nav').catch(() => null);
  await openSettings(page);
  await expect(page.getByRole('main').getByRole('button', { name, exact: true })).toBeVisible();
  if (current && current !== 'settings') await go(page, current);
}

/** Choose the interface language on the Settings screen by the language's own name (LOCALE_LABELS). */
export async function setLanguage(page: Page, label: string, back?: string) {
  await openSettings(page);
  await page.locator('.lang-switch').getByRole('button', { name: label, exact: true }).click();
  if (back) await go(page, back);
}

/** Open the business-day sheet (CEO and administrator): the day status in the header is its button. */
export async function openDaySheet(page: Page) {
  await page.locator('.day-toggle').click();
  await expect(page.getByRole('dialog')).toBeVisible();
}
