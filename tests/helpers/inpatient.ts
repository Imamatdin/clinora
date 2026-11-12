import { randomUUID } from 'node:crypto';
import type pg from 'pg';

/** Entirely synthetic shared fixture; no catalog or patient data from a clinic. */
export async function inpatientGraph(f:{pool:pg.Pool;owner:{clinicId:string;userId:string}},daysAgo=0,businessDayAgo=0) {
  const {pool}=f,c=f.owner.clinicId,u=f.owner.userId;
  const dept=randomUUID(),room=randomUUID(),bed=randomUUID(),bed2=randomUUID(),patient=randomUUID(),visit=randomUUID(),day=randomUUID();
  const services={bed:randomUUID(),bed2:randomUUID(),lab:randomUUID(),ultrasound:randomUUID(),other:randomUUID(),caretaker:randomUUID(),medicine:randomUUID()};
  const dates=(await pool.query("SELECT (now() AT TIME ZONE timezone)::date::text today,((now() AT TIME ZONE timezone)::date-$2::int)::text start FROM clinics WHERE id=$1",[c,daysAgo])).rows[0];
  await pool.query("INSERT INTO business_days(id,clinic_id,business_date,status,opened_by) VALUES($1,$2,$3::date-$5::int,'open',$4) ON CONFLICT DO NOTHING",[day,c,dates.today,u,businessDayAgo]);
  const open=(await pool.query("SELECT id FROM business_days WHERE clinic_id=$1 AND status='open'",[c])).rows[0].id;
  await pool.query("INSERT INTO departments(id,clinic_id,name_uz_cyrl) VALUES($1,$2,'Синтетик бўлим')",[dept,c]);
  await pool.query("INSERT INTO doctor_profiles(clinic_id,user_id,department_id,specialty_uz_cyrl) VALUES($1,$2,$3,'Синтетик шифокор') ON CONFLICT DO NOTHING",[c,u,dept]);
  for(const [kind,id] of Object.entries(services)){
    const serviceKind=kind==='bed2'?'bed':kind==='ultrasound'?'diagnostic':kind;
    await pool.query('INSERT INTO services(id,clinic_id,kind,name_uz_cyrl,track_stock) VALUES($1,$2,$3,$4,$5)',[id,c,serviceKind,`Синтетик ${kind}`,kind==='medicine']);
    const price={bed:'100000',bed2:'200000',lab:'250000',ultrasound:'150000',other:'100000',caretaker:'50000',medicine:'10000'}[kind];
    await pool.query("INSERT INTO service_prices(id,clinic_id,service_id,price_uzs,effective_from,set_by) VALUES($1,$2,$3,$4,'2000-01-01',$5)",[randomUUID(),c,id,price,u]);
  }
  await pool.query("INSERT INTO stock_movements(id,clinic_id,service_id,qty,reason,created_by) VALUES($1,$2,$3,10,'receipt',$4)",[randomUUID(),c,services.medicine,u]);
  await pool.query("INSERT INTO rooms(id,clinic_id,department_id,name) VALUES($1,$2,$3,'101')",[room,c,dept]);
  await pool.query("INSERT INTO beds(id,clinic_id,room_id,label,bed_service_id) VALUES($1,$2,$3,'1',$4),($5,$2,$3,'2',$6)",[bed,c,room,services.bed,bed2,services.bed2]);
  await pool.query(`INSERT INTO patients(id,clinic_id,display_name,provenance) VALUES($1,$2,'Синтетик Бемор','{"source":"manual"}')`,[patient,c]);
  await pool.query("INSERT INTO visits(id,clinic_id,patient_id,business_day_id,type,created_by) VALUES($1,$2,$3,$4,'inpatient',$5)",[visit,c,patient,open,u]);
  const admission=randomUUID();
  if(daysAgo>0){
    await pool.query("INSERT INTO admissions(id,clinic_id,visit_id,department_id,attending_user_id,admitted_at) VALUES($1,$2,$3,$4,$5,($6::date+time '10:00') AT TIME ZONE 'Asia/Tashkent')",[admission,c,visit,dept,u,dates.start]);
    await pool.query("INSERT INTO bed_assignments(id,clinic_id,admission_id,bed_id,from_at) SELECT $1,$2,$3,$4,admitted_at FROM admissions WHERE id=$3",[randomUUID(),c,admission,bed]);
  }
  return {clinic:c,actor:u,dept,room,bed,bed2,patient,visit,services,admission,today:dates.today as string,start:dates.start as string};
}
