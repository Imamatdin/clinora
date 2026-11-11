import { test,expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { databaseFixture, key } from '../integration/fixture.js';

async function processFixture(){
  const db=await databaseFixture();const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const address=probe.address();if(!address||typeof address==='string')throw new Error('Port allocation failed');const port=address.port;await new Promise<void>(resolve=>probe.close(()=>resolve()));
  const origin=`http://127.0.0.1:${port}`,url=new URL(db.url);url.searchParams.set('options',`-c search_path=${db.schema}`);let child:ChildProcess;
  async function start(){child=spawn(process.execPath,['dist/server/server/main.js'],{env:{...process.env,DATABASE_URL:url.toString(),APP_ORIGIN:origin,COOKIE_SECURE:'false',PORT:String(port),NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});
    await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Compiled server startup timed out')),10000);child.once('error',e=>{clearTimeout(timeout);reject(e);});child.once('exit',()=>{clearTimeout(timeout);reject(new Error('Compiled server exited before startup'));});child.stdout!.on('data',data=>{if(String(data).includes('Clinora foundation:')){clearTimeout(timeout);resolve();}});});}
  async function stop(){if(child.exitCode!==null)return;const exited=once(child,'exit');child.kill();await exited;}
  await start();return{...db,origin,async restart(){await stop();await start();},async close(){await stop();await db.close();}};
}
async function login(page:Page,origin:string,password:string){await page.goto(origin);await page.getByLabel('Email',{exact:true}).fill('owner@example.test');await page.getByLabel('Email',{exact:true}).press('Tab');await expect(page.getByLabel('Password',{exact:true})).toBeFocused();await page.getByLabel('Password',{exact:true}).fill(password);await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page.getByRole('button',{name:'+ New patient',exact:true})).toBeVisible();}

for(const width of [1280,390])test(`real notebook login/create/save/reload/process restart at ${width}px`,async({page})=>{
  const f=await processFixture();try{
    await page.setViewportSize({width,height:900});await login(page,f.origin,f.password);
    await page.getByRole('button',{name:'+ New patient',exact:true}).click();await page.getByLabel('Patient name',{exact:true}).fill('Fictional Samira — demo only');await page.getByLabel('Medical-record number').fill('SYN-'+width);await page.getByLabel('Date of birth').fill('1994-04-23');await page.getByRole('button',{name:'Create patient',exact:true}).click();
    await expect(page.getByRole('heading',{name:'Fictional Samira — demo only'})).toBeVisible();
    await page.getByRole('button',{name:'+ New encounter'}).click();await page.getByLabel('Visit date',{exact:true}).fill('2020-02-29');await page.getByLabel('Location',{exact:true}).fill('Synthetic North / room 2');await page.getByRole('button',{name:'Create encounter',exact:true}).click();
    await expect(page.getByLabel('Observed / measured findings',{exact:true})).toHaveValue('');await page.getByLabel('Reported information',{exact:true}).fill('Fictional patient reports three days of symptoms.');await page.getByLabel('Assessment — unapproved',{exact:true}).fill('Historical draft assessment; not a confirmed diagnosis.');
    await expect(page.getByText('Unsaved changes',{exact:true})).toBeVisible();
    page.once('dialog',dialog=>dialog.dismiss());await page.getByRole('button',{name:'+ New encounter'}).click();await expect(page.getByLabel('Reported information',{exact:true})).toHaveValue('Fictional patient reports three days of symptoms.');
    await page.getByRole('button',{name:'Save draft',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'Saved revision 1'})).toBeVisible();
    await f.restart();await page.reload();await page.getByRole('button',{name:/Fictional Samira/}).click();await page.getByRole('button',{name:/2020-02-29.*date only/}).click();await expect(page.getByLabel('Reported information',{exact:true})).toHaveValue('Fictional patient reports three days of symptoms.');await expect(page.getByLabel('Observed / measured findings',{exact:true})).toHaveValue('');
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width);
    await mkdir('work/browser-evidence',{recursive:true});await page.screenshot({path:`work/browser-evidence/notebook-${width}.png`,fullPage:true});
  }finally{await f.close();}
});

test('two real browser pages surface a version conflict and retain dirty text, including a failed save',async({page,context})=>{
  const f=await processFixture();try{
    await page.setViewportSize({width:1280,height:900});await login(page,f.origin,f.password);
    await page.getByRole('button',{name:'+ New patient',exact:true}).click();await page.getByLabel('Patient name',{exact:true}).fill('Fictional Conflict Patient');await page.getByRole('button',{name:'Create patient',exact:true}).click();await page.getByRole('button',{name:'+ New encounter'}).click();await page.getByLabel('Visit date',{exact:true}).fill('2026-11-10');await page.getByLabel('Location',{exact:true}).fill('Synthetic room');await page.getByRole('button',{name:'Create encounter',exact:true}).click();await page.getByLabel('Reported information',{exact:true}).fill('Initial synthetic note');await page.getByRole('button',{name:'Save draft',exact:true}).click();await expect(page.getByText('Saved revision 1',{exact:true})).toBeVisible();
    const other=await context.newPage();await other.goto(f.origin);await other.getByRole('button',{name:/Fictional Conflict Patient/}).click();await other.getByRole('button',{name:/2026-11-10.*date only/}).click();
    await page.getByLabel('Reported information',{exact:true}).fill('Doctor A save');await page.getByRole('button',{name:'Save draft',exact:true}).click();await expect(page.getByText('Saved revision 2',{exact:true})).toBeVisible();
    await other.getByLabel('Reported information',{exact:true}).fill('Doctor B unsaved correction');await other.getByRole('button',{name:'Save draft',exact:true}).click();await expect(other.getByRole('heading',{name:'Resolve the version conflict'})).toBeVisible();await expect(other.getByLabel('Reported information',{exact:true})).toHaveValue('Doctor B unsaved correction');
    await other.getByRole('button',{name:'Load latest for comparison'}).click();await expect(other.getByText('Doctor A save',{exact:false})).toBeVisible();await other.getByRole('button',{name:'Keep my text and use latest as the base'}).click();await expect(other.getByLabel('Reported information',{exact:true})).toHaveValue('Doctor B unsaved correction');
    // Force a real transaction failure rather than mocking a successful API response.
    await f.pool.query("CREATE FUNCTION browser_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='draft.saved' THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER browser_fail_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION browser_fail_audit()");
    await other.getByRole('button',{name:'Save draft',exact:true}).click();await expect(other.getByRole('alert')).toContainText('Service unavailable');await expect(other.getByLabel('Reported information',{exact:true})).toHaveValue('Doctor B unsaved correction');await expect(other.getByText('Unsaved changes',{exact:true})).toBeVisible();
    await f.pool.query('DROP TRIGGER browser_fail_audit ON audit_events');await other.getByRole('button',{name:'Save draft',exact:true}).click();await expect(other.getByText('Saved revision 3',{exact:true})).toBeVisible();
    await mkdir('work/browser-evidence',{recursive:true});await other.screenshot({path:'work/browser-evidence/conflict-resolved.png',fullPage:true});await other.close();
  }finally{await f.close();}
});
