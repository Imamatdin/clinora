-- Refunds and later corrections can reduce a period's earned entitlement.
ALTER TABLE payroll_lines DROP CONSTRAINT payroll_lines_entitlement_uzs_check;
ALTER TABLE payroll_lines DROP CONSTRAINT payroll_lines_from_receipts_uzs_check;
ALTER TABLE payroll_lines DROP CONSTRAINT payroll_lines_clinic_funded_uzs_check;
ALTER TABLE payroll_lines ADD CONSTRAINT payroll_components_balance CHECK (entitlement_uzs=from_receipts_uzs+clinic_funded_uzs);
ALTER TABLE payroll_periods ADD COLUMN daily_snapshot jsonb;

-- A committed close freezes all day-owned financial inputs. The same day lock serializes
-- shift creation/payment with close, including writes from future feature modules.
CREATE FUNCTION reports_open_day() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE day_id uuid; state text;
BEGIN
  IF TG_TABLE_NAME IN ('cash_shifts','payments','cash_outs','visits') THEN
    day_id := NEW.business_day_id;
  ELSE
    SELECT business_day_id INTO day_id FROM visits WHERE clinic_id=NEW.clinic_id AND id=NEW.visit_id;
  END IF;
  SELECT status INTO state FROM business_days WHERE clinic_id=NEW.clinic_id AND id=day_id FOR SHARE;
  -- Missing/cross-clinic references are rejected by their original qualified foreign key.
  IF state IS NOT NULL AND state <> 'open' THEN RAISE EXCEPTION 'business day is closed' USING ERRCODE='restrict_violation'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reports_shift_day BEFORE INSERT ON cash_shifts FOR EACH ROW EXECUTE FUNCTION reports_open_day();
CREATE TRIGGER reports_payment_day BEFORE INSERT ON payments FOR EACH ROW EXECUTE FUNCTION reports_open_day();
CREATE TRIGGER reports_out_day BEFORE INSERT ON cash_outs FOR EACH ROW EXECUTE FUNCTION reports_open_day();
CREATE TRIGGER reports_visit_day BEFORE INSERT ON visits FOR EACH ROW EXECUTE FUNCTION reports_open_day();
CREATE TRIGGER reports_charge_day BEFORE INSERT OR UPDATE ON charge_lines FOR EACH ROW EXECUTE FUNCTION reports_open_day();
CREATE TRIGGER reports_discount_day BEFORE INSERT OR UPDATE ON discounts FOR EACH ROW EXECUTE FUNCTION reports_open_day();

CREATE TABLE report_notices (
  id uuid PRIMARY KEY,clinic_id uuid NOT NULL REFERENCES clinics(id),business_day_id uuid NOT NULL,
  totals jsonb NOT NULL, attempted_at timestamptz, sent integer, failed integer,
  UNIQUE(clinic_id,business_day_id), FOREIGN KEY(clinic_id,business_day_id) REFERENCES business_days(clinic_id,id)
);
