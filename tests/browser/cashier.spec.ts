import { test, expect } from "@playwright/test";
import { processFixture, T } from "./process-fixture.js";
import { seedCashier } from "../integration/cashier-fixture.js";
import { tab } from './ui.js';
test("cashier opens shift, partial cash and card, discount, refund, cash out, closes and prints", async ({
  page,
}) => {
  const f = await processFixture();
  try {
    const g = await seedCashier(f.pool, f.owner.clinicId, f.owner.userId);
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(f.origin);
    await page
      .getByLabel(T("auth.identifier"), { exact: true })
      .fill("owner@example.test");
    await page.getByLabel(T("auth.password"), { exact: true }).fill(f.password);
    await page
      .getByRole("button", { name: T("auth.signIn"), exact: true })
      .click();
    await tab(page,T('module.payments'));
    await expect(
      page.getByRole("heading", { name: T("cashier.title"), exact: true }),
    ).toBeVisible();
    await page.getByLabel(T("cashier.opening"), { exact: true }).fill("10000");
    await page
      .getByRole("button", { name: T("cashier.open"), exact: true })
      .click();
    await expect(
      page.getByLabel(T("cashier.shift"), { exact: true }),
    ).toBeVisible();
    const number = (
      await f.pool.query("SELECT patient_no FROM patients WHERE id=$1", [
        g.patient,
      ])
    ).rows[0].patient_no;
    await page
      .getByLabel(T("cashier.search"), { exact: true })
      .fill(String(number));
    await page
      .getByRole("button", { name: T("cashier.find"), exact: true })
      .click();
    await page.getByRole("button", { name: /Synthetic Aliyev/ }).click();
    await expect(
      page.getByRole("heading", { name: "Synthetic Aliyev", exact: true }),
    ).toBeVisible();
    const amount = page
      .getByLabel(T("cashier.amount"), { exact: true })
      .first();
    for (const method of ["cash", "card"]) {
      await amount.fill("200000");
      await page
        .getByLabel(T("cashier.method"), { exact: true })
        .selectOption(method);
      await page
        .getByRole("button", { name: T("cashier.take"), exact: true })
        .click();
      await page
        .getByRole("button", { name: T("cashier.yes"), exact: true })
        .click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
    }
    await page.getByText(T("cashier.more"), { exact: true }).click();
    await page
      .getByLabel(T("cashier.reason"), { exact: true })
      .fill("Synthetic approval");
    await amount.fill("100000");
    await page
      .getByRole("button", { name: T("cashier.apply"), exact: true })
      .click();
    await expect(page.locator("dd").last()).toContainText("500 000");
    await page
      .getByLabel(T("cashier.payment"), { exact: true })
      .selectOption({ index: 1 });
    await amount.fill("50000");
    page.on("dialog", (d) => d.accept());
    await page
      .getByRole("button", { name: T("cashier.refund"), exact: true })
      .click();
    await expect(page.locator("dd").last()).toContainText("550 000");
    await page.getByText(T("cashier.out"), { exact: true }).first().click();
    await page
      .getByLabel(T("cashier.amount"), { exact: true })
      .last()
      .fill("10000");
    await page
      .getByLabel(T("cashier.note"), { exact: true })
      .fill("Synthetic supply");
    await page
      .getByRole("button", { name: T("cashier.out"), exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText(T("cashier.saved"));
    await page.getByLabel(T("cashier.counted"), { exact: true }).fill("150000");
    await page
      .getByRole("button", { name: T("cashier.close"), exact: true })
      .click();
    await expect(page.locator(".cashier-print")).toContainText("150 000");
    await page.evaluate(() => {
      (window as any).__printed = false;
      window.print = () => {
        (window as any).__printed = true;
      };
    });
    await page
      .getByRole("button", { name: T("cashier.print"), exact: true })
      .click();
    expect(await page.evaluate(() => (window as any).__printed)).toBe(true);
    await page.reload();
    await tab(page,T('module.payments'));
    await expect(
      page.getByRole("button", { name: new RegExp(T("cashier.report")) }),
    ).toBeVisible();
  } finally {
    await f.close();
  }
});
