-- Task 017 (open item c from task 010): lab results confirmed after their business day is closed.
-- The charge line keeps its value and service date (the closed day's snapshot already counts it as ordered and is
-- never rewritten); the completion is posted to the business day open at confirmation, recorded here with a
-- reference to the original visit day. With no day open, the confirmation waits and posts when the next day opens.
ALTER TABLE charge_lines ADD COLUMN completed_business_day_id uuid;
ALTER TABLE charge_lines ADD CONSTRAINT charge_lines_completed_day_fk
  FOREIGN KEY (clinic_id, completed_business_day_id) REFERENCES business_days(clinic_id, id);

CREATE TABLE lab_pending_confirmations (
  charge_line_id uuid PRIMARY KEY,
  clinic_id uuid NOT NULL REFERENCES clinics(id),
  result_version integer NOT NULL CHECK (result_version > 0),
  requested_by uuid NOT NULL REFERENCES accounts(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  posted_business_day_id uuid,
  posted_at timestamptz,
  FOREIGN KEY (clinic_id, charge_line_id) REFERENCES charge_lines(clinic_id, id),
  FOREIGN KEY (clinic_id, posted_business_day_id) REFERENCES business_days(clinic_id, id),
  CHECK ((posted_business_day_id IS NULL) = (posted_at IS NULL))
);
CREATE INDEX lab_pending_unposted ON lab_pending_confirmations(clinic_id) WHERE posted_at IS NULL;
