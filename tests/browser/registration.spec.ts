import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { processFixture, T } from './process-fixture.js';
import { seedRegistration, openDay } from '../integration/registration-fixture.js';

test('registrar registers a new patient, routes to two doctors and lab, prints three tickets; finds a returning patient by last 4 phone digits', async ({ page }) => {
  const f = await processFixture();
  try {
    const c = f.owner.clinicId;
    const g = await seedRegistration(f.pool, c, f.owner.userId, f.password, 'b007');
    await openDay(f.pool, c, f.owner.userId);
    const returning = randomUUID();
    await f.pool.query("INSERT INTO patients(id,clinic_id,display_name,full_name,birth_date,gender,phone,provenance) VALUES($1,$2,'Синтетик Қайтган','Синтетик Қайтган','1970-03-04','male','+998935557788','{\"source\":\"synthetic\"}')", [returning, c]);
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto(f.origin);
    await page.getByLabel(T('auth.identifier'), { exact: true }).fill(g.email('registrar'));
    await page.getByLabel(T('auth.password'), { exact: true }).fill(f.password);
    await page.getByRole('button', { name: T('auth.signIn'), exact: true }).click();
    await expect(page.getByRole('heading', { name: T('module.registration'), exact: true })).toBeVisible();
    const started = Date.now();

    // New patient: typed name, picked date, gender, phone from the on-screen number pad, district and source from lists.
    await page.getByRole('button', { name: T('registration.new'), exact: true }).click();
    await page.getByLabel(T('registration.fullName'), { exact: true }).fill('Синтетик Янги Бемор');
    await page.getByLabel(T('registration.birthDate'), { exact: true }).fill('1992-07-15');
    await page.getByLabel(T('registration.female'), { exact: true }).check();
    for (const digit of '901112233') await page.getByRole('group', { name: T('registration.keypad') }).getByRole('button', { name: digit, exact: true }).click();
    await expect(page.getByLabel(T('registration.phone'), { exact: true })).toHaveValue('901112233');
    await page.getByLabel(T('registration.district'), { exact: true }).selectOption({ label: 'Юнусобод тумани' });
    await page.getByLabel(T('registration.mahalla'), { exact: true }).selectOption({ label: 'Минор маҳалласи' });
    await page.getByLabel(T('registration.source'), { exact: true }).selectOption({ label: T('registration.source.referral') });
    await page.getByRole('button', { name: T('registration.save'), exact: true }).click();

    // Who does the patient see? Two doctors (first consultation preselected) and the laboratory with two tests.
    await expect(page.getByRole('heading', { name: T('registration.whoSees'), exact: true })).toBeVisible();
    await page.locator('.registration-point', { hasText: 'Терапевт' }).getByRole('checkbox').check();
    await page.locator('.registration-point', { hasText: 'Кардиолог' }).getByRole('checkbox').check();
    await page.locator('.registration-point', { hasText: 'Лаборатория' }).getByRole('checkbox').check();
    await page.locator('.registration-services label', { hasText: 'Умумий қон таҳлили' }).getByRole('checkbox').check();
    await page.locator('.registration-services label', { hasText: 'Умумий сийдик таҳлили' }).getByRole('checkbox').check();
    await expect(page.getByText(T('registration.total', { amount: '325 000 сўм' }), { exact: true })).toBeVisible();
    const popupPromise = page.waitForEvent('popup');
    await page.getByRole('button', { name: T('registration.print'), exact: true }).click();
    const popup = await popupPromise;
    await popup.waitForURL(/\/registration\/visits\/[0-9a-f-]{36}\/tickets$/);
    await expect(popup.locator('article.ticket')).toHaveCount(3);
    await expect(popup.locator('article.ticket .number')).toHaveText(['1', '1', '1']);
    await expect(popup.locator('body')).not.toContainText('Синтетик Янги Бемор');
    await popup.close();
    await expect(page.getByRole('heading', { name: T('registration.done'), exact: true })).toBeVisible();
    await expect(page.locator('.registration-tickets li')).toHaveCount(3);
    const elapsed = Date.now() - started;

    const created = (await f.pool.query("SELECT id,full_name,display_name,phone,source,district_id,mahalla_id FROM patients WHERE clinic_id=$1 AND full_name='Синтетик Янги Бемор'", [c])).rows;
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ display_name: 'Синтетик Янги Бемор', phone: '+998901112233', source: 'referral', district_id: g.district, mahalla_id: g.mahalla });
    const tickets = (await f.pool.query('SELECT t.queue_point_id FROM queue_tickets t JOIN visits v ON v.id=t.visit_id WHERE v.patient_id=$1', [created[0].id])).rows;
    expect(tickets.map(t => t.queue_point_id).sort()).toEqual([g.pointA, g.pointB, g.pointLab].sort());
    const assigned = (await f.pool.query('SELECT user_id FROM patient_assignments WHERE patient_id=$1', [created[0].id])).rows.map(r => r.user_id).sort();
    expect(assigned).toEqual([g.doctorA, g.doctorB].sort());
    const lines = (await f.pool.query("SELECT sum(unit_price_uzs)::text total, count(*)::int n FROM charge_lines l JOIN visits v ON v.id=l.visit_id WHERE v.patient_id=$1 AND l.status='ordered'", [created[0].id])).rows[0];
    expect(lines).toEqual({ total: '325000', n: 4 });
    // Automation completes the form far faster than a person; this only guards against a pathological flow.
    expect(elapsed).toBeLessThan(60000);

    // Returning patient: found by the last four digits of the phone and routed without registering again.
    await page.getByRole('button', { name: T('registration.nextPatient'), exact: true }).click();
    await page.getByLabel(T('registration.search'), { exact: true }).fill('7788');
    await page.getByRole('button', { name: T('registration.find'), exact: true }).click();
    await page.getByRole('button', { name: /Синтетик Қайтган/ }).click();
    await expect(page.locator('.registration-card.selected')).toContainText('Синтетик Қайтган');
    await expect(page.locator('.registration-point', { hasText: 'Терапевт' })).toContainText(T('registration.waiting', { count: 1 }));
    await page.screenshot({ path: 'work/browser-evidence/registration-360.png', fullPage: true });
  } finally { await f.close(); }
});
