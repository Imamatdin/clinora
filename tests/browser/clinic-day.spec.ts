import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { processFixture, T } from './process-fixture.js';
import { passwordHash } from '../../src/server/security.js';
import { transaction } from '../../src/server/database.js';
import { seedDemoStaff } from '../../src/server/demo-staff.js';
import { seedDemoCatalog } from '../../src/server/demo-catalog.js';
import { assistant } from '../../src/web/i18n/assistant.uz-Cyrl.js';
import { expectHeaderButton, headerButton, tab } from './ui.js';

/*
 * Task 017 acceptance: one synthetic clinic day, every role through the real browser and the compiled server.
 * Administrator opens the day; registrar registers and routes an outpatient and a patient who is admitted; the
 * doctor calls, writes and approves a note with a prescription and a lab order (assistant unavailable, manual
 * fallback); lab enters results; pharmacy dispenses; surgery is recorded; inpatient daily charges run; the
 * cashier takes partial and full payments with an approved discount and a refund; the inpatient is discharged;
 * the cashier closes the shift; the administrator closes the day; the CEO's totals match the money taken and
 * the doctor sees their own earnings. All people and data are synthetic.
 */
const EVIDENCE = 'work/browser-evidence/clinic-day';
const PIN = '482613'; // Task 022: approver PINs have 6 digits.
const digits = (text: string) => text.replace(/\D/g, '');

test.use({ actionTimeout: 15000 });
for (const width of [1280, 360]) test(`one synthetic clinic day end to end at ${width}px`, async ({ page }) => {
  test.setTimeout(240000);
  // The doctor works without the AI provider: the assistant shows as unavailable and the note is written by hand.
  const f = await processFixture({ ASSISTANT_SIMULATION: 'false' });
  try {
    const c = f.owner.clinicId, ceo = f.owner.userId;
    const hash = await passwordHash(f.password);
    const staff = await transaction(f.pool, async tx => {
      const s = await seedDemoStaff(tx, c, ceo, hash, 'day');
      await seedDemoCatalog(tx, c, ceo, s.doctorIds);
      // The administrator approves discounts and refunds with a PIN (set by the person on a clinic computer).
      await tx.query('INSERT INTO account_pins(account_id,pin_hash,pin_digits) VALUES($1,$2,6)', [s.ids.administrator, await passwordHash(PIN)]);
      return s;
    });
    const serviceId = async (code: string) => (await f.pool.query('SELECT id FROM services WHERE clinic_id=$1 AND code_1c=$2', [c, code])).rows[0].id as string;
    await mkdir(EVIDENCE, { recursive: true });
    const shot = (name: string) => page.screenshot({ path: `${EVIDENCE}/${name}-${width}.png`, fullPage: true });
    // Cheat-sheet pictures (/help/<role>): the phone view of each role's main step, Uzbek Cyrillic.
    await mkdir('work/browser-evidence/help', { recursive: true });
    const helpShot = async (role: string) => { if (width === 360) await page.screenshot({ path: `work/browser-evidence/help/${role}.png` }); };
    const noSideScroll = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
    page.on('dialog', d => void d.accept());
    await page.setViewportSize({ width, height: 900 });
    const signIn = async (login: string) => {
      await page.goto(f.origin);
      await page.getByLabel(T('auth.identifier'), { exact: true }).fill(login);
      await page.getByLabel(T('auth.password'), { exact: true }).fill(f.password);
      await page.getByRole('button', { name: T('auth.signIn'), exact: true }).click();
      await expectHeaderButton(page, T('app.signOut'));
    };
    const signOut = async () => { await headerButton(page, T('app.signOut')); await expect(page.getByLabel(T('auth.identifier'), { exact: true })).toBeVisible(); };

    // 1. Administrator opens the day.
    await signIn('day.admin');
    await expect(page.getByRole('heading', { name: T('home.administrator.title'), level: 1 })).toBeVisible();
    await page.getByRole('button', { name: T('day.openButton'), exact: true }).click();
    await expect(page.getByRole('banner').locator('[data-state="open"]')).toBeVisible();
    await noSideScroll(); await shot('01-admin-opens-day'); await helpShot('administrator');
    await signOut();

    // 2. Registrar registers two new patients: an outpatient (therapist + laboratory) and one who will be admitted (surgeon).
    await signIn('day.registrar');
    const register = async (name: string, birth: string, phone: string, route: (string | [string, string])[], admit = false) => {
      await page.getByRole('button', { name: T('registration.new'), exact: true }).click();
      await page.getByLabel(T('registration.fullName'), { exact: true }).fill(name);
      await page.getByLabel(T('registration.birthDate'), { exact: true }).fill(birth);
      await page.getByLabel(T('registration.male'), { exact: true }).check();
      for (const d of phone) await page.getByRole('group', { name: T('registration.keypad') }).getByRole('button', { name: d, exact: true }).click();
      await page.getByLabel(T('registration.source'), { exact: true }).selectOption({ label: T('registration.source.referral') });
      await page.getByRole('button', { name: T('registration.save'), exact: true }).click();
      await expect(page.getByRole('heading', { name: T('registration.whoSees'), exact: true })).toBeVisible();
      for (const r of route) {
        const [point, service] = typeof r === 'string' ? [r, null] : r;
        await page.locator('.registration-point', { hasText: point }).getByRole('checkbox').first().check();
        if (service) await page.locator('.registration-services label', { hasText: service }).getByRole('checkbox').check();
      }
      if (admit) await page.getByLabel(T('registration.admit'), { exact: true }).check();
      else await helpShot('registrar');
      const popup = page.waitForEvent('popup');
      await page.getByRole('button', { name: T('registration.print'), exact: true }).click();
      await (await popup).close();
      await expect(page.getByRole('heading', { name: T('registration.done'), exact: true })).toBeVisible();
      await noSideScroll();
    };
    await register('Синтетик Амбулатор Бемор', '1985-02-11', '901110001', ['Терапевт', ['Лаборатория', 'Умумий қон таҳлили']]);
    await shot('02-registrar-routed');
    await page.getByRole('button', { name: T('registration.nextPatient'), exact: true }).click();
    await register('Синтетик Стационар Бемор', '1970-09-30', '901110002', ['Жарроҳ'], true);
    await signOut();
    const visitOf = async (name: string) => (await f.pool.query('SELECT v.id, p.patient_no FROM visits v JOIN patients p ON p.id=v.patient_id WHERE p.clinic_id=$1 AND p.full_name=$2', [c, name])).rows[0] as { id: string; patient_no: number };
    const outpatient = await visitOf('Синтетик Амбулатор Бемор'), admitted = await visitOf('Синтетик Стационар Бемор');

    // 3. Doctor (therapist): call, write and approve a note with a prescription, order a lab test; assistant unavailable.
    await signIn('day.doctor');
    const dr = page.locator('section.dr');
    await expect(dr.getByRole('heading', { name: T('doctor.title'), exact: true })).toBeVisible();
    await dr.getByRole('button', { name: T('doctor.callNext'), exact: true }).click();
    await dr.getByRole('button', { name: T('doctor.start'), exact: true }).click();
    await expect(page.locator('.assistant').getByText(assistant['assistant.unavailableBanner'])).toBeVisible();
    await dr.getByLabel(T('doctor.field.reported'), { exact: true }).fill('Синтетик: 2 кундан бери бош оғриғи');
    await dr.getByLabel(T('doctor.field.assessment'), { exact: true }).fill('R51 Бош оғриғи (синтетик)');
    await dr.getByRole('button', { name: T('doctor.rx.add'), exact: true }).click();
    await dr.getByLabel(T('doctor.rx.medicine'), { exact: true }).fill('Парацетамол 500 мг');
    await dr.getByLabel(T('doctor.rx.dose'), { exact: true }).fill('1 таблетка');
    await dr.getByLabel(T('doctor.rx.frequency'), { exact: true }).fill('кунига 2 марта');
    await dr.getByLabel(T('doctor.rx.duration'), { exact: true }).fill('3 кун');
    await helpShot('doctor');
    await dr.getByRole('button', { name: T('doctor.save'), exact: true }).click();
    await expect(dr.getByRole('status').filter({ hasText: T('doctor.saved', { revision: 1 }) }).first()).toBeVisible();
    await dr.getByRole('button', { name: T('doctor.approve'), exact: true }).click();
    await expect(dr.getByText(T('doctor.approvedTag', { revision: 2 }), { exact: true })).toBeVisible();
    await dr.getByLabel(T('doctor.service'), { exact: true }).selectOption({ value: await serviceId('L03') });
    await dr.getByRole('button', { name: T('doctor.order'), exact: true }).click();
    await expect(dr.getByRole('status').filter({ hasText: T('doctor.ordered') })).toBeVisible();
    await dr.getByRole('button', { name: T('doctor.complete'), exact: true }).click();
    await expect(dr.getByRole('status').filter({ hasText: T('doctor.completed') })).toBeVisible();
    await noSideScroll(); await shot('03-doctor-visit');
    await signOut();

    // 4. Laboratory: both tests (registrar's blood count, doctor's glucose) get a result and are confirmed.
    await signIn('day.lab');
    // Newest first: the doctor's glucose order, then the registrar's blood count.
    for (const [param, value, unit] of [['Глюкоза', '5.2', 'ммоль/л'], ['Гемоглобин', '131', 'г/л']]) {
      await expect(dr.getByRole('heading', { name: T('lab.title'), exact: true })).toBeVisible();
      await dr.getByRole('button', { name: T('lab.open'), exact: true }).first().click();
      await dr.getByLabel(T('lab.param'), { exact: true }).fill(param!);
      await dr.getByLabel(T('lab.value'), { exact: true }).fill(value!);
      await dr.getByLabel(T('lab.unit'), { exact: true }).fill(unit!);
      if (param === 'Глюкоза') await helpShot('laboratory');
      await dr.getByRole('button', { name: T('lab.save'), exact: true }).click();
      await expect(dr.getByRole('status').filter({ hasText: T('lab.saved', { version: 1 }) })).toBeVisible();
      await dr.getByRole('button', { name: T('lab.confirm'), exact: true }).click();
      await expect(dr.getByRole('status').filter({ hasText: T('lab.confirmed') })).toBeVisible();
      await dr.getByRole('button', { name: T('lab.back'), exact: true }).click();
    }
    await noSideScroll(); await shot('04-lab-confirmed');
    await signOut();

    // 5. Pharmacy dispenses the prescribed medicine to the outpatient's visit.
    await signIn('day.pharmacy');
    const ph = page.locator('section').filter({ has: page.getByRole('heading', { name: T('pharmacy.title'), exact: true }) }).last();
    await ph.getByLabel(T('pharmacy.item'), { exact: true }).selectOption({ value: await serviceId('M01') });
    await ph.getByLabel(T('pharmacy.title'), { exact: true }).selectOption('dispense');
    await ph.getByLabel(T('pharmacy.visit'), { exact: true }).selectOption({ value: outpatient.id });
    await ph.locator('input[name="qty"]').fill('6');
    await ph.getByRole('button', { name: T('pharmacy.save'), exact: true }).click();
    await expect(ph.getByText(`${T('pharmacy.onHand')}: 494 таблетка`, { exact: true })).toBeVisible();
    await noSideScroll(); await shot('05-pharmacy-dispensed'); await helpShot('pharmacy');
    await signOut();

    // 6. Inpatient staff admit the second patient to a ward bed under the surgeon.
    await signIn('day.inpatient');
    const surgeon = staff.doctorIds[4]!;
    await page.getByText(T('inpatient.admit'), { exact: true }).first().click();
    const admit = page.locator('form').filter({ has: page.getByRole('button', { name: T('inpatient.admit'), exact: true }) });
    await admit.getByLabel(T('inpatient.visit'), { exact: true }).selectOption(admitted.id);
    await admit.getByLabel(T('inpatient.department'), { exact: true }).selectOption({ label: 'Жарроҳлик бўлими' });
    await admit.getByLabel(T('inpatient.doctor'), { exact: true }).selectOption(surgeon);
    await admit.getByLabel(T('inpatient.bed'), { exact: true }).selectOption({ index: 1 });
    await admit.getByRole('button', { name: T('inpatient.admit'), exact: true }).click();
    const stay = page.locator('.stays button').filter({ hasText: 'Синтетик Стационар Бемор' });
    await expect(stay).toHaveCount(1);
    await helpShot('inpatient');
    await signOut();
    // Two nights pass. Only this isolated synthetic schema is backdated; the app offers no clock override.
    const tx = await f.pool.connect();
    try {
      await tx.query('BEGIN');
      await tx.query('ALTER TABLE admissions DISABLE TRIGGER admissions_freeze');
      await tx.query('ALTER TABLE bed_assignments DISABLE TRIGGER bed_assignments_freeze');
      await tx.query("UPDATE admissions SET admitted_at=admitted_at-interval '2 days' WHERE visit_id=$1", [admitted.id]);
      await tx.query("UPDATE bed_assignments SET from_at=from_at-interval '2 days' WHERE admission_id=(SELECT id FROM admissions WHERE visit_id=$1)", [admitted.id]);
      await tx.query('ALTER TABLE admissions ENABLE TRIGGER admissions_freeze');
      await tx.query('ALTER TABLE bed_assignments ENABLE TRIGGER bed_assignments_freeze');
      await tx.query('COMMIT');
    } catch (e) { await tx.query('ROLLBACK'); throw e; } finally { tx.release(); }

    // 7. The surgeon records the operation on the admitted patient's bill.
    await signIn('day.doctor5');
    await tab(page, T('surgery.title'));
    await page.getByLabel(T('pharmacy.visit'), { exact: true }).selectOption(admitted.id);
    await page.getByLabel(T('surgery.service'), { exact: true }).selectOption(await serviceId('S01'));
    // The surgeon and the time default to the signed-in doctor and now (task 017).
    await expect(page.getByLabel(T('surgery.surgeon'), { exact: true })).toHaveValue(surgeon);
    await page.getByRole('button', { name: T('surgery.save'), exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: T('pharmacy.saved') })).toBeVisible();
    await noSideScroll(); await shot('07-surgery-recorded');
    // Ward round: the attending surgeon opens the admitted patient's note from the doctor home (no queue ticket).
    await tab(page, T('module.myQueue'));
    await page.locator('.dr-list li', { hasText: 'Синтетик Стационар Бемор' }).getByRole('button', { name: T('doctor.openNote'), exact: true }).click();
    await expect(page.locator('section.dr').getByRole('heading', { name: T('doctor.note'), exact: true })).toBeVisible();
    await expect(page.locator('.dr-patient').getByText('Синтетик Стационар Бемор', { exact: true })).toBeVisible();
    await signOut();

    // 8. Inpatient daily bed charges run through yesterday (two bed days).
    await signIn('day.inpatient');
    await stay.click();
    await page.getByText(T('inpatient.daily'), { exact: true }).first().click();
    const yesterday = (await f.pool.query("SELECT ((now() AT TIME ZONE 'Asia/Tashkent')::date-1)::text d")).rows[0].d as string;
    const daily = page.locator('form').filter({ has: page.getByRole('button', { name: T('inpatient.daily'), exact: true }) });
    await daily.getByLabel(T('inpatient.through'), { exact: true }).fill(yesterday);
    await daily.getByRole('button', { name: T('inpatient.daily'), exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: T('inpatient.saved') })).toBeVisible();
    const bedDays = (await f.pool.query("SELECT count(*)::int n FROM charge_lines l JOIN services s ON s.id=l.service_id WHERE l.visit_id=$1 AND s.kind='bed' AND l.status<>'cancelled'", [admitted.id])).rows[0].n;
    expect(bedDays).toBeGreaterThanOrEqual(2);
    await noSideScroll(); await shot('08-inpatient-daily');
    await signOut();

    // 9. Cashier: open the shift; outpatient pays part in cash, gets an approved discount, pays the rest by card, one refund.
    await signIn('day.cashier');
    const cash = page.locator('section.cashier');
    await cash.getByLabel(T('cashier.opening'), { exact: true }).fill('50000');
    await cash.getByRole('button', { name: T('cashier.open'), exact: true }).click();
    await expect(cash.getByLabel(T('cashier.shift'), { exact: true })).toBeVisible();
    await helpShot('cashier');
    const due = async () => BigInt(digits(await cash.getByTestId('cashier-due').innerText()));
    const openPatient = async (no: number, name: string) => {
      await cash.getByLabel(T('cashier.search'), { exact: true }).fill(String(no));
      await cash.getByRole('button', { name: T('cashier.find'), exact: true }).click();
      await cash.getByRole('button', { name: new RegExp(name) }).click();
      await expect(cash.getByRole('heading', { name, exact: true })).toBeVisible();
    };
    const amount = cash.getByLabel(T('cashier.amount'), { exact: true }).first();
    const pay = async (sum: bigint, method: 'cash' | 'card') => {
      const before = await due();
      await amount.fill(String(sum));
      await cash.getByLabel(T('cashier.method'), { exact: true }).selectOption(method);
      await cash.getByRole('button', { name: T('cashier.take'), exact: true }).click();
      await expect(cash.getByRole('dialog')).toContainText(new RegExp(`${String(sum).replace(/\B(?=(\d{3})+(?!\d))/g, '.')} сўм`));
      await cash.getByRole('button', { name: T('cashier.yes'), exact: true }).click();
      await expect(cash.getByRole('dialog')).toHaveCount(0);
      await expect.poll(due).toBe(before - sum);
    };
    await openPatient(outpatient.patient_no, 'Синтетик Амбулатор Бемор');
    const outpatientTotal = await due();
    expect(outpatientTotal).toBe(100000n + 45000n + 20000n + 6n * 3000n);
    await pay(100000n, 'cash');
    await cash.getByText(T('cashier.more'), { exact: true }).click();
    await cash.getByLabel(T('cashier.reason'), { exact: true }).fill('Синтетик: пенсионер чегирмаси');
    await cash.getByLabel(T('cashier.approver'), { exact: true }).selectOption(staff.ids.administrator);
    await cash.getByLabel(T('cashier.pin'), { exact: true }).fill(PIN);
    await amount.fill('10000');
    await cash.getByRole('button', { name: T('cashier.apply'), exact: true }).click();
    await expect.poll(due).toBe(outpatientTotal - 100000n - 10000n);
    await pay(await due(), 'card');
    expect(await due()).toBe(0n);
    // Refund 5 000 of the cash payment, approved by the administrator's PIN.
    await cash.getByLabel(T('cashier.payment'), { exact: true }).selectOption({ index: 1 });
    await cash.getByLabel(T('cashier.pin'), { exact: true }).fill(PIN);
    await amount.fill('5000');
    await cash.getByRole('button', { name: T('cashier.refund'), exact: true }).click();
    await expect.poll(due).toBe(5000n);
    await noSideScroll(); await shot('09-cashier-outpatient');
    // The admitted patient leaves a cash deposit before discharge.
    await openPatient(admitted.patient_no, 'Синтетик Стационар Бемор');
    await pay(1000000n, 'cash');
    await signOut();

    // 10. Inpatient staff discharge the patient; the final invoice includes the operation and bed days.
    await signIn('day.inpatient');
    await stay.click();
    await page.getByRole('button', { name: T('inpatient.discharge'), exact: true }).click();
    await page.getByRole('button', { name: T('inpatient.confirm'), exact: true }).click();
    await expect(stay).toContainText(T('inpatient.discharged'));
    const inpatientDue = BigInt(digits(await page.getByTestId('inpatient-due').innerText()));
    // Operation 4 500 000 + surgeon's consultation 120 000 + two ward bed days 2 × 200 000, less the 1 000 000 deposit.
    expect(inpatientDue).toBe(4500000n + 120000n + 2n * 200000n - 1000000n);
    await noSideScroll(); await shot('10-inpatient-discharged');
    await signOut();

    // 11. Cashier takes the full remaining amount and closes the shift with the counted cash.
    await signIn('day.cashier');
    await openPatient(admitted.patient_no, 'Синтетик Стационар Бемор');
    expect(await due()).toBe(inpatientDue);
    await pay(inpatientDue, 'card');
    expect(await due()).toBe(0n);
    const expectedCash = 50000n + 100000n - 5000n + 1000000n;
    await cash.getByLabel(T('cashier.counted'), { exact: true }).fill(String(expectedCash));
    await cash.getByRole('button', { name: T('cashier.close'), exact: true }).click();
    await expect(page.locator('.cashier-print')).toBeVisible();
    await noSideScroll(); await shot('11-cashier-closed');
    await signOut();

    // 12. Administrator closes the day.
    await signIn('day.admin');
    await page.getByRole('button', { name: T('day.closeButton'), exact: true }).click();
    await expect(page.getByRole('banner').locator('[data-state="closed"]')).toBeVisible();
    await signOut();

    // 13. CEO: money received ("collected", gross), refunds and net match the payments ledger and the closed day's snapshot.
    const group = (n: bigint) => new RegExp(`^${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '\\s')}$`);
    const gross = 100000n + (outpatientTotal - 110000n) + 1000000n + inpatientDue, refunds = 5000n, net = gross - refunds;
    const ledger = (await f.pool.query(`SELECT coalesce(sum(amount_uzs) FILTER (WHERE kind='payment'),0)::text gross, coalesce(sum(amount_uzs) FILTER (WHERE kind='refund'),0)::text refunds FROM payments WHERE clinic_id=$1`, [c])).rows[0];
    expect([BigInt(ledger.gross), BigInt(ledger.refunds)]).toEqual([gross, refunds]);
    const snapshot = (await f.pool.query("SELECT close_snapshot->'totals' t FROM business_days WHERE clinic_id=$1 AND status='closed'", [c])).rows[0].t;
    expect([BigInt(snapshot.collected), BigInt(snapshot.refunds), BigInt(snapshot.net)]).toEqual([gross, refunds, net]);
    await signIn('owner@example.test');
    await expect(page.locator('.ceo-kpi-0 strong')).toHaveText(group(gross));
    await expect(page.locator('.ceo-secondary button').filter({ hasText: T('ceo.net') }).locator('b')).toHaveText(group(net));
    await expect(page.locator('.ceo-secondary button').filter({ hasText: T('ceo.refunds') }).locator('b')).toHaveText(group(refunds));
    await noSideScroll(); await shot('13-ceo-dashboard'); await helpShot('ceo');
    await signOut();

    // 14. The therapist sees their own earnings (30% of the completed consultation, billed basis).
    await signIn('day.doctor');
    await tab(page, T('module.payroll'));
    await page.getByRole('button', { name: T('ceo.show'), exact: true }).click();
    await expect(page.locator('.ceo-pay-doctor')).toHaveCount(1);
    await expect(page.locator('.ceo-pay-doctor summary')).toContainText(/30\s000/);
    await noSideScroll(); await shot('14-doctor-earnings');
  } finally { await f.close(); }
});
