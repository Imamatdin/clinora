import type pg from 'pg';

/**
 * Two years of synthetic clinic history for the report load test (task 024).
 * Volume: 150 outpatient visits and 20 inpatient admissions per business day (stays of 3-7
 * days, so about 100 occupied beds), 15 doctors, two cash desks. About 3% of outpatient visits
 * and 5% of stays keep a balance forever, so open balances grow with history the way a real
 * clinic's do. Every row is fictional.
 *
 * Bulk insert runs with session_replication_role=replica (superuser, test database only) so the
 * closed-day and append-only triggers do not reject backdated history. The rows are therefore
 * written consistent by construction, including report_charge_dates and report_versions that
 * triggers would normally maintain.
 */
export type LoadSeed = { today: string; doctors: string[]; days: number; counts: Record<string, number> };

export async function seedHistory(pool: pg.Pool, clinicId: string, ownerId: string, days = 730): Promise<LoadSeed> {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    await tx.query("SET LOCAL session_replication_role = replica");
    await tx.query('SET LOCAL statement_timeout = 0');
    await tx.query('SELECT setseed(0.24)');
    await tx.query(`CREATE TEMP TABLE seed_param ON COMMIT DROP AS
      SELECT $1::uuid clinic, $2::uuid owner, (now() AT TIME ZONE 'Asia/Tashkent')::date today, $3::int days`, [clinicId, ownerId, days]);
    await tx.query(SQL);
    const today = (await tx.query('SELECT today::text FROM seed_param')).rows[0].today as string;
    const doctors = (await tx.query("SELECT user_id FROM membership_roles WHERE clinic_id=$1 AND role='doctor' AND user_id<>$2 ORDER BY user_id", [clinicId, ownerId])).rows.map(r => r.user_id as string);
    const counts: Record<string, number> = {};
    for (const t of ['patients', 'visits', 'charge_lines', 'payments', 'payment_allocations', 'discounts', 'bed_day_charges', 'business_days'])
      counts[t] = Number((await tx.query(`SELECT count(*) n FROM ${t} WHERE clinic_id=$1`, [clinicId])).rows[0].n);
    await tx.query('COMMIT');
    for (const t of ['patients', 'visits', 'charge_lines', 'payments', 'payment_allocations', 'discounts', 'bed_day_charges', 'business_days', 'report_charge_dates', 'admissions', 'cash_shifts', 'cash_outs', 'report_visit_open'])
      await pool.query(`ANALYZE ${t}`);
    return { today, doctors, days, counts };
  } catch (error) { await tx.query('ROLLBACK').catch(() => {}); throw error; }
  finally { tx.release(); }
}

const SQL = String.raw`
-- Staff: 15 doctors, 2 cashiers, 1 registrar.
CREATE TEMP TABLE seed_staff ON COMMIT DROP AS
  SELECT gen_random_uuid() id, n, CASE WHEN n<=15 THEN 'doctor' WHEN n<=17 THEN 'cashier' ELSE 'registrar' END role FROM generate_series(1,18) n;
INSERT INTO accounts(id,display_name,password_hash,login) SELECT id,'Synthetic '||role||' '||n,'!synthetic-no-login','load.'||role||'.'||n FROM seed_staff;
INSERT INTO memberships(id,clinic_id,user_id,role,clinical_access,patient_scope,status,granted_by)
  SELECT gen_random_uuid(),p.clinic,s.id,'administrator',s.role='doctor','assigned','active',p.owner FROM seed_staff s,seed_param p;
INSERT INTO membership_roles(clinic_id,user_id,role,granted_by) SELECT p.clinic,s.id,s.role,p.owner FROM seed_staff s,seed_param p;

-- Catalog: 6 departments, one consultation per department, 10 lab, 5 diagnostic, 5 procedures, bed, caretaker.
CREATE TEMP TABLE seed_dept ON COMMIT DROP AS SELECT gen_random_uuid() id,n FROM generate_series(1,6) n;
INSERT INTO departments(id,clinic_id,name_uz_cyrl) SELECT d.id,p.clinic,'Бўлим '||d.n FROM seed_dept d,seed_param p;
CREATE TEMP TABLE seed_service ON COMMIT DROP AS
  SELECT gen_random_uuid() id,'consultation'::text kind,n,(SELECT id FROM seed_dept WHERE seed_dept.n=g.n) dept,100000+n*10000 price FROM generate_series(1,6) g(n)
  UNION ALL SELECT gen_random_uuid(),'lab',n,(SELECT id FROM seed_dept WHERE seed_dept.n=6),20000+n*5000 FROM generate_series(1,10) n
  UNION ALL SELECT gen_random_uuid(),'diagnostic',n,(SELECT id FROM seed_dept WHERE seed_dept.n=5),80000+n*10000 FROM generate_series(1,5) n
  UNION ALL SELECT gen_random_uuid(),'procedure',n,(SELECT id FROM seed_dept WHERE seed_dept.n=1+n%6),60000+n*15000 FROM generate_series(1,5) n
  UNION ALL SELECT gen_random_uuid(),'bed',1,(SELECT id FROM seed_dept WHERE seed_dept.n=2),250000
  UNION ALL SELECT gen_random_uuid(),'caretaker',1,(SELECT id FROM seed_dept WHERE seed_dept.n=2),70000;
INSERT INTO services(id,clinic_id,department_id,kind,name_uz_cyrl) SELECT s.id,p.clinic,s.dept,s.kind,s.kind||' '||s.n FROM seed_service s,seed_param p;
INSERT INTO doctor_split_rules(id,clinic_id,user_id,doctor_share_bp,basis,discount_bearer,categories,effective_from,created_by)
  SELECT gen_random_uuid(),p.clinic,s.id,3000+s.n*100,CASE WHEN s.n%3=0 THEN 'paid' ELSE 'billed' END,(ARRAY['clinic','doctor','proportional'])[1+s.n%3],
    ARRAY['consultation','procedure','diagnostic'],p.today-p.days-1,p.owner FROM seed_staff s,seed_param p WHERE s.role='doctor';

-- Business days: history closed, today open.
CREATE TEMP TABLE seed_day ON COMMIT DROP AS
  SELECT gen_random_uuid() id,d::date date,d::date=p.today is_today FROM seed_param p,generate_series(p.today-p.days,p.today,interval '1 day') d;
INSERT INTO business_days(id,clinic_id,business_date,status,opened_by,opened_at,closed_by,closed_at,close_snapshot)
  SELECT d.id,p.clinic,d.date,CASE WHEN d.is_today THEN 'open' ELSE 'closed' END,p.owner,(d.date+time '08:00') AT TIME ZONE 'Asia/Tashkent',
    CASE WHEN d.is_today THEN NULL ELSE p.owner END,CASE WHEN d.is_today THEN NULL ELSE (d.date+time '20:00') AT TIME ZONE 'Asia/Tashkent' END,
    CASE WHEN d.is_today THEN NULL ELSE '{"seeded":true}'::jsonb END FROM seed_day d,seed_param p;

CREATE TEMP TABLE seed_desk ON COMMIT DROP AS SELECT gen_random_uuid() id,n FROM generate_series(1,2) n;
INSERT INTO cash_desks(id,clinic_id,name) SELECT k.id,p.clinic,'Касса '||k.n FROM seed_desk k,seed_param p;
CREATE TEMP TABLE seed_shift ON COMMIT DROP AS
  SELECT gen_random_uuid() id,d.id day_id,d.date,k.id desk,k.n,(SELECT id FROM seed_staff WHERE role='cashier' AND n=15+k.n) cashier FROM seed_day d,seed_desk k;
-- Shifts are closed (also today's), so day close can run. close_report content is not read by reports.
INSERT INTO cash_shifts(id,clinic_id,cash_desk_id,business_day_id,cashier_user_id,opened_at,opening_cash_uzs,closed_at,counted_cash_uzs,close_report,status)
  SELECT s.id,p.clinic,s.desk,s.day_id,s.cashier,(s.date+time '08:05') AT TIME ZONE 'Asia/Tashkent',100000,(s.date+time '19:55') AT TIME ZONE 'Asia/Tashkent',100000,'{}','closed'
  FROM seed_shift s,seed_param p;
INSERT INTO expense_types(id,clinic_id,name_uz_cyrl) SELECT gen_random_uuid(),clinic,'Хўжалик' FROM seed_param;
INSERT INTO cash_outs(id,clinic_id,cash_shift_id,business_day_id,expense_type_id,amount_uzs,note,created_by,created_at)
  SELECT gen_random_uuid(),p.clinic,s.id,s.day_id,(SELECT id FROM expense_types WHERE clinic_id=p.clinic LIMIT 1),15000+s.n*5000,'Synthetic supplies',s.cashier,(s.date+time '13:00') AT TIME ZONE 'Asia/Tashkent'
  FROM seed_shift s,seed_param p;

-- Patients: roughly half of visits are returning patients.
CREATE TEMP TABLE seed_patient ON COMMIT DROP AS SELECT gen_random_uuid() id,n FROM seed_param p,generate_series(1,(p.days+1)*85) n;
INSERT INTO patients(id,clinic_id,display_name,full_name,patient_no,provenance,source,created_at)
  SELECT x.id,p.clinic,'Synthetic patient '||x.n,'Synthetic patient '||x.n,x.n,'{"synthetic":true}',(ARRAY['street','referral','instagram','returning'])[1+x.n%4],(p.today-p.days)::timestamp AT TIME ZONE 'Asia/Tashkent'
  FROM seed_patient x,seed_param p;

-- Visits: 150 outpatient + 20 inpatient per day.
CREATE TEMP TABLE seed_visit ON COMMIT DROP AS
  SELECT gen_random_uuid() id,d.id day_id,d.date,d.is_today,CASE WHEN i<=150 THEN 'outpatient' ELSE 'inpatient' END type,i,
    1+floor(random()*(SELECT count(*) FROM seed_patient))::int patient_n,1+floor(random()*15)::int doctor_n,
    3+floor(random()*5)::int stay,random() r,(d.date+time '08:30'+make_interval(mins=>(i*3)%600)) AT TIME ZONE 'Asia/Tashkent' at
  FROM seed_day d,generate_series(1,170) i;
ALTER TABLE seed_visit ADD COLUMN patient uuid,ADD COLUMN doctor uuid,ADD COLUMN discharge date,ADD COLUMN debtor boolean;
UPDATE seed_visit v SET patient=x.id FROM seed_patient x WHERE x.n=v.patient_n;
UPDATE seed_visit v SET doctor=s.id FROM seed_staff s WHERE s.role='doctor' AND s.n=v.doctor_n;
CREATE INDEX ON seed_visit(id);
UPDATE seed_visit v SET discharge=CASE WHEN v.type='inpatient' THEN v.date+v.stay END,debtor=CASE WHEN v.type='inpatient' THEN v.r<0.05 ELSE v.r<0.03 END;
INSERT INTO visits(id,clinic_id,patient_id,business_day_id,type,status,created_by,created_at,closed_at)
  SELECT v.id,p.clinic,v.patient,v.day_id,v.type,CASE WHEN v.type='outpatient' AND NOT v.is_today OR v.discharge<=p.today THEN 'closed' ELSE 'open' END,
    (SELECT id FROM seed_staff WHERE role='registrar'),v.at,CASE WHEN v.type='outpatient' AND NOT v.is_today OR v.discharge<=p.today THEN v.at+interval '2 hours' END
  FROM seed_visit v,seed_param p;
INSERT INTO admissions(id,clinic_id,visit_id,department_id,attending_user_id,admitted_at,discharged_at,status)
  SELECT gen_random_uuid(),p.clinic,v.id,(SELECT id FROM seed_dept WHERE n=2),v.doctor,v.at,
    CASE WHEN v.discharge<=p.today THEN (v.discharge+time '11:00') AT TIME ZONE 'Asia/Tashkent' END,CASE WHEN v.discharge<=p.today THEN 'discharged' ELSE 'admitted' END
  FROM seed_visit v,seed_param p WHERE v.type='inpatient';

-- Charge lines. Outpatient: consultation by the visit doctor, 0-2 lab/diagnostic lines ordered by that
-- doctor. Inpatient: one procedure by the attending doctor and one bed line per stay day (counted
-- admission day, not discharge day), until today for patients still admitted.
CREATE TEMP TABLE seed_line ON COMMIT DROP AS
  SELECT gen_random_uuid() id,v.id visit,v.date service_date,v.at,v.debtor,v.type,v.doctor performer,s.id service,s.price,s.kind,1 ord
    FROM seed_visit v JOIN seed_service s ON s.kind='consultation' AND s.n=1+(v.doctor_n%6) WHERE v.type='outpatient'
  UNION ALL SELECT gen_random_uuid(),v.id,v.date,v.at+interval '10 minutes',v.debtor,v.type,v.doctor,s.id,s.price,s.kind,1+k
    FROM seed_visit v CROSS JOIN generate_series(1,2) k JOIN seed_service s ON s.kind=CASE WHEN k=1 THEN 'lab' ELSE 'diagnostic' END AND s.n=1+((v.i+k)%5)
    WHERE v.type='outpatient' AND v.r*7>k
  UNION ALL SELECT gen_random_uuid(),v.id,v.date,v.at+interval '1 hour',v.debtor,v.type,v.doctor,s.id,s.price,s.kind,1
    FROM seed_visit v JOIN seed_service s ON s.kind='procedure' AND s.n=1+v.i%5 WHERE v.type='inpatient'
  UNION ALL SELECT gen_random_uuid(),v.id,d::date,(d::date+time '00:05') AT TIME ZONE 'Asia/Tashkent',v.debtor,v.type,NULL,s.id,s.price,s.kind,2
    FROM seed_visit v JOIN seed_service s ON s.kind='bed',seed_param p,generate_series(v.date,least(v.discharge-1,p.today),interval '1 day') d WHERE v.type='inpatient';
-- 2% of outpatient lab/diagnostic lines were cancelled before payment.
ALTER TABLE seed_line ADD COLUMN cancelled boolean;
UPDATE seed_line SET cancelled=type='outpatient' AND ord>1 AND random()<0.02;
INSERT INTO charge_lines(id,clinic_id,visit_id,service_id,performer_user_id,quantity,unit_price_uzs,status,source,created_by,created_at,completed_by,completed_at,cancelled_by,cancelled_at,cancel_reason)
  SELECT l.id,p.clinic,l.visit,l.service,l.performer,1,l.price,CASE WHEN l.cancelled THEN 'cancelled' ELSE 'completed' END,
    CASE l.kind WHEN 'bed' THEN 'bed_day' WHEN 'consultation' THEN 'registration' ELSE 'doctor' END,(SELECT id FROM seed_staff WHERE role='registrar'),l.at,
    CASE WHEN NOT l.cancelled THEN coalesce(l.performer,p.owner) END,CASE WHEN NOT l.cancelled THEN l.at+interval '20 minutes' END,
    CASE WHEN l.cancelled THEN p.owner END,CASE WHEN l.cancelled THEN l.at+interval '5 minutes' END,NULL
  FROM seed_line l,seed_param p;
INSERT INTO report_charge_dates(clinic_id,charge_line_id,business_date) SELECT p.clinic,l.id,l.service_date FROM seed_line l,seed_param p;
INSERT INTO bed_day_charges(clinic_id,admission_id,charge_date,charge_line_id)
  SELECT p.clinic,a.id,l.service_date,l.id FROM seed_line l JOIN admissions a ON a.visit_id=l.visit,seed_param p WHERE l.kind='bed';

-- 5% of consultations carry a 10% line discount approved by the owner.
CREATE TEMP TABLE seed_discount ON COMMIT DROP AS
  SELECT gen_random_uuid() id,l.id line,l.visit,l.at,floor(l.price*1000/10000)::bigint amount FROM seed_line l WHERE l.kind='consultation' AND random()<0.05;
INSERT INTO discounts(id,clinic_id,visit_id,charge_line_id,kind,percent_bp,reason,approved_by,created_by,created_at)
  SELECT d.id,p.clinic,d.visit,d.line,'percent',1000,'Synthetic waiver',p.owner,p.owner,d.at+interval '15 minutes' FROM seed_discount d,seed_param p;

-- Payments. Outpatients pay on the visit day; inpatients pay at discharge (still-admitted ones not yet).
-- Debtors pay half of their first line only and keep the rest outstanding.
CREATE TEMP TABLE seed_payable ON COMMIT DROP AS
  SELECT l.id line,l.visit,l.ord,l.price-coalesce(d.amount,0) payable FROM seed_line l LEFT JOIN seed_discount d ON d.line=l.id WHERE NOT l.cancelled;
CREATE TEMP TABLE seed_payment ON COMMIT DROP AS
  SELECT gen_random_uuid() id,v.id visit,v.debtor,CASE WHEN v.type='outpatient' THEN v.date ELSE v.discharge END pay_date,
    (ARRAY['cash','card','transfer'])[1+floor(random()*3)::int] method,1+floor(random()*2)::int desk_n
  FROM seed_visit v,seed_param p WHERE v.type='outpatient' OR v.discharge<=p.today;
CREATE TEMP TABLE seed_alloc ON COMMIT DROP AS
  SELECT y.id payment,a.line,CASE WHEN y.debtor THEN a.payable/2 ELSE a.payable END amount
  FROM seed_payment y JOIN seed_payable a ON a.visit=y.visit WHERE (NOT y.debtor OR a.ord=1) AND a.payable>0 AND (NOT y.debtor OR a.payable/2>0);
INSERT INTO payments(id,clinic_id,visit_id,cash_shift_id,business_day_id,kind,method,amount_uzs,idempotency_key,received_by,created_at)
  SELECT y.id,p.clinic,y.visit,s.id,s.day_id,'payment',y.method,t.amount,'load-'||y.id,s.cashier,(y.pay_date+time '12:00') AT TIME ZONE 'Asia/Tashkent'
  FROM seed_payment y JOIN (SELECT payment,sum(amount) amount FROM seed_alloc GROUP BY payment) t ON t.payment=y.id
  JOIN seed_shift s ON s.date=y.pay_date AND s.n=y.desk_n,seed_param p;
INSERT INTO payment_allocations(clinic_id,payment_id,charge_line_id,amount_uzs) SELECT p.clinic,a.payment,a.line,a.amount FROM seed_alloc a,seed_param p;
SELECT report_refresh_visit_open(clinic) FROM seed_param;
INSERT INTO report_versions(clinic_id,version) SELECT clinic,1 FROM seed_param ON CONFLICT(clinic_id) DO UPDATE SET version=report_versions.version+1;
`;
