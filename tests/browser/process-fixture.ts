import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { databaseFixture } from '../integration/fixture.js';
import { uzCyrl } from '../../src/web/i18n/uz-Cyrl.js';

/** Dictionary lookup for selectors, so tests follow the real interface text. */
export const T=(key:keyof typeof uzCyrl,vars:Record<string,string|number>={})=>uzCyrl[key].replace(/\{(\w+)\}/g,(_,n:string)=>String(vars[n]));

/** Compiled server process against an isolated PostgreSQL schema. */
export async function processFixture(extraEnv:Record<string,string>={}){
  const db=await databaseFixture();const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const address=probe.address();if(!address||typeof address==='string')throw new Error('Port allocation failed');const port=address.port;await new Promise<void>(resolve=>probe.close(()=>resolve()));
  const origin=`http://127.0.0.1:${port}`,url=new URL(db.url);url.searchParams.set('options',`-c search_path=${db.schema}`);let child:ChildProcess;
  async function start(){child=spawn(process.execPath,['dist/server/server/main.js'],{env:{...process.env,DATABASE_URL:url.toString(),APP_ORIGIN:origin,COOKIE_SECURE:'false',PORT:String(port),NODE_ENV:'test',...extraEnv},stdio:['ignore','pipe','pipe']});
    await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Compiled server startup timed out')),10000);child.once('error',e=>{clearTimeout(timeout);reject(e);});child.once('exit',()=>{clearTimeout(timeout);reject(new Error('Compiled server exited before startup'));});child.stdout!.on('data',data=>{if(String(data).includes('Clinora foundation:')){clearTimeout(timeout);resolve();}});});}
  async function stop(){if(child.exitCode!==null)return;const exited=once(child,'exit');child.kill();const timer=setTimeout(()=>child.kill('SIGKILL'),5000);try{await exited;}finally{clearTimeout(timer);}}
  await start();return{...db,origin,async restart(){await stop();await start();},async close(){await stop();await db.close();}};
}
