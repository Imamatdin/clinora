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
    await expect(page.getByRole("heading", { name: T("cashier.shiftClosed"), exact: true })).toBeVisible();
    await page.getByLabel(T("cashier.opening"), { exact: true }).fill("10000");
    await page.getByRole("button", { name: T("cashier.open"), exact: true }).click();
    const number = (await f.pool.query("SELECT patient_no FROM patients WHERE id=$1", [g.patient])).rows[0].patient_no;
    await page.getByLabel(T("cashier.search"), { exact: true }).fill(String(number));
    await page.getByRole("button", { name: T("cashier.find"), exact: true }).click();
    await page.getByRole("button", { name: /Synthetic Aliyev/ }).click();
    await expect(page.getByRole("heading", { name: "Synthetic Aliyev", exact: true })).toBeVisible();
    const amount = page.getByLabel(T("cashier.amount"), { exact: true });
    // Task 028: the amount is pre-filled with the whole sum due, so the usual payment needs no typing.
    await expect(amount).toHaveValue("1 000 000");
    for (const method of ["cash", "card"] as const) {
      await amount.fill("200000");
      await page.getByRole("group", { name: T("cashier.method"), exact: true }).getByRole("button", { name: T(`cashier.${method}`), exact: true }).click();
      if (method === "cash") {
        // The cashier types what the patient handed over and reads the change to give back.
        await page.getByLabel(T("cashier.given"), { exact: true }).fill("250000");
        await expect(page.locator(".cashier-change")).toContainText("50 000");
      }
      await page.getByRole("button", { name: T("cashier.take"), exact: true }).click();
      await page.getByRole("button", { name: T("cashier.yes"), exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
    }
    const due = page.getByTestId("cashier-due");
    await expect(due).toContainText("600 000");
    // Discount and refund sit one tap deeper, in a sheet; each has its own amount and reason.
    await page.getByRole("button", { name: T("cashier.more"), exact: true }).click();
    const sheet = page.getByRole("dialog");
    await sheet.locator("summary", { hasText: T("cashier.discount") }).click();
    await sheet.getByLabel(T("cashier.discountAmount"), { exact: true }).fill("100000");
    await sheet.getByLabel(T("cashier.reason"), { exact: true }).fill("Synthetic approval");
    await sheet.getByRole("button", { name: T("cashier.apply"), exact: true }).click();
    await expect(due).toContainText("500 000");
    await expect(sheet).toHaveCount(0); // the sheet closes itself once the action is recorded
    await page.getByRole("button", { name: T("cashier.more"), exact: true }).click();
    await sheet.locator("summary", { hasText: T("cashier.refund") }).click();
    await sheet.getByLabel(T("cashier.payment"), { exact: true }).selectOption({ index: 1 });
    await sheet.getByLabel(T("cashier.refundAmount"), { exact: true }).fill("50000");
    await sheet.getByLabel(T("cashier.refundReason"), { exact: true }).fill("Synthetic approval");
    page.on("dialog", (d) => d.accept());
    await sheet.getByRole("button", { name: T("cashier.refund"), exact: true }).click();
    await expect(due).toContainText("550 000");
    await expect(sheet).toHaveCount(0);
    // Cash-out and closing the shift live behind the shift line on the search screen.
    await page.getByRole("button", { name: T("cashier.back"), exact: true }).click();
    await page.locator(".cashier-shift").click();
    await sheet.locator("summary", { hasText: T("cashier.out") }).click();
    await sheet.getByLabel(T("cashier.outAmount"), { exact: true }).fill("10000");
    await sheet.getByLabel(T("cashier.note"), { exact: true }).fill("Synthetic supply");
    await sheet.getByRole("button", { name: T("cashier.outSubmit"), exact: true }).click();
    await expect(sheet.getByRole("status")).toContainText(T("cashier.saved"));
    await sheet.getByLabel(T("cashier.counted"), { exact: true }).fill("150000");
    await sheet.getByRole("button", { name: T("cashier.close"), exact: true }).click();
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
