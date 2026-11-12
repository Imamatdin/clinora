import { randomUUID } from 'node:crypto';
import { makePool, migrate } from '../src/server/database.ts';
import { provisionOwner } from '../src/server/provision.ts';
import { Encounter } from '../src/contracts/index.ts';
import { transaction } from '../src/server/database.ts';

if(process.env.NODE_ENV==='production'||process.env.ALLOW_SYNTHETIC_DEMO!=='true')throw new Error('Synthetic setup requires ALLOW_SYNTHETIC_DEMO=true and is forbidden in production');
for(const key of ['DATABASE_URL','DEMO_EMAIL','DEMO_PASSWORD'])if(!process.env[key])throw new Error(`${key} required; no default credentials`);
const target=new URL(process.env.DATABASE_URL);
if(!['127.0.0.1','localhost','::1'].includes(target.hostname)||!['/clinora_local','/clinora_test'].includes(target.pathname))throw new Error('Demo requires explicit local/test database');
const pool=makePool(process.env.DATABASE_URL);
try{
  await migrate(pool);
  const owner=await provisionOwner(pool,{email:process.env.DEMO_EMAIL,password:process.env.DEMO_PASSWORD,name:'Synthetic Demo Clinician',clinic:'Synthetic Demonstration Clinic',clinicalAccess:true});
  await transaction(pool,async tx=>{
    const patient=randomUUID();await tx.query('INSERT INTO patients(id,clinic_id,display_name,mrn,provenance) VALUES($1,$2,$3,$4,$5)',[patient,owner.clinicId,'Fictional Samira — demo only','SYN-DEMO-001',{source:'manual',externalReference:null}]);
    await tx.query('INSERT INTO patient_assignments(clinic_id,patient_id,user_id) VALUES($1,$2,$3)',[owner.clinicId,patient,owner.userId]);
    for(const [date,location,specialty] of [['2020-02-29','Synthetic room 1','General medicine'],['2026-11-10','Synthetic room 2','Cardiology']]){
      const stamp=new Date().toISOString(),id=randomUUID(),document=randomUUID();
      const encounter=Encounter.parse({id,clinicId:owner.clinicId,patientId:patient,clinicianId:owner.userId,location:{id:null,label:location},specialty,occurrence:{precision:'date',date,timezone:'Asia/Tashkent'},createdAt:stamp,updatedAt:stamp,status:'draft',revision:1,provenance:{source:'manual',externalReference:null}});
      await tx.query('INSERT INTO encounters(id,clinic_id,patient_id,clinician_id,data) VALUES($1,$2,$3,$4,$5)',[id,owner.clinicId,patient,owner.userId,encounter]);
      await tx.query('INSERT INTO documents(id,clinic_id,patient_id,encounter_id) VALUES($1,$2,$3,$4)',[document,owner.clinicId,patient,id]);
      await tx.query("INSERT INTO audit_events(id,actor_id,clinic_id,action,resource_id) VALUES($1,$2,$3,'synthetic.encounter',$4)",[randomUUID(),owner.userId,owner.clinicId,id]);
    }
    await tx.query("INSERT INTO audit_events(id,actor_id,clinic_id,action,resource_id) VALUES($1,$2,$3,'synthetic.patient',$4)",[randomUUID(),owner.userId,owner.clinicId,patient]);
  });
  console.log('Synthetic clinic, explicit clinical owner, fictional patient and two empty dated encounters provisioned. Credentials were not printed.');
}finally{await pool.end();}
