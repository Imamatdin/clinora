import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createApp } from '../../src/server/app.js';
import { makePool, migrate } from '../../src/server/database.js';
import { provisionOwner } from '../../src/server/provision.js';

export async function databaseFixture() {
  const url=process.env.TEST_DATABASE_URL;
  if(!url)throw new Error('TEST_DATABASE_URL required; PostgreSQL acceptance checks must not be skipped');
  const parsed=new URL(url);
  if(parsed.pathname!=='/clinora_test'||!['localhost','127.0.0.1','::1'].includes(parsed.hostname))throw new Error('Tests require loopback /clinora_test database');
  const schema='clinora_test_'+randomUUID().replaceAll('-','');
  assert.match(schema,/^clinora_test_[a-f0-9]{32}$/);
  const admin=makePool(url);await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=makePool(url,schema);await migrate(pool);await migrate(pool);
  const password='Synthetic-'+randomUUID();
  const owner=await provisionOwner(pool,{email:'owner@example.test',password,name:'Synthetic Owner',clinic:'Synthetic North Clinic',clinicalAccess:true});
  const other=await provisionOwner(pool,{email:'other@example.test',password,name:'Synthetic Other Owner',clinic:'Synthetic South Clinic',clinicalAccess:true});
  return {pool,password,owner,other,schema,url,async close(){await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}};
}
export async function httpFixture(){
  const db=await databaseFixture();
  const config={pool:db.pool,origin:'http://127.0.0.1:0',secureCookies:false};
  let server=await createApp(undefined,config);
  async function listen(){server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');config.origin=`http://127.0.0.1:${address.port}`;}
  await listen();
  function client(){let cookie='',csrf='';return {
    async request(path:string,body?:unknown,extra:Record<string,string>={}){
      const r=await fetch(config.origin+path,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,...(body===undefined?{}:{'Content-Type':'application/json',Origin:config.origin,'X-CSRF-Token':csrf}),...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
      const setCookie=r.headers.get('set-cookie');if(setCookie)cookie=setCookie.split(';')[0]!;return r;
    },
    async login(email='owner@example.test') {const r=await this.request('/api/auth/login',{email,password:db.password});assert.equal(r.status,200);const me=await this.request('/api/auth/me');const value=await me.json();csrf=value.csrf;return value;},
    get cookie(){return cookie;},get csrf(){return csrf;}
  };}
  return {...db,config,client,
    async restart(){await new Promise<void>(resolve=>server.close(()=>resolve()));server=await createApp(undefined,config);await listen();},
    async close(){await new Promise<void>(resolve=>server.close(()=>resolve()));await db.close();}
  };
}
export const patientInput={displayName:'Fictional Patient',dateOfBirth:'1994-04-23',mrn:null};
export const encounterInput={occurrence:{precision:'date',date:'2020-02-29',timezone:'Asia/Tashkent'},location:'Synthetic North / room 2',specialty:'General medicine'};
export const noteInput={expectedRevision:0,templateId:'general-note-v1',note:{reported:'Synthetic report, three days.',observed:'',assessment:'Draft historical assessment for review.',plan:''}};
export const key=()=>randomUUID();
