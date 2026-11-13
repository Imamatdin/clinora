-- Task 022: audit fixes for security and access.

-- 1. Approval PINs. One failure counter per approver for every device, session, cashier approval and ward
-- override. Five failures lock approval until a CEO or another administrator clears it; no time expiry.
-- The task 021/020 per-device tables (cashier_approval_attempts, ward_override_attempts) are no longer read.
CREATE TABLE approval_pin_attempts (
  account_id uuid PRIMARY KEY REFERENCES accounts(id),
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 5),
  locked_at timestamptz,
  CHECK ((locked_at IS NOT NULL) = (failed_attempts = 5))
);
-- Digits in the current PIN. NULL for PINs set before this migration (length unknown from the hash): a CEO or
-- administrator with a NULL or shorter-than-6 PIN must set a new one before approving anything.
ALTER TABLE account_pins ADD COLUMN pin_digits smallint CHECK (pin_digits BETWEEN 4 AND 6);

-- 4. Notices to a staff member about their own account (shown on next sign-in and sent once to Telegram), and
-- CEO confirmation of an administrator's credential reset for a doctor.
CREATE TABLE account_notices (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  clinic_id uuid NOT NULL REFERENCES clinics(id),
  kind text NOT NULL CHECK (kind IN ('password_reset','telegram_invite','approval_locked','credential_request')),
  actor_id uuid REFERENCES accounts(id),
  actor_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  seen_at timestamptz,
  -- The Telegram chat linked when the notice was made: a re-link right after an invite cannot redirect it.
  telegram_chat bigint,
  telegram_done_at timestamptz,
  telegram_attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_notices_unseen ON account_notices(account_id, created_at) WHERE seen_at IS NULL;
CREATE INDEX account_notices_telegram ON account_notices(next_attempt_at) WHERE telegram_done_at IS NULL;

CREATE TABLE credential_requests (
  id uuid PRIMARY KEY,
  clinic_id uuid NOT NULL REFERENCES clinics(id),
  target_id uuid NOT NULL REFERENCES accounts(id),
  kind text NOT NULL CHECK (kind IN ('password','telegram')),
  requested_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  confirmed_by uuid REFERENCES accounts(id),
  confirmed_at timestamptz,
  used_at timestamptz,
  CHECK ((confirmed_by IS NULL) = (confirmed_at IS NULL)),
  CHECK (used_at IS NULL OR confirmed_at IS NOT NULL)
);
CREATE INDEX credential_requests_open ON credential_requests(clinic_id, target_id, kind, requested_by) WHERE used_at IS NULL;

-- 5 and 6. Clinic settings: how long routing access lasts after the visit closes, and Telegram voice capture.
ALTER TABLE clinic_settings ADD COLUMN assignment_days integer NOT NULL DEFAULT 30 CHECK (assignment_days BETWEEN 0 AND 3650);
ALTER TABLE clinic_settings ADD COLUMN telegram_voice boolean NOT NULL DEFAULT false;

-- 5. A routing grant belongs to the visit it was made for. Re-routing moves it to the new visit.
ALTER TABLE patient_assignments ADD COLUMN visit_id uuid,
  ADD COLUMN granted_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT patient_assignments_visit_fk FOREIGN KEY (clinic_id, patient_id, visit_id) REFERENCES visits(clinic_id, patient_id, id);
-- Existing grants attach to the patient's latest visit; grants without any visit (notebook era) count from now.
UPDATE patient_assignments pa SET visit_id=(SELECT v.id FROM visits v WHERE v.clinic_id=pa.clinic_id AND v.patient_id=pa.patient_id
  ORDER BY v.created_at DESC, v.id DESC LIMIT 1);

-- The one rule for "is this routing grant still valid": the visit is open, or closed less than the clinic's
-- window ago, or the patient is admitted now. A grant without a visit lasts the window from when it was made.
CREATE FUNCTION patient_access_active(c uuid, p uuid, u uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM patient_assignments pa
    JOIN clinic_settings s ON s.clinic_id=pa.clinic_id
    LEFT JOIN visits v ON v.clinic_id=pa.clinic_id AND v.id=pa.visit_id
    WHERE pa.clinic_id=c AND pa.patient_id=p AND pa.user_id=u AND (
      (pa.visit_id IS NULL AND pa.granted_at > now() - make_interval(days => s.assignment_days))
      OR v.status='open'
      OR v.closed_at > now() - make_interval(days => s.assignment_days)
      OR EXISTS (SELECT 1 FROM admissions a JOIN visits av ON av.clinic_id=a.clinic_id AND av.id=a.visit_id
        WHERE a.clinic_id=c AND av.patient_id=p AND a.status='admitted')))
$$;

-- 7. Rule rejections answer 409 (server/database.ts isRuleViolation). The two oldest guards raised a plain
-- exception (SQLSTATE P0001, the same code as any unexpected failure); give them restrict_violation like the rest.
CREATE OR REPLACE FUNCTION immutable_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Append-only clinical revisions' USING ERRCODE = 'restrict_violation'; END $$;
CREATE OR REPLACE FUNCTION business_day_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Business days are never deleted' USING ERRCODE = 'restrict_violation'; END IF;
  IF OLD.status = 'closed' THEN RAISE EXCEPTION 'A closed business day is immutable' USING ERRCODE = 'restrict_violation'; END IF;
  IF NEW.id <> OLD.id OR NEW.clinic_id <> OLD.clinic_id OR NEW.business_date <> OLD.business_date
     OR NEW.opened_by <> OLD.opened_by OR NEW.opened_at <> OLD.opened_at THEN
    RAISE EXCEPTION 'Business day identity is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
