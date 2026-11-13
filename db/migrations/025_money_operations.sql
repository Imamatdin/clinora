-- Task 023: audit fixes, money and daily operations.

-- 1. A bed or caretaker day that cannot be priced is skipped and flagged, never fails the day open.
CREATE TABLE inpatient_attention (
  id uuid PRIMARY KEY, clinic_id uuid NOT NULL REFERENCES clinics(id), admission_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('bed','caretaker')), charge_date date NOT NULL,
  service_id uuid NOT NULL, caretaker_id uuid, quantity integer NOT NULL CHECK (quantity > 0),
  priced_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz,
  FOREIGN KEY (clinic_id, admission_id) REFERENCES admissions(clinic_id, id),
  FOREIGN KEY (clinic_id, service_id) REFERENCES services(clinic_id, id),
  CHECK ((kind = 'caretaker') = (caretaker_id IS NOT NULL))
);
CREATE UNIQUE INDEX inpatient_attention_once ON inpatient_attention(admission_id, kind, charge_date, coalesce(caretaker_id, admission_id));
CREATE INDEX inpatient_attention_open ON inpatient_attention(clinic_id) WHERE resolved_at IS NULL;
CREATE TRIGGER inpatient_attention_no_delete BEFORE DELETE ON inpatient_attention FOR EACH ROW EXECUTE FUNCTION core_no_delete();

-- 2. A lab line's performer is the ordering doctor (or none when ordered at registration), never the
-- technician who confirmed it. Lines already in a final payroll period keep their recorded performer.
ALTER TABLE charge_lines DISABLE TRIGGER charge_lines_guard;
ALTER TABLE charge_lines DISABLE TRIGGER reports_charge_activity;
ALTER TABLE charge_lines DISABLE TRIGGER report_ledger_changed;
UPDATE charge_lines l SET performer_user_id = x.target
FROM (SELECT l.id, CASE WHEN l.source = 'doctor' AND EXISTS (SELECT 1 FROM membership_roles r
        WHERE r.clinic_id = l.clinic_id AND r.user_id = l.created_by AND r.role = 'doctor') THEN l.created_by END target
      FROM charge_lines l JOIN services s ON s.clinic_id = l.clinic_id AND s.id = l.service_id AND s.kind = 'lab') x
WHERE l.id = x.id AND l.performer_user_id IS DISTINCT FROM x.target
  AND NOT EXISTS (SELECT 1 FROM payroll_lines p WHERE p.clinic_id = l.clinic_id AND p.charge_line_id = l.id);
ALTER TABLE charge_lines ENABLE TRIGGER charge_lines_guard;
ALTER TABLE charge_lines ENABLE TRIGGER reports_charge_activity;
ALTER TABLE charge_lines ENABLE TRIGGER report_ledger_changed;

-- 3. Cancelling an unpaid line may reallocate earlier receipts across a visit-level discount.
ALTER TABLE cashier_allocation_adjustments ALTER COLUMN discount_id DROP NOT NULL;
ALTER TABLE cashier_allocation_adjustments ADD COLUMN cancelled_line_id uuid;
ALTER TABLE cashier_allocation_adjustments ADD CONSTRAINT cashier_adjustments_cancelled_line
  FOREIGN KEY (clinic_id, cancelled_line_id) REFERENCES charge_lines(clinic_id, id);
ALTER TABLE cashier_allocation_adjustments ADD CONSTRAINT cashier_adjustments_cause
  CHECK ((discount_id IS NULL) <> (cancelled_line_id IS NULL));

-- 4. Cash-outs: one row per press, approver recorded, clinic threshold (0 = every cash-out needs approval).
ALTER TABLE cash_outs ADD COLUMN idempotency_key text CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 8 AND 200);
ALTER TABLE cash_outs ADD COLUMN approved_by uuid REFERENCES accounts(id);
CREATE UNIQUE INDEX cash_outs_idempotency ON cash_outs(clinic_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
ALTER TABLE clinic_settings ADD COLUMN cash_out_approval_threshold_uzs bigint NOT NULL DEFAULT 0 CHECK (cash_out_approval_threshold_uzs >= 0);

-- 5. The CEO can reopen today's most recent closed day. Every earlier close snapshot is kept.
CREATE TABLE business_day_close_versions (
  id uuid PRIMARY KEY, clinic_id uuid NOT NULL REFERENCES clinics(id), business_day_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0), close_snapshot jsonb NOT NULL,
  closed_by uuid NOT NULL REFERENCES accounts(id), closed_at timestamptz NOT NULL,
  reopened_by uuid NOT NULL REFERENCES accounts(id), reopened_at timestamptz NOT NULL DEFAULT now(),
  reopen_reason text NOT NULL CHECK (btrim(reopen_reason) <> ''),
  UNIQUE (business_day_id, version),
  FOREIGN KEY (clinic_id, business_day_id) REFERENCES business_days(clinic_id, id)
);
CREATE TRIGGER business_day_close_versions_append_only BEFORE UPDATE OR DELETE ON business_day_close_versions
  FOR EACH ROW EXECUTE FUNCTION core_append_only();
-- A closed day stays immutable except for the one audited reopen path, which sets a transaction-local flag
-- naming the day and must have archived the snapshot first.
CREATE OR REPLACE FUNCTION business_day_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Business days are never deleted'; END IF;
  IF NEW.id <> OLD.id OR NEW.clinic_id <> OLD.clinic_id OR NEW.business_date <> OLD.business_date
     OR NEW.opened_by <> OLD.opened_by OR NEW.opened_at <> OLD.opened_at THEN
    RAISE EXCEPTION 'Business day identity is immutable';
  END IF;
  IF OLD.status = 'closed' THEN
    IF NEW.status = 'open' AND coalesce(current_setting('clinora.reopen_day', true), '') = OLD.id::text
       AND EXISTS (SELECT 1 FROM business_day_close_versions v WHERE v.business_day_id = OLD.id AND v.closed_at = OLD.closed_at) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'A closed business day is immutable';
  END IF;
  RETURN NEW;
END $$;
