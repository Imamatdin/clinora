import { test,expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { processFixture,T } from './process-fixture.js';
import { seedCashier } from '../integration/cashier-fixture.js';
import { transaction } from '../../src/server/database.js';
import { requireRole } from '../../src/server/roles.js';
import * as cash from '../../src/modules/cashier/actions.js';
import { setRule } from '../../src/modules/payroll/actions.js';
import { ceo } from '../../src/web/i18n/ceo.uz-Cyrl.js';
const C=(key:keyof typeof ceo)=>ceo[key];

for(const width of [1440,390])test(`C8: real dashboard, drilldown, PDF download and payroll at ${width}px`,async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  const f=await processFixture();try{
    const g=await seedCashier(f.pool,f.owner.clinicId,f.owner.userId);
    await f.pool.query('UPDATE charge_lines SET performer_user_id=$2 WHERE id=$1',[g.line,f.owner.userId]);
    await transaction(f.pool,async tx=>{
      const c=await requireRole(tx,f.owner.userId,f.owner.clinicId,['ceo']);
      const date=(await tx.query('SELECT business_date FROM business_days WHERE id=$1',[g.day])).rows[0].business_date;
      await setRule(c,{userId:f.owner.userId,shareBp:5000,basis:'billed',discountBearer:'proportional',categories:['consultation'],effectiveFrom:date});
      const shift=await cash.open(c,{deskId:g.desk,opening:'10000'});
      await cash.pay(c,g.visit,{shiftId:shift.id,amount:'600000',method:'cash',key:crypto.randomUUID()});
      await cash.close(c,shift.id,{counted:'610000'});
    });
    await page.setViewportSize({width,height:1000});await page.goto(f.origin);
    await page.getByLabel(T('auth.identifier'),{exact:true}).fill('owner@example.test');await page.getByLabel(T('auth.password'),{exact:true}).fill(f.password);await page.getByRole('button',{name:T('auth.signIn'),exact:true}).click();
    await expect(page.getByRole('heading',{name:C('ceo.title'),exact:true})).toBeVisible();
    const card=page.locator('.ceo-kpi').filter({hasText:C('ceo.collected')});await expect(card).toContainText('600');
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width);
    await mkdir('work/browser-evidence',{recursive:true});await page.screenshot({path:`work/browser-evidence/ceo-dashboard-${width}.png`,fullPage:true});
    await card.focus();await page.keyboard.press('Enter');await expect(page.locator('.ceo-ledger h2')).toBeFocused();await expect(page.locator('.ceo-ledger')).toContainText('Synthetic Aliyev');
    await page.getByRole('button',{name:C('ceo.back'),exact:true}).click();
    await page.getByText(C('ceo.more'),{exact:true}).click();const download=page.waitForEvent('download',{timeout:10000});await page.getByRole('button',{name:C('ceo.pdf'),exact:true}).click();const pdf=await download.catch(e=>{throw new Error(`${e.message}; browser errors: ${errors.join('; ')}`);});expect(pdf.suggestedFilename()).toBe('clinora-report.pdf');await pdf.saveAs(`work/browser-evidence/ceo-report-${width}.pdf`);
    await page.locator('.ceo-filters>summary').click();await page.getByLabel(C('ceo.language'),{exact:true}).selectOption('uz-Latn');await expect(page.getByRole('heading',{name:'Klinika koʻrsatkichlari'})).toBeVisible();
    await page.getByLabel('Hisobot tili',{exact:true}).selectOption('uz-Cyrl');
    await page.getByRole('button',{name:T('module.payroll'),exact:true}).click();await expect(page.getByRole('heading',{name:C('ceo.payrollTitle'),exact:true})).toBeVisible();
    await page.getByRole('button',{name:C('ceo.show'),exact:true}).click();await expect(page.locator('.ceo-pay-doctor')).toContainText('500');
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width);
    await page.screenshot({path:`work/browser-evidence/ceo-payroll-${width}.png`,fullPage:true});
    // Closing the day creates a persisted report; the report opens after reload.
    page.on('dialog',d=>d.accept());await page.locator('.ceo-day-control>summary').click();await page.getByRole('button',{name:T('day.closeButton'),exact:true}).click();await expect(page.getByRole('status').filter({hasText:T('day.closedNotice')})).toBeVisible();
    await page.getByRole('button',{name:T('module.reports'),exact:true}).click();await expect(page.locator('.ceo-live')).toHaveText(C('ceo.snapshot'));
    await page.getByRole('button',{name:C('ceo.thermal'),exact:true}).click();
    await page.goto(`${f.origin}/?report=${g.day}`);await expect(page.locator('.ceo-live')).toHaveText(C('ceo.snapshot'));
    await page.screenshot({path:`work/browser-evidence/ceo-closed-day-${width}.png`,fullPage:true});
  }finally{await f.close();}
});

test('C8: dashboard shows recoverable server errors and a true empty state',async({page})=>{
  const f=await processFixture();try{
    await page.goto(f.origin);await page.getByLabel(T('auth.identifier'),{exact:true}).fill('owner@example.test');await page.getByLabel(T('auth.password'),{exact:true}).fill(f.password);await page.getByRole('button',{name:T('auth.signIn'),exact:true}).click();
    await expect(page.locator('.ceo-kpi-0 strong')).toHaveText('0');await expect(page.locator('.ceo-empty').first()).toBeVisible();
    await page.route('**/reports/dashboard',r=>r.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'SERVICE_UNAVAILABLE'}})}));
    await page.locator('.ceo-filters>summary').click();await page.getByRole('button',{name:C('ceo.show'),exact:true}).click();await expect(page.getByRole('alert')).toContainText(C('ceo.error'));
    await page.unroute('**/reports/dashboard');await page.getByRole('button',{name:C('ceo.retry'),exact:true}).click();await expect(page.locator('.ceo-kpi-0 strong')).toHaveText('0');
  }finally{await f.close();}
});
