import { test,expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { processFixture,T } from './process-fixture.js';
import { inpatientGraph } from '../helpers/inpatient.js';
import { inpatient as words } from '../../src/web/i18n/inpatient.uz-Cyrl.js';
const I=(key:keyof typeof words)=>words[key];

for(const width of [1280,360])test(`inpatient admission, three days, transfer, discharge and server PDF at ${width}px`,async({page})=>{
  const f=await processFixture();try{
    const g=await inpatientGraph(f);
    await page.setViewportSize({width,height:900});await page.goto(f.origin);
    await page.getByLabel(T('auth.identifier'),{exact:true}).fill('owner@example.test');
    await page.getByLabel(T('auth.password'),{exact:true}).fill(f.password);
    await page.getByRole('button',{name:T('auth.signIn'),exact:true}).click();
    await expect(page.getByRole('heading',{name:I('inpatient.title'),exact:true})).toBeVisible();
    await page.getByText(I('inpatient.admit'),{exact:true}).first().click();
    const form=page.locator('form').filter({has:page.getByRole('button',{name:I('inpatient.admit'),exact:true})});
    await form.getByLabel(I('inpatient.visit'),{exact:true}).selectOption(g.visit);
    await form.getByLabel(I('inpatient.department'),{exact:true}).selectOption(g.dept);
    await form.getByLabel(I('inpatient.doctor'),{exact:true}).selectOption(g.actor);
    await form.getByLabel(I('inpatient.bed'),{exact:true}).selectOption(g.bed);
    await form.getByRole('button',{name:I('inpatient.admit'),exact:true}).click();
    const stay=page.locator('.stays button').filter({hasText:'Синтетик Бемор'});await expect(stay).toHaveCount(1);
    // Simulate three elapsed clinic dates in this isolated synthetic database only.
    // Production actions never offer backdating or a clock override; temporarily unfreeze
    // just these fixture timestamps, restoring the guards in the same transaction.
    const tx=await f.pool.connect();try{
      await tx.query('BEGIN');
      await tx.query('ALTER TABLE admissions DISABLE TRIGGER admissions_freeze');
      await tx.query('ALTER TABLE bed_assignments DISABLE TRIGGER bed_assignments_freeze');
      await tx.query("UPDATE admissions SET admitted_at=admitted_at-interval '3 days' WHERE visit_id=$1",[g.visit]);
      await tx.query("UPDATE bed_assignments SET from_at=from_at-interval '3 days' WHERE admission_id=(SELECT id FROM admissions WHERE visit_id=$1)",[g.visit]);
      await tx.query('ALTER TABLE admissions ENABLE TRIGGER admissions_freeze');
      await tx.query('ALTER TABLE bed_assignments ENABLE TRIGGER bed_assignments_freeze');
      await tx.query('COMMIT');
    }catch(e){await tx.query('ROLLBACK');throw e;}finally{tx.release();}
    await stay.click();
    await page.getByText(I('inpatient.addService'),{exact:true}).first().click();
    const serviceForm=page.locator('form').filter({has:page.getByRole('button',{name:I('inpatient.addService'),exact:true})});
    await serviceForm.getByLabel(I('inpatient.service'),{exact:true}).selectOption(g.services.other);
    await serviceForm.getByRole('button',{name:I('inpatient.addService'),exact:true}).click();
    await expect(page.getByTestId('inpatient-value')).toHaveText(/100.000/);
    await page.getByText(I('inpatient.daily'),{exact:true}).first().click();
    const through=(await f.pool.query('SELECT ($1::date-1)::text d',[g.today])).rows[0].d;
    const daily=page.locator('form').filter({has:page.getByRole('button',{name:I('inpatient.daily'),exact:true})});
    await daily.getByLabel(I('inpatient.through'),{exact:true}).fill(through);
    await daily.getByRole('button',{name:I('inpatient.daily'),exact:true}).click();
    await expect(page.getByTestId('inpatient-value')).toHaveText(/400.000/);
    await page.getByText(I('inpatient.transfer'),{exact:true}).first().click();
    const transfer=page.locator('form').filter({has:page.getByRole('button',{name:I('inpatient.transfer'),exact:true})});
    await transfer.getByLabel(I('inpatient.bed'),{exact:true}).selectOption(g.bed2);
    await transfer.getByRole('button',{name:I('inpatient.transfer'),exact:true}).click();
    await expect(stay).toHaveText(/101 2/);
    await page.getByRole('button',{name:I('inpatient.discharge'),exact:true}).click();
    await page.getByRole('button',{name:I('inpatient.confirm'),exact:true}).click();
    await expect(stay).toContainText(I('inpatient.discharged'));
    await expect(page.getByTestId('inpatient-due')).toHaveText(/400.000/);
    const pdf=page.waitForResponse(r=>r.url().endsWith('/invoice-pdf'));
    await page.getByRole('button',{name:I('inpatient.print'),exact:true}).click();
    const response=await pdf;expect(response.status()).toBe(200);
    const bytes=Buffer.from((await response.json()).base64,'base64');expect(bytes.subarray(0,5).toString()).toBe('%PDF-');
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width);
    await mkdir('work/browser-evidence',{recursive:true});await page.screenshot({path:`work/browser-evidence/inpatient-${width}.png`,fullPage:true});
  }finally{await f.close();}
});
