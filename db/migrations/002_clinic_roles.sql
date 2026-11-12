-- Task 003A (increment C1): clinic roles, staff sign-in by login or phone, business days.

-- Clinics work in their own calendar; the business date is derived on the server.
ALTER TABLE clinics ADD COLUMN timezone text NOT NULL DEFAULT 'Asia/Tashkent';

-- Staff accounts: login and phone sign-in, email optional.
ALTER TABLE accounts ALTER COLUMN email DROP NOT NULL;
ALTER TABLE accounts ADD COLUMN login text UNIQUE
  CHECK (login = lower(login) AND login ~ '^[a-z0-9._-]{3,40}$' AND login ~ '[a-z]');
ALTER TABLE accounts ADD COLUMN phone text UNIQUE CHECK (phone ~ '^\+[1-9][0-9]{7,14}$');
ALTER TABLE accounts ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;
-- Set for accounts a clinic created through staff management. Only that clinic may
-- reset the password or block the account itself; other members are managed per membership.
ALTER TABLE accounts ADD COLUMN managed_by_clinic_id uuid REFERENCES clinics(id);
ALTER TABLE accounts ADD CONSTRAINT account_has_identifier CHECK (email IS NOT NULL OR login IS NOT NULL OR phone IS NOT NULL);

-- Roles live in membership_roles. memberships.role is legacy and no longer read for clinic routes.
ALTER TABLE memberships ALTER COLUMN role SET DEFAULT 'administrator';
CREATE TABLE membership_roles (
  clinic_id uuid NOT NULL, user_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('ceo','administrator','registrar','doctor','laboratory','cashier','inpatient')),
  granted_by uuid NOT NULL REFERENCES accounts(id), granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clinic_id, user_id, role),
  FOREIGN KEY (clinic_id, user_id) REFERENCES memberships(clinic_id, user_id) ON DELETE CASCADE
);
INSERT INTO membership_roles(clinic_id,user_id,role,granted_by)
  SELECT clinic_id,user_id,'administrator',granted_by FROM memberships WHERE role='administrator';
INSERT INTO membership_roles(clinic_id,user_id,role,granted_by)
  SELECT clinic_id,user_id,'doctor',granted_by FROM memberships WHERE role='clinician';
INSERT INTO membership_roles(clinic_id,user_id,role,granted_by)
  SELECT clinic_id,user_id,'ceo',granted_by FROM memberships WHERE is_owner
  ON CONFLICT DO NOTHING;

-- Business days: one open day per clinic, history never rewritten.
CREATE TABLE business_days (
  id uuid PRIMARY KEY, clinic_id uuid NOT NULL REFERENCES clinics(id), business_date date NOT NULL,
  status text NOT NULL CHECK (status IN ('open','closed')),
  opened_by uuid NOT NULL REFERENCES accounts(id), opened_at timestamptz NOT NULL DEFAULT now(),
  closed_by uuid REFERENCES accounts(id), closed_at timestamptz, close_snapshot jsonb,
  UNIQUE (clinic_id, business_date), UNIQUE (clinic_id, id),
  CHECK ((status='open' AND closed_by IS NULL AND closed_at IS NULL AND close_snapshot IS NULL)
      OR (status='closed' AND closed_by IS NOT NULL AND closed_at IS NOT NULL AND close_snapshot IS NOT NULL))
);
CREATE UNIQUE INDEX business_days_one_open ON business_days(clinic_id) WHERE status='open';
CREATE FUNCTION business_day_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Business days are never deleted'; END IF;
  IF OLD.status = 'closed' THEN RAISE EXCEPTION 'A closed business day is immutable'; END IF;
  IF NEW.id <> OLD.id OR NEW.clinic_id <> OLD.clinic_id OR NEW.business_date <> OLD.business_date
     OR NEW.opened_by <> OLD.opened_by OR NEW.opened_at <> OLD.opened_at THEN
    RAISE EXCEPTION 'Business day identity is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_day_guard BEFORE UPDATE OR DELETE ON business_days FOR EACH ROW EXECUTE FUNCTION business_day_guard();

-- Non-identifying change detail (for example role names before and after). Never patient data or secrets.
ALTER TABLE audit_events ADD COLUMN detail jsonb;
CREATE INDEX audit_clinic_time ON audit_events(clinic_id, created_at);
