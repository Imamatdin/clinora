import { randomUUID as id } from 'node:crypto';
import type pg from 'pg';
export async function seedCashier(pool:pg.Pool,clinicId:string,actorId:string){
 const g={day:id(),desk:id(),visit:id(),patient:id(),service:id(),line:id(),expense:id()};
 await pool.query("INSERT INTO business_days(id,clinic_id,business_date,status,opened_by) VALUES($1,$2,(now() AT TIME ZONE 'Asia/Tashkent')::date,'open',$3)",[g.day,clinicId,actorId]);
 await pool.query("INSERT INTO cash_desks(id,clinic_id,name) VALUES($1,$2,'Synthetic Desk')",[g.desk,clinicId]);
 await pool.query("INSERT INTO expense_types(id,clinic_id,name_uz_cyrl) VALUES($1,$2,'Synthetic Expense')",[g.expense,clinicId]);
 await pool.query("INSERT INTO patients(id,clinic_id,display_name,provenance,phone) VALUES($1,$2,'Synthetic Aliyev','{\"source\":\"manual\"}','+998901234567')",[g.patient,clinicId]);
 await pool.query("INSERT INTO visits(id,clinic_id,patient_id,business_day_id,type,created_by) VALUES($1,$2,$3,$4,'outpatient',$5)",[g.visit,clinicId,g.patient,g.day,actorId]);
 await pool.query("INSERT INTO services(id,clinic_id,kind,name_uz_cyrl) VALUES($1,$2,'consultation','Synthetic Consultation')",[g.service,clinicId]);
 await pool.query("INSERT INTO charge_lines(id,clinic_id,visit_id,service_id,quantity,unit_price_uzs,source,created_by) VALUES($1,$2,$3,$4,1,1000000,'registration',$5)",[g.line,clinicId,g.visit,g.service,actorId]);
 return g;
}
