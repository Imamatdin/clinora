-- Inpatient owns these additions; the shared core schema remains unchanged.
CREATE TABLE inpatient_rule_history (
  sequence bigserial PRIMARY KEY,
  clinic_id uuid NOT NULL REFERENCES clinics(id),
  effective_date date NOT NULL,
  rule jsonb NOT NULL,
  changed_by uuid REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO inpatient_rule_history(clinic_id,effective_date,rule,changed_by)
SELECT clinic_id,'0001-01-01',bed_day_rule,updated_by FROM clinic_settings;
CREATE TRIGGER inpatient_rules_immutable BEFORE UPDATE OR DELETE ON inpatient_rule_history
  FOR EACH ROW EXECUTE FUNCTION core_append_only();
CREATE FUNCTION inpatient_track_rule() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    INSERT INTO inpatient_rule_history(clinic_id,effective_date,rule,changed_by)
      VALUES(NEW.clinic_id,'0001-01-01',NEW.bed_day_rule,NEW.updated_by);
  ELSIF NEW.bed_day_rule IS DISTINCT FROM OLD.bed_day_rule THEN
    INSERT INTO inpatient_rule_history(clinic_id,effective_date,rule,changed_by)
      SELECT NEW.clinic_id,(now() AT TIME ZONE timezone)::date+1,NEW.bed_day_rule,NEW.updated_by
      FROM clinics WHERE id=NEW.clinic_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inpatient_rule_settings AFTER INSERT OR UPDATE ON clinic_settings
  FOR EACH ROW EXECUTE FUNCTION inpatient_track_rule();
CREATE TABLE inpatient_requests (
  clinic_id uuid NOT NULL REFERENCES clinics(id), actor_id uuid NOT NULL REFERENCES accounts(id),
  key uuid NOT NULL, payload jsonb NOT NULL, result jsonb NOT NULL,
  PRIMARY KEY(clinic_id,actor_id,key)
);
CREATE TRIGGER inpatient_requests_immutable BEFORE UPDATE OR DELETE ON inpatient_requests
  FOR EACH ROW EXECUTE FUNCTION core_append_only();
CREATE TABLE inpatient_discharge_invoices (
  clinic_id uuid NOT NULL REFERENCES clinics(id), admission_id uuid PRIMARY KEY,
  snapshot jsonb NOT NULL, issued_by uuid NOT NULL REFERENCES accounts(id), issued_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(clinic_id,admission_id) REFERENCES admissions(clinic_id,id)
);
CREATE TRIGGER inpatient_invoices_immutable BEFORE UPDATE OR DELETE ON inpatient_discharge_invoices
  FOR EACH ROW EXECUTE FUNCTION core_append_only();
