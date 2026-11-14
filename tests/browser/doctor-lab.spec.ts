import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { processFixture, T } from './process-fixture.js';
import { passwordHash } from '../../src/server/security.js';
import { headerButton, visitPart } from './ui.js';

/*
 * Task 010 acceptance: at phone width the doctor calls the next patient, writes and approves a note with a
 * prescription and orders a lab test; the lab enters and confirms the result; the doctor sees it.
 */
for (const width of [360, 1280]) test(`doctor and lab complete one visit at ${width}px`, async ({ page }) => {
  const f = await processFixture();
  try {
    const c = f.owner.clinicId, u = f.owner.userId, k = () => randomUUID();
    const doctor = k(), lab = k(), day = k(), point = k(), patient = k(), visit = k(), ticket = k(), consult = k(), cbc = k(), line = k();
    const hash = await passwordHash(f.password);
    for (const [id, email, name, role, clinical] of [[doctor, 'doctor.e2e@example.test', 'Синтетик Терапевт', 'doctor', true], [lab, 'lab.e2e@example.test', 'Синтетик Лаборант', 'laboratory', false]] as const) {
      await f.pool.query('INSERT INTO accounts(id,email,display_name,password_hash) VALUES($1,$2,$3,$4)', [id, email, name, hash]);
      await f.pool.query("INSERT INTO memberships(id,clinic_id,user_id,role,clinical_access,patient_scope,status,granted_by) VALUES($1,$2,$3,$4,$5,'assigned','active',$6)",
        [k(), c, id, clinical ? 'clinician' : 'administrator', clinical, u]);
      await f.pool.query('INSERT INTO membership_roles(clinic_id,user_id,role,granted_by) VALUES($1,$2,$3,$4)', [c, id, role, u]);
    }
    await f.pool.query("INSERT INTO doctor_profiles(clinic_id,user_id,specialty_uz_cyrl) VALUES($1,$2,'Терапевт')", [c, doctor]);
    await f.pool.query("INSERT INTO business_days(id,clinic_id,business_date,status,opened_by) VALUES($1,$2,(now() AT TIME ZONE 'Asia/Tashkent')::date,'open',$3)", [day, c, u]);
    await f.pool.query("INSERT INTO queue_points(id,clinic_id,kind,user_id,name_uz_cyrl) VALUES($1,$2,'doctor',$3,'Терапевт 1-хона')", [point, c, doctor]);
    await f.pool.query("INSERT INTO patients(id,clinic_id,display_name,full_name,provenance) VALUES($1,$2,'Синтетик Бемор','Синтетик Бемор','{}')", [patient, c]);
    await f.pool.query('INSERT INTO patient_assignments(clinic_id,patient_id,user_id) VALUES($1,$2,$3)', [c, patient, doctor]);
    await f.pool.query("INSERT INTO services(id,clinic_id,kind,name_uz_cyrl) VALUES($1,$2,'consultation','Терапевт кўриги'),($3,$2,'lab','Умумий қон таҳлили')", [consult, c, cbc]);
    for (const s of [consult, cbc]) await f.pool.query("INSERT INTO service_prices(id,clinic_id,service_id,price_uzs,effective_from,set_by) VALUES($1,$2,$3,45000,'2026-01-01',$4)", [k(), c, s, u]);
    await f.pool.query("INSERT INTO visits(id,clinic_id,patient_id,business_day_id,type,created_by) VALUES($1,$2,$3,$4,'outpatient',$5)", [visit, c, patient, day, u]);
    await f.pool.query('INSERT INTO queue_tickets(id,clinic_id,business_day_id,visit_id,queue_point_id,number) VALUES($1,$2,$3,$4,$5,7)', [ticket, c, day, visit, point]);
    await f.pool.query("INSERT INTO charge_lines(id,clinic_id,visit_id,service_id,quantity,unit_price_uzs,source,created_by,queue_ticket_id) VALUES($1,$2,$3,$4,1,45000,'registration',$5,$6)", [line, c, visit, consult, u, ticket]);

    page.on('dialog', d => void d.accept());
    await page.setViewportSize({ width, height: 900 });
    const signIn = async (email: string) => {
      await page.goto(f.origin);
      await page.getByLabel(T('auth.identifier'), { exact: true }).fill(email);
      await page.getByLabel(T('auth.password'), { exact: true }).fill(f.password);
      await page.getByRole('button', { name: T('auth.signIn'), exact: true }).click();
    };
    const signOut = async () => { await headerButton(page, T('app.signOut')); await expect(page.getByLabel(T('auth.identifier'), { exact: true })).toBeVisible(); };
    const noSideScroll = async (p: Page) => expect(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
    const dr = page.locator('section.dr');

    // Doctor: call next, start, write the note with one prescription line, save, approve, order a lab test.
    await signIn('doctor.e2e@example.test');
    await expect(page.getByRole('heading', { name: T('module.myQueue'), exact: true })).toBeVisible();
    await dr.getByRole('button', { name: T('doctor.callNext'), exact: true }).click();
    await expect(dr.locator('.dr-current .ticket')).toHaveText('7');
    await expect(dr.locator('.dr-current').getByRole('heading', { name: 'Синтетик Бемор' })).toBeVisible();
    await dr.getByRole('button', { name: T('doctor.start'), exact: true }).click();
    await dr.getByLabel(T('doctor.field.reported'), { exact: true }).fill('Синтетик: 3 кундан бери иситма ва йўтал');
    await dr.getByLabel(T('doctor.field.assessment'), { exact: true }).fill('J06.9 Юқори нафас йўллари инфекцияси (синтетик)');
    await dr.getByRole('button', { name: T('doctor.rx.add'), exact: true }).click();
    await dr.getByLabel(T('doctor.rx.medicine'), { exact: true }).fill('Парацетамол 500 мг');
    await dr.getByLabel(T('doctor.rx.dose'), { exact: true }).fill('1 таблетка');
    await dr.getByLabel(T('doctor.rx.frequency'), { exact: true }).fill('кунига 3 марта');
    await dr.getByLabel(T('doctor.rx.duration'), { exact: true }).fill('5 кун');
    await dr.getByRole('button', { name: T('doctor.save'), exact: true }).click();
    await expect(dr.getByRole('status').filter({ hasText: T('doctor.saved', { revision: 1 }) }).first()).toBeVisible();
    // Task 019: Back with unsaved notes asks save, discard or stay.
    // By id: once the textarea holds saved text, its wrapping label no longer matches exactly.
    const reported = dr.locator('#dr-note-reported');
    const back = dr.getByRole('button', { name: T('doctor.back'), exact: true });
    const leave = page.getByRole('alertdialog', { name: T('doctor.leaveTitle') });
    await reported.fill('Синтетик: иситма, йўтал, бош оғриғи');
    await back.click();
    await expect(leave).toBeVisible();
    await leave.getByRole('button', { name: T('doctor.leaveStay'), exact: true }).click();
    await expect(leave).toBeHidden();
    await expect(reported).toHaveValue('Синтетик: иситма, йўтал, бош оғриғи');
    await back.click();
    await leave.getByRole('button', { name: T('doctor.leaveSave'), exact: true }).click();
    await expect(dr.getByRole('button', { name: T('doctor.open'), exact: true })).toBeVisible();
    await dr.getByRole('button', { name: T('doctor.open'), exact: true }).click();
    await expect(reported).toHaveValue('Синтетик: иситма, йўтал, бош оғриғи');
    await reported.fill('ташланадиган матн');
    await back.click();
    await leave.getByRole('button', { name: T('doctor.leaveDiscard'), exact: true }).click();
    await dr.getByRole('button', { name: T('doctor.open'), exact: true }).click();
    await expect(reported).toHaveValue('Синтетик: иситма, йўтал, бош оғриғи');
    await expect(dr.getByRole('status').filter({ hasText: T('doctor.saved', { revision: 2 }) }).first()).toBeVisible();
    await dr.getByRole('button', { name: T('doctor.approve'), exact: true }).click();
    await expect(dr.getByText(T('doctor.approvedTag', { revision: 3 }), { exact: true })).toBeVisible();
    const pdfHref = await dr.getByRole('link', { name: T('doctor.pdf'), exact: true }).getAttribute('href');
    const pdf = await page.evaluate(async href => { const r = await fetch(href!); return { status: r.status, type: r.headers.get('content-type') }; }, pdfHref);
    expect(pdf).toEqual({ status: 200, type: 'application/pdf' });
    await visitPart(page, 'orders');
    await dr.getByLabel(T('doctor.service'), { exact: true }).selectOption({ value: cbc });
    await dr.getByRole('button', { name: T('doctor.order'), exact: true }).click();
    await expect(dr.getByRole('status').filter({ hasText: T('doctor.ordered') })).toBeVisible();
    await noSideScroll(page);
    await mkdir('work/browser-evidence', { recursive: true });
    await page.screenshot({ path: `work/browser-evidence/doctor-visit-${width}.png`, fullPage: true });
    await signOut();

    // Lab: open the order, enter a result, save, confirm.
    await signIn('lab.e2e@example.test');
    await expect(dr.getByRole('heading', { name: T('lab.title'), exact: true })).toBeVisible();
    await dr.getByRole('button', { name: T('lab.open'), exact: true }).click();
    await dr.getByLabel(T('lab.param'), { exact: true }).fill('Гемоглобин');
    await dr.getByLabel(T('lab.value'), { exact: true }).fill('128');
    await dr.getByLabel(T('lab.unit'), { exact: true }).fill('г/л');
    await dr.getByLabel(T('lab.reference'), { exact: true }).fill('120–160');
    await dr.getByRole('button', { name: T('lab.save'), exact: true }).click();
    await expect(dr.getByRole('status').filter({ hasText: T('lab.saved', { version: 1 }) })).toBeVisible();
    await dr.getByRole('button', { name: T('lab.confirm'), exact: true }).click();
    await expect(dr.getByRole('status').filter({ hasText: T('lab.confirmed') })).toBeVisible();
    await noSideScroll(page);
    await page.screenshot({ path: `work/browser-evidence/lab-confirm-${width}.png`, fullPage: true });
    await signOut();

    // Doctor: reopen the visit, sees the result on the patient card, completes the consultation.
    await signIn('doctor.e2e@example.test');
    await dr.getByRole('button', { name: T('doctor.open'), exact: true }).click();
    await visitPart(page, 'history');
    await expect(dr.locator('.dr-patient').getByText('128', { exact: true })).toBeVisible();
    await dr.getByRole('button', { name: T('doctor.complete'), exact: true }).click();
    await expect(dr.getByRole('status').filter({ hasText: T('doctor.completed') })).toBeVisible();
    await noSideScroll(page);

    const rows = (await f.pool.query(`SELECT s.kind, l.status, l.unit_price_uzs::text price FROM charge_lines l JOIN services s ON s.id=l.service_id
      WHERE l.visit_id=$1 ORDER BY s.kind`, [visit])).rows;
    expect(rows).toEqual([{ kind: 'consultation', status: 'completed', price: '45000' }, { kind: 'lab', status: 'completed', price: '45000' }]);
    expect((await f.pool.query('SELECT count(*)::int n FROM note_approvals')).rows[0].n).toBe(1);
  } finally { await f.close(); }
});
