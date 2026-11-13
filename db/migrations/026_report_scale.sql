-- Task 024: reports read only the requested range plus open balances.
--
-- report_visit_open is a candidate set: every visit whose current balance is not zero (or whose
-- discounts are inconsistent) is flagged open. Reports then compute the exact as-of balance only for
-- flagged visits plus visits with ledger activity after the report's end date (only those can differ
-- between "now" and "as of that date"). The flag is recomputed under a per-visit advisory lock after
-- every ledger write, so the last committer sees all committed rows.
CREATE TABLE report_visit_open (
  clinic_id uuid NOT NULL, visit_id uuid NOT NULL, open boolean NOT NULL,
  PRIMARY KEY (clinic_id, visit_id),
  FOREIGN KEY (clinic_id, visit_id) REFERENCES visits(clinic_id, id)
);
CREATE INDEX report_visit_open_flagged ON report_visit_open(clinic_id, visit_id) WHERE open;

-- Current visit due, mirroring billing/invoice.ts totals: line value minus line discount, then the
-- visit discount on the remainder, minus net payments. Several active discounts on one target are
-- inconsistent data and keep the visit flagged so the report lists it for review.
CREATE FUNCTION report_visit_is_open(c uuid, v uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
WITH active AS (SELECT * FROM discounts WHERE clinic_id=c AND visit_id=v AND voided_at IS NULL),
lines AS (SELECT l.id,CASE WHEN l.status='cancelled' THEN 0::numeric ELSE l.unit_price_uzs::numeric*l.quantity END value
  FROM charge_lines l WHERE l.clinic_id=c AND l.visit_id=v),
base AS (SELECT coalesce(sum(l.value-coalesce(CASE WHEN d.kind='fixed' THEN least(l.value,d.amount_uzs) ELSE floor(l.value*d.percent_bp/10000) END,0)),0) total
  FROM lines l LEFT JOIN active d ON d.charge_line_id=l.id)
SELECT (SELECT count(charge_line_id)>count(DISTINCT charge_line_id) OR count(*) FILTER (WHERE charge_line_id IS NULL)>1 FROM active)
  OR b.total-coalesce((SELECT CASE WHEN d.kind='fixed' THEN least(b.total,d.amount_uzs) ELSE floor(b.total*d.percent_bp/10000) END
       FROM active d WHERE d.charge_line_id IS NULL LIMIT 1),0)
    <> coalesce((SELECT sum(CASE WHEN p.kind='payment' THEN p.amount_uzs ELSE -p.amount_uzs END) FROM payments p WHERE p.clinic_id=c AND p.visit_id=v),0)
FROM base b
$$;
CREATE FUNCTION report_track_visit_open() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Serialize per visit; plpgsql takes a fresh snapshot for the next statement, so it sees every
  -- ledger row committed by a writer that held this lock before us.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.visit_id::text, 24));
  INSERT INTO report_visit_open(clinic_id,visit_id,open) VALUES(NEW.clinic_id,NEW.visit_id,report_visit_is_open(NEW.clinic_id,NEW.visit_id))
    ON CONFLICT(clinic_id,visit_id) DO UPDATE SET open=excluded.open;
  RETURN NULL;
END $$;
CREATE TRIGGER report_track_visit_open AFTER INSERT OR UPDATE ON charge_lines FOR EACH ROW EXECUTE FUNCTION report_track_visit_open();
CREATE TRIGGER report_track_visit_open AFTER INSERT OR UPDATE ON discounts FOR EACH ROW EXECUTE FUNCTION report_track_visit_open();
CREATE TRIGGER report_track_visit_open AFTER INSERT ON payments FOR EACH ROW EXECUTE FUNCTION report_track_visit_open();

-- Set-based backfill, same arithmetic as report_visit_is_open (also used by the synthetic load seed,
-- which bulk-loads with triggers off).
CREATE FUNCTION report_refresh_visit_open(c uuid) RETURNS void LANGUAGE sql AS $$
WITH active AS (SELECT * FROM discounts WHERE clinic_id=c AND voided_at IS NULL),
lines AS (SELECT l.visit_id,l.id,CASE WHEN l.status='cancelled' THEN 0::numeric ELSE l.unit_price_uzs::numeric*l.quantity END value
  FROM charge_lines l WHERE l.clinic_id=c),
base AS (SELECT l.visit_id,sum(l.value-coalesce(CASE WHEN d.kind='fixed' THEN least(l.value,d.amount_uzs) ELSE floor(l.value*d.percent_bp/10000) END,0)) total
  FROM lines l LEFT JOIN active d ON d.charge_line_id=l.id GROUP BY l.visit_id),
dup AS (SELECT visit_id FROM active GROUP BY visit_id
  HAVING count(charge_line_id)>count(DISTINCT charge_line_id) OR count(*) FILTER (WHERE charge_line_id IS NULL)>1),
visit_discount AS (SELECT DISTINCT ON (visit_id) * FROM active WHERE charge_line_id IS NULL ORDER BY visit_id,id),
paid AS (SELECT visit_id,sum(CASE WHEN kind='payment' THEN amount_uzs ELSE -amount_uzs END) amount FROM payments WHERE clinic_id=c GROUP BY visit_id)
INSERT INTO report_visit_open(clinic_id,visit_id,open)
SELECT c,v.id,v.id IN (SELECT visit_id FROM dup)
  OR coalesce(b.total,0)-coalesce(CASE WHEN d.kind='fixed' THEN least(coalesce(b.total,0),d.amount_uzs) ELSE floor(coalesce(b.total,0)*d.percent_bp/10000) END,0)<>coalesce(y.amount,0)
FROM visits v LEFT JOIN base b ON b.visit_id=v.id LEFT JOIN visit_discount d ON d.visit_id=v.id LEFT JOIN paid y ON y.visit_id=v.id
WHERE v.clinic_id=c
ON CONFLICT(clinic_id,visit_id) DO UPDATE SET open=excluded.open;
$$;
SELECT report_refresh_visit_open(id) FROM clinics;

-- Set-based invoice lines for many visits over a date span: the same arithmetic as
-- billing/invoice.ts and report_line_discounts (task 021), partitioned by (visit, day).
-- review=true marks a (visit, day) that calculateInvoice would reject (duplicate discount target,
-- discount on a missing or cancelled line); reports list such visits instead of totalling them.
CREATE FUNCTION report_line_parts(c uuid, visits uuid[], from_day date, to_day date)
RETURNS TABLE(visit_id uuid, day date, charge_line_id uuid, service_id uuid, performer_user_id uuid, value numeric, discount numeric, payable numeric, review boolean)
LANGUAGE sql STABLE AS $$
WITH tz AS (SELECT timezone FROM clinics WHERE id=c),
days AS (SELECT d::date AS day FROM generate_series(from_day,to_day,interval '1 day') d),
-- Each visit's lines and discounts are read once (by index), then expanded over the days.
visit_lines AS (
  SELECT l.visit_id,l.id,l.service_id,l.performer_user_id,l.status,(l.cancelled_at AT TIME ZONE tz.timezone)::date cancelled_on,
    l.unit_price_uzs::numeric*l.quantity full_value,r.business_date
  FROM charge_lines l CROSS JOIN tz JOIN report_charge_dates r ON r.clinic_id=c AND r.charge_line_id=l.id
  WHERE l.clinic_id=c AND l.visit_id=ANY(visits)
), lines AS (
  SELECT v.visit_id,d.day,v.id,v.service_id,v.performer_user_id,(v.status='cancelled' AND v.cancelled_on<=d.day) cancelled,
    CASE WHEN v.status='cancelled' AND v.cancelled_on<=d.day THEN 0::numeric ELSE v.full_value END value
  FROM visit_lines v JOIN days d ON v.business_date<=d.day
), visit_discounts AS (
  SELECT d.*,(d.created_at AT TIME ZONE tz.timezone)::date created_on,(d.voided_at AT TIME ZONE tz.timezone)::date voided_on
  FROM discounts d CROSS JOIN tz WHERE d.clinic_id=c AND d.visit_id=ANY(visits)
), active AS (
  SELECT d.visit_id,y.day,d.id,d.charge_line_id,d.kind,d.amount_uzs,d.percent_bp,
    count(*) OVER (PARTITION BY d.visit_id,y.day,d.charge_line_id) n
  FROM visit_discounts d JOIN days y ON d.created_on<=y.day AND (d.voided_on IS NULL OR d.voided_on>y.day)
), invalid AS (
  SELECT DISTINCT a.visit_id,a.day FROM active a LEFT JOIN lines l ON l.visit_id=a.visit_id AND l.day=a.day AND l.id=a.charge_line_id
  WHERE a.n>1 OR (a.charge_line_id IS NOT NULL AND (l.id IS NULL OR l.cancelled))
), line_discount AS (
  SELECT DISTINCT ON (visit_id,day,charge_line_id) * FROM active WHERE charge_line_id IS NOT NULL ORDER BY visit_id,day,charge_line_id,id
), visit_discount AS (
  SELECT DISTINCT ON (visit_id,day) * FROM active WHERE charge_line_id IS NULL ORDER BY visit_id,day,id
), direct AS (
  SELECT l.*,coalesce(CASE WHEN d.kind='fixed' THEN least(l.value,d.amount_uzs) ELSE floor(l.value*d.percent_bp/10000) END,0) direct
  FROM lines l LEFT JOIN line_discount d ON d.visit_id=l.visit_id AND d.day=l.day AND d.charge_line_id=l.id
), bases AS (
  SELECT d.*,d.value-d.direct base,sum(d.value-d.direct) OVER (PARTITION BY d.visit_id,d.day) total FROM direct d
), quotas AS (
  SELECT b.*,coalesce(CASE WHEN v.kind='fixed' THEN least(b.total,v.amount_uzs) ELSE floor(b.total*v.percent_bp/10000) END,0) amount
  FROM bases b LEFT JOIN visit_discount v ON v.visit_id=b.visit_id AND v.day=b.day
), parts AS (
  SELECT q.*,CASE WHEN q.base>0 THEN floor(q.amount*q.base/q.total) ELSE 0 END part,
    row_number() OVER (PARTITION BY q.visit_id,q.day ORDER BY CASE WHEN q.base>0 THEN mod(q.amount*q.base,q.total) END DESC NULLS LAST,q.id) rank
  FROM quotas q
), shares AS (
  SELECT p.*,p.part+CASE WHEN p.base>0 AND p.rank<=p.amount-sum(p.part) OVER (PARTITION BY p.visit_id,p.day) THEN 1 ELSE 0 END visit_part FROM parts p
)
SELECT s.visit_id,s.day,s.id,s.service_id,s.performer_user_id,s.value,s.direct+s.visit_part,s.value-s.direct-s.visit_part,i.visit_id IS NOT NULL
FROM shares s LEFT JOIN invalid i ON i.visit_id=s.visit_id AND i.day=s.day
$$;

CREATE INDEX report_adjustment_payment ON cashier_allocation_adjustments(clinic_id,payment_id);
