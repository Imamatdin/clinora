-- Reporting dates are separate from arrival dates and mutable service timestamps.
CREATE TABLE report_charge_dates (
  clinic_id uuid NOT NULL, charge_line_id uuid NOT NULL, business_date date NOT NULL,
  PRIMARY KEY(clinic_id,charge_line_id),
  FOREIGN KEY(clinic_id,charge_line_id) REFERENCES charge_lines(clinic_id,id)
);
INSERT INTO report_charge_dates
SELECT l.clinic_id,l.id,coalesce(b.charge_date,k.charge_date,
  (SELECT d.business_date FROM business_days d WHERE d.clinic_id=l.clinic_id AND l.created_at>=d.opened_at AND (d.closed_at IS NULL OR l.created_at<=d.closed_at) ORDER BY d.opened_at DESC LIMIT 1),
  (l.created_at AT TIME ZONE c.timezone)::date)
FROM charge_lines l JOIN clinics c ON c.id=l.clinic_id
LEFT JOIN bed_day_charges b ON b.clinic_id=l.clinic_id AND b.charge_line_id=l.id
LEFT JOIN caretaker_day_charges k ON k.clinic_id=l.clinic_id AND k.charge_line_id=l.id;
CREATE INDEX report_charge_date_range ON report_charge_dates(clinic_id,business_date,charge_line_id);
CREATE FUNCTION report_capture_charge_date() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO report_charge_dates SELECT NEW.clinic_id,NEW.id,business_date FROM business_days WHERE clinic_id=NEW.clinic_id AND status='open';
  RETURN NEW;
END $$;
CREATE TRIGGER report_capture_charge_date AFTER INSERT ON charge_lines FOR EACH ROW EXECUTE FUNCTION report_capture_charge_date();
CREATE FUNCTION report_capture_stay_date() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE report_charge_dates SET business_date=NEW.charge_date WHERE clinic_id=NEW.clinic_id AND charge_line_id=NEW.charge_line_id;
  RETURN NEW;
END $$;
CREATE TRIGGER report_capture_bed_date AFTER INSERT ON bed_day_charges FOR EACH ROW EXECUTE FUNCTION report_capture_stay_date();
CREATE TRIGGER report_capture_caretaker_date AFTER INSERT ON caretaker_day_charges FOR EACH ROW EXECUTE FUNCTION report_capture_stay_date();

-- Optimistic close: read first, lock the day, reject if any ledger changed.
CREATE TABLE report_versions(clinic_id uuid PRIMARY KEY REFERENCES clinics(id),version bigint NOT NULL DEFAULT 0);
INSERT INTO report_versions(clinic_id) SELECT id FROM clinics;
CREATE FUNCTION report_ledger_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO report_versions(clinic_id,version) VALUES(NEW.clinic_id,1)
    ON CONFLICT(clinic_id) DO UPDATE SET version=report_versions.version+1;
  RETURN NEW;
END $$;
DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['visits','charge_lines','report_charge_dates','discounts','payments','payment_allocations','cashier_allocation_adjustments','cash_outs','cash_shifts'] LOOP
    EXECUTE format('CREATE TRIGGER report_ledger_changed AFTER INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION report_ledger_changed()',tab);
  END LOOP;
END $$;

-- A future rule may be corrected. Audit keeps both versions; referenced/current rules cannot change.
DROP TRIGGER doctor_split_rules_append_only ON doctor_split_rules;
CREATE FUNCTION payroll_future_rule_correction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE today date;
BEGIN
  SELECT (now() AT TIME ZONE timezone)::date INTO today FROM clinics WHERE id=OLD.clinic_id;
  IF TG_OP='DELETE' OR OLD.effective_from<=today OR NEW.effective_from<>OLD.effective_from
    OR NEW.clinic_id<>OLD.clinic_id OR NEW.user_id<>OLD.user_id OR NEW.id<>OLD.id
    OR EXISTS(SELECT 1 FROM payroll_lines WHERE clinic_id=OLD.clinic_id AND rule_id=OLD.id)
    OR EXISTS(SELECT 1 FROM payroll_periods WHERE clinic_id=OLD.clinic_id AND status='final' AND to_date>=OLD.effective_from)
    THEN RAISE EXCEPTION 'past and current rules are immutable (append-only)' USING ERRCODE='restrict_violation'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER doctor_split_rules_future_only BEFORE UPDATE OR DELETE ON doctor_split_rules FOR EACH ROW EXECUTE FUNCTION payroll_future_rule_correction();

-- Approval attempts never alter the shared-PC sign-in PIN counter.
CREATE TABLE cashier_approval_attempts (
  clinic_id uuid NOT NULL REFERENCES clinics(id), approver_id uuid NOT NULL REFERENCES accounts(id),
  device_key text NOT NULL, failed_attempts integer NOT NULL DEFAULT 0 CHECK(failed_attempts BETWEEN 0 AND 5),
  locked_until timestamptz, PRIMARY KEY(clinic_id,approver_id,device_key)
);
ALTER TABLE report_notices ADD COLUMN attempts integer NOT NULL DEFAULT 0;
ALTER TABLE report_notices ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE report_notices ADD COLUMN completed_at timestamptz;
ALTER TABLE report_notices ADD COLUMN delivered_chats text[] NOT NULL DEFAULT '{}';
-- Retain historical at-most-once deliveries; retry previously failed notices.
UPDATE report_notices SET completed_at=attempted_at WHERE attempted_at IS NOT NULL AND failed=0;
CREATE INDEX report_notices_pending ON report_notices(next_attempt_at) WHERE completed_at IS NULL;
-- Exact discount apportionment for a doctor's scoped read. Sibling weights stay in SQL;
-- other doctors' lines never enter the application result. Mirrors billing/invoice.ts.
CREATE FUNCTION report_line_discounts(c uuid,v uuid,day date)
RETURNS TABLE(charge_line_id uuid,discount_uzs numeric) LANGUAGE sql STABLE AS $$
WITH active_discounts AS (
  SELECT d.* FROM discounts d JOIN clinics cl ON cl.id=d.clinic_id
  WHERE d.clinic_id=c AND d.visit_id=v AND (d.created_at AT TIME ZONE cl.timezone)::date<=day
    AND (d.voided_at IS NULL OR (d.voided_at AT TIME ZONE cl.timezone)::date>day)
), prices AS (
  SELECT l.id,CASE WHEN l.status='cancelled' AND (l.cancelled_at AT TIME ZONE cl.timezone)::date<=day
    THEN 0::numeric ELSE l.unit_price_uzs::numeric*l.quantity END value
  FROM charge_lines l JOIN clinics cl ON cl.id=l.clinic_id
  JOIN report_charge_dates r ON r.clinic_id=l.clinic_id AND r.charge_line_id=l.id
  WHERE l.clinic_id=c AND l.visit_id=v AND r.business_date<=day
), line_parts AS (
  SELECT p.*,coalesce(CASE WHEN d.kind='fixed' THEN least(p.value,d.amount_uzs)
    ELSE floor(p.value*d.percent_bp/10000) END,0) direct FROM prices p
  LEFT JOIN active_discounts d ON d.charge_line_id=p.id
), bases AS (
  SELECT *,value-direct base,sum(value-direct) OVER() total FROM line_parts
), quotas AS (
  SELECT b.*,coalesce(CASE WHEN d.kind='fixed' THEN least(b.total,d.amount_uzs)
    ELSE floor(b.total*d.percent_bp/10000) END,0) amount FROM bases b
  LEFT JOIN active_discounts d ON d.charge_line_id IS NULL
), parts AS (
  SELECT *,coalesce(floor(amount*base/nullif(total,0)),0) part,
    row_number() OVER(ORDER BY mod(amount*base,nullif(total,0)) DESC NULLS LAST,id) rank FROM quotas
)
SELECT id,direct+part+CASE WHEN base>0 AND rank<=amount-sum(part) OVER() THEN 1 ELSE 0 END FROM parts;
$$;
CREATE INDEX report_charge_cancelled ON charge_lines(clinic_id,cancelled_at) WHERE cancelled_at IS NOT NULL;
CREATE INDEX report_discount_activity ON discounts(clinic_id,created_at);
CREATE INDEX report_discount_voided ON discounts(clinic_id,voided_at) WHERE voided_at IS NOT NULL;
CREATE INDEX report_adjustment_activity ON cashier_allocation_adjustments(clinic_id,created_at);
CREATE INDEX report_doctor_lines ON charge_lines(clinic_id,performer_user_id,visit_id);
