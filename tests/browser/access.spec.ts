import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { passwordHash } from '../../src/server/security.js';
import { signInitData } from '../../src/modules/telegram/init-data.js';
import { TEST_BOT } from '../integration/fixture.js';
import { processFixture, T } from './process-fixture.js';

type F = Awaited<ReturnType<typeof processFixture>>;
async function member(f: F, login: string, name: string, roles: string[], pin?: string) {
  const id = randomUUID(), password = 'Synthetic-' + randomUUID();
  await f.pool.query('INSERT INTO accounts(id,login,display_name,password_hash,managed_by_clinic_id) VALUES($1,$2,$3,$4,$5)', [id, login, name, await passwordHash(password), f.owner.clinicId]);
  await f.pool.query("INSERT INTO memberships(id,clinic_id,user_id,status,granted_by) VALUES($1,$2,$3,'active',$4)", [randomUUID(), f.owner.clinicId, id, f.owner.userId]);
  for (const role of roles) await f.pool.query('INSERT INTO membership_roles(clinic_id,user_id,role,granted_by) VALUES($1,$2,$3,$4)', [f.owner.clinicId, id, role, f.owner.userId]);
  if (pin) await f.pool.query('INSERT INTO account_pins(account_id,pin_hash) VALUES($1,$2)', [id, await passwordHash(pin)]);
  return { id, password };
}
async function pin(page: Page, name: string, value: string) {
  await page.getByRole('button', { name, exact: true }).click();
  await expect(page.getByRole('heading', { name: T('access.device.pinFor', { name }), level: 1 })).toBeVisible();
  for (const digit of value) await page.getByRole('button', { name: T('access.device.digit', { digit }), exact: true }).click();
  await page.getByRole('button', { name: T('access.device.unlock'), exact: true }).click();
}

// Acceptance: enrolled PC, two users switch by PIN, each action attributed to the right person.
test('enrolled clinic PC: two people switch by PIN and each action is attributed to them; no API data cached', async ({ page }) => {
  const f = await processFixture();
  try {
    const anna = await member(f, 'anna.admin', 'Анна Администратор', ['administrator'], '2580');
    const bek = await member(f, 'bek.admin', 'Бек Администратор', ['administrator'], '1397');
    page.on('dialog', dialog => void dialog.accept());
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(f.origin);
    await page.getByLabel(T('auth.identifier'), { exact: true }).fill('owner@example.test');
    await page.getByLabel(T('auth.password'), { exact: true }).fill(f.password);
    await page.getByRole('button', { name: T('auth.signIn'), exact: true }).click();
    await page.getByRole('navigation', { name: T('app.navigation') }).getByRole('button', { name: T('nav.staff'), exact: true }).click();
    await page.getByLabel(T('access.devices.label'), { exact: true }).fill('Регистратура 1');
    await page.getByRole('button', { name: T('access.devices.enroll'), exact: true }).click();

    // The manager is signed out; the PC now shows who may work here.
    await expect(page.getByRole('heading', { name: T('access.device.title'), level: 1 })).toBeVisible();
    await expect(page.getByText(T('access.device.computer', { label: 'Регистратура 1', clinic: 'Synthetic North Clinic' }))).toBeVisible();
    await mkdir('work/browser-evidence', { recursive: true });
    await page.screenshot({ path: 'work/browser-evidence/device-lock-screen.png', fullPage: true });

    await pin(page, 'Анна Администратор', '9999');
    await expect(page.getByRole('alert').filter({ hasText: T('access.device.wrongPin') })).toBeVisible();
    for (const digit of '2580') await page.getByRole('button', { name: T('access.device.digit', { digit }), exact: true }).click();
    await page.getByRole('button', { name: T('access.device.unlock'), exact: true }).click();
    await expect(page.getByRole('heading', { name: T('home.administrator.title'), level: 1 })).toBeVisible();
    const header = page.getByRole('banner');
    await expect(header.getByText('Анна Администратор', { exact: true })).toBeVisible();
    await expect(header.getByRole('button', { name: T('app.signOut') })).toHaveCount(0);
    await page.getByRole('button', { name: T('day.openButton'), exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: T('day.openedNotice') })).toBeVisible();

    await header.getByRole('button', { name: T('access.device.switchUser'), exact: true }).click();
    await expect(page.getByRole('heading', { name: T('access.device.title'), level: 1 })).toBeVisible();
    await pin(page, 'Бек Администратор', '1397');
    await expect(header.getByText('Бек Администратор', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: T('day.closeButton'), exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: T('day.closedNotice') })).toBeVisible();
    await page.screenshot({ path: 'work/browser-evidence/device-second-user.png', fullPage: true });

    const day = (await f.pool.query('SELECT opened_by, closed_by FROM business_days WHERE clinic_id=$1', [f.owner.clinicId])).rows[0];
    expect(day).toEqual({ opened_by: anna.id, closed_by: bek.id });
    const audit = (await f.pool.query("SELECT actor_id, action FROM audit_events WHERE action LIKE 'business_day.%' ORDER BY created_at")).rows;
    expect(audit).toEqual([{ actor_id: anna.id, action: 'business_day.opened' }, { actor_id: bek.id, action: 'business_day.closed' }]);

    // Installed-app cache: after a reload under service-worker control and more API traffic, only the shell is cached.
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    await page.reload();
    await expect(page.getByRole('heading', { name: T('home.administrator.title'), level: 1 })).toBeVisible();
    expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
    await page.evaluate(() => fetch('/api/auth/me').then(r => r.status));
    const cached = await page.evaluate(async () => {
      const urls: string[] = [];
      for (const name of await caches.keys()) for (const req of await (await caches.open(name)).keys()) urls.push(new URL(req.url).pathname);
      return urls;
    });
    expect(cached).toContain('/');
    expect(cached.filter(u => u.startsWith('/api'))).toEqual([]);
  } finally { await f.close(); }
});

// Telegram Mini App in a browser: our bridge reads Telegram's launch hash, the server validates the signed data.
test('Mini App: linked staff sign in with Telegram theme and back button; unlinked users see "ask your administrator"', async ({ browser }) => {
  const f = await processFixture({ TELEGRAM_BOT_TOKEN: TEST_BOT.botToken, TELEGRAM_WEBHOOK_SECRET: TEST_BOT.webhookSecret, TELEGRAM_BOT_USERNAME: TEST_BOT.botUsername });
  try {
    const admin = await member(f, 'access.tg.admin', 'Телеграм Администратор', ['administrator']);
    await f.pool.query('INSERT INTO telegram_links(account_id,telegram_user_id,clinic_id) VALUES($1,$2,$3)', [admin.id, 424242, f.owner.clinicId]);
    await member(f, 'new.doctor', 'Янги Шифокор', ['doctor']);
    const launch = (tg: number) => '/#' + new URLSearchParams({
      tgWebAppData: signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'AAH' + randomUUID().slice(0, 8), user: JSON.stringify({ id: tg, first_name: 'Синтетик', language_code: 'uz' }) }, TEST_BOT.botToken),
      tgWebAppVersion: '8.0', tgWebAppPlatform: 'android',
      tgWebAppThemeParams: JSON.stringify({ bg_color: '#17212b', secondary_bg_color: '#0e1621', text_color: '#f5f5f5', hint_color: '#708499', button_color: '#5288c1', button_text_color: '#ffffff', link_color: '#6ab3f3' })
    }).toString();

    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    // Stand-in for the Telegram app's native bridge: records the events our page posts.
    await page.addInitScript(() => { const w = window as unknown as { events: unknown[]; TelegramWebviewProxy: unknown };
      w.events = []; w.TelegramWebviewProxy = { postEvent: (type: string, data: string) => w.events.push([type, JSON.parse(data)]) }; });
    await page.goto(f.origin + launch(424242));
    await expect(page.getByRole('heading', { name: T('home.administrator.title'), level: 1 })).toBeVisible();
    expect(await page.evaluate(() => location.hash)).toBe('');
    expect(await page.evaluate(() => document.documentElement.classList.contains('tg'))).toBe(true);
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.topbar')!).backgroundColor)).toBe('rgb(23, 33, 43)');
    await expect(page.getByRole('button', { name: T('app.signOut') })).toHaveCount(0);
    const events = async () => page.evaluate(() => (window as unknown as { events: [string, Record<string, unknown>][] }).events);
    expect((await events()).map(e => e[0])).toEqual(expect.arrayContaining(['web_app_ready', 'web_app_expand']));
    // Back button: shown on a secondary screen, and pressing it returns to the main screen.
    await page.getByRole('navigation', { name: T('app.navigation') }).getByRole('button', { name: T('nav.staff'), exact: true }).click();
    await expect(page.getByRole('heading', { name: T('staff.title'), level: 1 })).toBeVisible();
    // The administrator invites a colleague to Telegram: single-use link and QR code.
    const row = page.getByRole('listitem').filter({ hasText: 'Янги Шифокор' });
    await row.getByRole('button', { name: T('staff.manage'), exact: true }).click();
    await row.getByRole('button', { name: T('access.invite'), exact: true }).click();
    await expect(page.getByTestId('invite-link')).toHaveText(/^https:\/\/t\.me\/clinora_test_bot\?start=[A-Za-z0-9_-]{43}$/);
    await expect(page.getByRole('img', { name: T('access.qr') })).toBeVisible();
    await mkdir('work/browser-evidence', { recursive: true });
    await page.screenshot({ path: 'work/browser-evidence/mini-app-invite-390.png', fullPage: true });
    await page.getByRole('button', { name: T('staff.tempDone'), exact: true }).click();
    await expect(row.getByText(T('access.pending'), { exact: true })).toBeVisible();
    expect((await events()).filter(e => e[0] === 'web_app_setup_back_button').at(-1)?.[1]).toEqual({ is_visible: true });
    await page.evaluate(() => (window as unknown as { Telegram: { WebView: { receiveEvent(t: string, d: unknown): void } } }).Telegram.WebView.receiveEvent('back_button_pressed', null));
    await expect(page.getByRole('heading', { name: T('home.administrator.title'), level: 1 })).toBeVisible();
    expect((await events()).filter(e => e[0] === 'web_app_setup_back_button').at(-1)?.[1]).toEqual({ is_visible: false });
    await mkdir('work/browser-evidence', { recursive: true });
    await page.screenshot({ path: 'work/browser-evidence/mini-app-home-390.png', fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    // A reload keeps the server session (cookie), without reusing the single-use launch data.
    await page.reload();
    await expect(page.getByRole('heading', { name: T('home.administrator.title'), level: 1 })).toBeVisible();

    const stranger = await context.browser()!.newContext({ viewport: { width: 390, height: 844 } });
    const strangerPage = await stranger.newPage();
    await strangerPage.goto(f.origin + launch(999001));
    await expect(strangerPage.getByRole('heading', { name: T('access.tg.blockedTitle'), level: 1 })).toBeVisible();
    await expect(strangerPage.getByLabel(T('auth.password'))).toHaveCount(0);
    await strangerPage.screenshot({ path: 'work/browser-evidence/mini-app-ask-admin-390.png', fullPage: true });
    await stranger.close(); await context.close();
  } finally { await f.close(); }
});

test('password lock shows unlock time and the staff manager can unlock it', async ({ page }) => {
  const f = await processFixture();
  try {
    const staff = await member(f, 'login.locked', 'Синтетик Қулф', ['doctor']);
    for (let i = 0; i < 10; i++) await page.request.post(f.origin + '/api/auth/login', {
      headers: { Origin: f.origin }, data: { identifier: 'login.locked', password: 'wrong' }
    });
    await page.goto(f.origin);
    await page.getByLabel(T('auth.identifier'), { exact: true }).fill('login.locked');
    await page.getByLabel(T('auth.password'), { exact: true }).fill(staff.password);
    await page.getByRole('button', { name: T('auth.signIn'), exact: true }).click();
    const locked = (await f.pool.query('SELECT locked_until FROM password_login_limits WHERE locked_until IS NOT NULL')).rows[0].locked_until as Date;
    const time = locked.toLocaleTimeString('uz-Cyrl', { hour: '2-digit', minute: '2-digit', hour12: false });
    await expect(page.getByRole('alert')).toHaveText(T('access.loginLockedUntil', { time }));
    await page.getByLabel(T('auth.identifier'), { exact: true }).fill('owner@example.test');
    await page.getByLabel(T('auth.password'), { exact: true }).fill(f.password);
    await page.getByRole('button', { name: T('auth.signIn'), exact: true }).click();
    await page.getByRole('navigation', { name: T('app.navigation') }).getByRole('button', { name: T('nav.staff'), exact: true }).click();
    const row = page.locator('.staff-list > li').filter({ hasText: 'Синтетик Қулф' });
    await row.getByRole('button', { name: T('staff.manage'), exact: true }).click();
    await row.getByRole('button', { name: T('access.unlockLogin'), exact: true }).click();
    await expect(row.getByRole('status')).toHaveText(T('access.loginUnlocked'));
    expect((await f.pool.query("SELECT actor_id FROM audit_events WHERE action='login.unlocked' AND resource_id=$1", [staff.id])).rows[0].actor_id).toBe(f.owner.userId);
    const response = await page.request.post(f.origin + '/api/auth/login', { headers: { Origin: f.origin }, data: { identifier: 'login.locked', password: staff.password } });
    expect(response.status()).toBe(200);
  } finally { await f.close(); }
});
