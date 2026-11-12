import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { processFixture, T } from './process-fixture.js';
import { seedRegistration, openDay, closeDay } from '../integration/registration-fixture.js';
import { passwordHash, digest, token } from '../../src/server/security.js';
import { createSession } from '../../src/server/access.js';

type F = Awaited<ReturnType<typeof processFixture>>;
async function enrolled(page: Page, f: F, userId: string) {
  const id = randomUUID(), raw = token();
  await f.pool.query("INSERT INTO devices(id,clinic_id,label,token_hash,created_by) VALUES($1,$2,'R1',$3,$4)", [id, f.owner.clinicId, digest(raw), f.owner.userId]);
  const session = await createSession(f.pool, userId, 'device', id);
  await page.context().addCookies([
    { name: 'clinora_device', value: raw, url: f.origin + '/api', httpOnly: true, sameSite: 'Strict' },
    { name: 'clinora_session', value: session, url: f.origin, httpOnly: true, sameSite: 'Strict' }
  ]);
  await page.addInitScript(() => { window.print = () => { document.documentElement.dataset.printed = 'yes'; }; });
  await page.goto(f.origin);
  await expect(page.getByRole('heading', { name: T('registration.title'), exact: true })).toBeVisible();
  await expect(page.locator('.registration-banner')).toHaveCount(0);
  return id;
}
async function registerOffline(page: Page, name: string) {
  await page.getByRole('button', { name: T('registration.new'), exact: true }).click();
  await page.getByLabel(T('registration.fullName'), { exact: true }).fill(name);
  await page.getByLabel(T('registration.birthDate'), { exact: true }).fill('1992-07-15');
  await page.getByLabel(T('registration.female'), { exact: true }).check();
  await page.getByRole('button', { name: T('registration.save'), exact: true }).click();
  await expect(page.getByRole('heading', { name: T('registration.whoSees'), exact: true })).toBeVisible();
  await page.locator('.registration-point', { hasText: 'Терапевт' }).getByRole('checkbox').check();
  await page.getByRole('button', { name: T('registration.print'), exact: true }).click();
  await expect(page.getByRole('heading', { name: T('registration.offline.saved'), exact: true })).toBeVisible();
  const code = await page.locator('.registration-done > p').first().textContent();
  expect(code).toMatch(/^R[A-F0-9]{8}-\d+$/);
  await expect(page.locator('.offline-print .number')).toHaveText(code!);
  await expect(page.locator('html')).toHaveAttribute('data-printed', 'yes');
  return code!;
}
async function stored(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('clinora-registration', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const state = await new Promise<any>((resolve, reject) => { const r = db.transaction('outbox').objectStore('outbox').get('state'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    db.close(); return state;
  });
}
const pending = (count: number) => T('registration.offline.pending', { count });

test('network offline: two patients route, print provisional tickets, sync once, and resolve a duplicate without dropping data', async ({ page }) => {
  const f = await processFixture();
  try {
    const g = await seedRegistration(f.pool, f.owner.clinicId, f.owner.userId, f.password, 'offline016');
    await openDay(f.pool, f.owner.clinicId, f.owner.userId);
    await enrolled(page, f, g.registrar);
    await page.setViewportSize({ width: 360, height: 800 });
    await page.context().setOffline(true);
    await expect(page.getByText(T('registration.offline.banner'), { exact: true })).toBeVisible();
    const first = await registerOffline(page, 'Синтетик Офлайн Бир');
    await page.getByRole('button', { name: T('registration.nextPatient'), exact: true }).click();
    const second = await registerOffline(page, 'Синтетик Офлайн Икки');
    expect(first).not.toBe(second);
    await expect(page.getByText(pending(2), { exact: true })).toBeVisible();
    expect((await stored(page)).entries).toHaveLength(2);
    expect((await f.pool.query('SELECT count(*)::int n FROM visits')).rows[0].n).toBe(0);
    await page.screenshot({ path: 'work/browser-evidence/offline-registration-360.png', fullPage: true });
    // Simulate one committed request whose response never reaches the browser.
    let loseResponse = true;
    await page.route('**/registration/offline', async route => {
      if (loseResponse) { loseResponse = false; await route.fetch(); await route.abort('failed'); }
      else await route.continue();
    });
    await page.context().setOffline(false);
    await expect.poll(async () => (await f.pool.query('SELECT count(*)::int n FROM visits')).rows[0].n).toBe(1);
    await page.getByRole('button', { name: T('registration.offline.sync'), exact: true }).click();
    await expect(page.getByText(pending(0), { exact: true })).toBeVisible();
    await expect(page.locator('.offline-synced > li')).toHaveCount(2);
    await expect(page.locator('.offline-synced')).toContainText(first);
    await expect(page.locator('.offline-synced')).toContainText(second);
    await expect(page.locator('.offline-synced')).toContainText('Терапевт: 1');
    await expect(page.locator('.offline-synced')).toContainText('Терапевт: 2');
    expect((await stored(page)).entries).toEqual([]);
    for (let i = 0; i < 2; i++) await page.getByRole('button', { name: T('registration.offline.sync'), exact: true }).click();
    expect((await f.pool.query('SELECT count(*)::int n FROM visits')).rows[0].n).toBe(2);
    expect((await f.pool.query('SELECT count(*)::int n FROM patients')).rows[0].n).toBe(2);

    await page.getByRole('button', { name: T('registration.nextPatient'), exact: true }).click();
    await page.context().setOffline(true);
    await registerOffline(page, 'Синтетик Офлайн Бир');
    await page.context().setOffline(false);
    await expect(page.getByRole('heading', { name: T('registration.offline.attention'), exact: true })).toBeVisible();
    expect((await stored(page)).entries).toHaveLength(1);
    await page.getByRole('button', { name: T('registration.offline.findDuplicate'), exact: true }).click();
    await page.getByRole('button', { name: new RegExp(T('registration.useExisting') + ':') }).click();
    await expect(page.getByText(pending(0), { exact: true })).toBeVisible();
    expect((await f.pool.query('SELECT count(*)::int n FROM patients')).rows[0].n).toBe(2);
    expect((await f.pool.query('SELECT count(*)::int n FROM visits')).rows[0].n).toBe(3);
  } finally { await f.close(); }
});

test('queued data survives reload, is removed on user switch, and revoked device clears unsynced records', async ({ page }) => {
  const f = await processFixture();
  try {
    const g = await seedRegistration(f.pool, f.owner.clinicId, f.owner.userId, f.password, 'privacy016');
    const day = await openDay(f.pool, f.owner.clinicId, f.owner.userId);
    await f.pool.query('INSERT INTO account_pins(account_id,pin_hash) VALUES($1,$2)', [g.registrar, await passwordHash('2580')]);
    // A second registrar on the same enrolled computer.
    await f.pool.query("INSERT INTO membership_roles(clinic_id,user_id,role,granted_by) VALUES($1,$2,'registrar',$3)", [f.owner.clinicId, g.doctorC, f.owner.userId]);
    await f.pool.query('INSERT INTO account_pins(account_id,pin_hash) VALUES($1,$2)', [g.doctorC, await passwordHash('1397')]);
    const deviceId = await enrolled(page, f, g.registrar);
    await page.context().setOffline(true);
    await registerOffline(page, 'Синтетик Приватний');
    await closeDay(f.pool, day, f.owner.userId);
    await page.context().setOffline(false);
    await expect(page.getByRole('heading', { name: T('registration.offline.attention'), exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText(pending(1), { exact: true })).toBeVisible();
    await page.getByRole('banner').getByRole('button', { name: T('access.device.switchUser'), exact: true }).click();
    await expect(page.getByRole('heading', { name: T('access.device.title'), exact: true })).toBeVisible();
    expect((await stored(page)).entries).toEqual([]);
    await page.getByRole('button', { name: 'Синтетик Невролог', exact: true }).click();
    await page.getByLabel(T('access.device.pin'), { exact: true }).fill('1397');
    await page.getByRole('button', { name: T('access.device.unlock'), exact: true }).click();
    await page.getByRole('navigation', { name: T('app.navigation') }).getByRole('button', { name: T('role.registrar'), exact: true }).click();
    await expect(page.getByText(pending(0), { exact: true })).toBeVisible();
    await expect(page.locator('.registration')).not.toContainText('Синтетик Приватний');
    await openDay(f.pool, f.owner.clinicId, f.owner.userId, 1);
    await page.reload();
    // Select registrar role after reload if doctor is the first available role.
    await page.getByRole('navigation', { name: T('app.navigation') }).getByRole('button', { name: T('role.registrar'), exact: true }).click();
    await page.context().setOffline(true);
    await registerOffline(page, 'Синтетик Бекор');
    await f.pool.query('UPDATE devices SET revoked_at=now(),revoked_by=$2 WHERE id=$1', [deviceId, f.owner.userId]);
    await page.context().setOffline(false);
    await expect.poll(async () => (await stored(page)).entries.length).toBe(0);
    expect((await f.pool.query('SELECT count(*)::int n FROM visits')).rows[0].n).toBe(0);
  } finally { await f.close(); }
});
