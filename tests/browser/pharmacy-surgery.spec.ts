import { test,expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { processFixture,T } from './process-fixture.js';
import { tab } from './ui.js';

for(const width of [360,1280]) test(`pharmacy receipt, dispense and surgery reach shared bill at ${width}px`,async({page})=>{
  const f=await processFixture();
  try {
    const c=f.owner.clinicId,u=f.owner.userId,day=randomUUID(),patient=randomUUID(),visit=randomUUID(),medicine=randomUUID(),operation=randomUUID();
    await f.pool.query("INSERT INTO business_days(id,clinic_id,business_date,status,opened_by) VALUES($1,$2,'2026-11-12','open',$3)",[day,c,u]);
    await f.pool.query("INSERT INTO patients(id,clinic_id,display_name,provenance) VALUES($1,$2,'Synthetic Patient','{}')",[patient,c]);
    await f.pool.query("INSERT INTO visits(id,clinic_id,patient_id,business_day_id,type,created_by,created_at) VALUES($1,$2,$3,$4,'outpatient',$5,now()-interval '1 hour')",[visit,c,patient,day,u]);
    await f.pool.query("INSERT INTO services(id,clinic_id,kind,name_uz_cyrl,track_stock) VALUES($1,$2,'medicine','Синтетик дори',true),($3,$2,'surgery','Синтетик операция',false)",[medicine,c,operation]);
    for(const s of [medicine,operation]) await f.pool.query("INSERT INTO service_prices(id,clinic_id,service_id,price_uzs,effective_from,set_by) VALUES($1,$2,$3,15000,'2026-01-01',$4)",[randomUUID(),c,s,u]);
    await f.pool.query("INSERT INTO doctor_profiles(clinic_id,user_id,specialty_uz_cyrl) VALUES($1,$2,'Синтетик жарроҳ')",[c,u]);
    await page.setViewportSize({width,height:900});await page.goto(f.origin);
    await page.getByLabel(T('auth.identifier'),{exact:true}).fill('owner@example.test');await page.getByLabel(T('auth.password'),{exact:true}).fill(f.password);
    await page.getByRole('button',{name:T('auth.signIn'),exact:true}).click();
    // Several modules can share a role's home now (cashier merged first); open pharmacy explicitly.
    await tab(page,T('pharmacy.title'));
    const screen=page.locator('section.pharmacy');
    await expect(screen.getByLabel(T('pharmacy.item'),{exact:true})).toBeVisible();
    await screen.locator('input[name="qty"]').fill('3');await screen.getByLabel(T('pharmacy.cost'),{exact:true}).fill('10000');await screen.getByLabel(T('pharmacy.supplier'),{exact:true}).fill('Synthetic supplier');
    await screen.getByRole('button',{name:T('pharmacy.save'),exact:true}).click();await expect(screen.getByRole('status').filter({hasText:T('pharmacy.saved')})).toBeVisible();
    await screen.getByRole('group',{name:T('pharmacy.title'),exact:true}).getByRole('button',{name:T('pharmacy.mode.dispense'),exact:true}).click();await screen.locator('input[name="qty"]').fill('1');
    await screen.getByRole('button',{name:T('pharmacy.save'),exact:true}).click();
    await expect(screen.getByText(T('pharmacy.onHand')+': 2 дона',{exact:true})).toBeVisible();
    await tab(page,T('surgery.title'));
    await page.getByLabel(T('surgery.time'),{exact:true}).fill(new Date(Date.now()-60000).toISOString().slice(0,16));
    // The fixture's business day is a fixed past date, so the CEO records a reason (task 023).
    await page.getByLabel(T('surgery.backdateReason'),{exact:true}).fill('Синтетик кечиккан қайд');
    await page.getByRole('button',{name:T('surgery.save'),exact:true}).click();
    await expect(page.getByRole('status').filter({hasText:T('pharmacy.saved')})).toBeVisible();
    const bill=(await f.pool.query('SELECT sum(quantity*unit_price_uzs)::text total,count(*)::int n FROM charge_lines WHERE visit_id=$1',[visit])).rows[0];
    expect(bill).toEqual({total:'30000',n:2});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBeTruthy();
    await mkdir('work/browser-evidence',{recursive:true});await page.screenshot({path:`work/browser-evidence/pharmacy-surgery-${width}.png`,fullPage:true});
  } finally {await f.close();}
});
