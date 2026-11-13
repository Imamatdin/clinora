import { expect, type Page } from '@playwright/test';

/*
 * Task 025 phone layout helpers. Below 900 px the header's name, language, PIN and Telegram, sign out and
 * "switch user" sit behind one menu button, and navigation tabs that do not fit sit behind "More".
 */

/** Click a navigation tab by its label, opening a "More" menu first when the tab is not in the row. */
export async function tab(page: Page, name: string) {
  const button = page.getByRole('navigation').getByRole('button', { name, exact: true }).first();
  await expect(page.locator('nav.sections').first()).toBeVisible(); // the signed-in shell has rendered
  if (!await button.isVisible()) {
    for (const more of await page.locator('nav.sections > .tabs-more > button').all()) {
      if (await more.getAttribute('aria-expanded') !== 'true') await more.click();
      if (await button.isVisible()) break;
      await page.keyboard.press('Escape'); // not in this menu; close it so it does not cover the next row
    }
  }
  await button.click();
}

/** Open the phone header menu (no-op from 900 px, where the header shows everything). */
export async function openHeaderMenu(page: Page) {
  const toggle = page.locator('.header-menu-toggle');
  if (await toggle.isVisible() && await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
}

/** Click a header button (sign out, switch user, PIN and Telegram), through the menu on phones. */
export async function headerButton(page: Page, name: string) {
  await openHeaderMenu(page);
  await page.getByRole('banner').getByRole('button', { name, exact: true }).click();
}

/** Assert a header button is shown (inside the menu on phones), then close the menu again. */
export async function expectHeaderButton(page: Page, name: string) {
  await openHeaderMenu(page);
  await expect(page.getByRole('banner').getByRole('button', { name, exact: true })).toBeVisible();
  const toggle = page.locator('.header-menu-toggle');
  if (await toggle.isVisible()) await toggle.click();
}
