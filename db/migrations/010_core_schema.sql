-- Task 008: core schema for the clinic management system. Implements docs/DATA-MODEL.md.
-- Conventions: every table carries clinic_id and UNIQUE (clinic_id, id); references between clinic
-- rows are clinic-qualified (clinic_id, x_id) so a row of clinic A cannot point at a row of clinic B.
-- Money is bigint whole UZS (*_uzs), shares are basis points (*_bp). Nothing financial or clinical is
-- deleted; append-only and status rules are enforced by triggers below, not only in application code.

------------------------------------------------------------------------------------------------
-- Shared trigger functions
------------------------------------------------------------------------------------------------
CREATE FUNCTION core_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation'; END $$;

CREATE FUNCTION core_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% rows are never deleted', TG_TABLE_NAME USING ERRCODE = 'restrict_violation'; END $$;

-- Columns named in TG_ARGV may not change on UPDATE.
CREATE FUNCTION core_freeze_columns() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE col text; o jsonb := to_jsonb(OLD); n jsonb := to_jsonb(NEW);
BEGIN
  FOREACH col IN ARRAY TG_ARGV LOOP
    IF (o -> col) IS DISTINCT FROM (n -> col) THEN
      RAISE EXCEPTION '%.% is immutable', TG_TABLE_NAME, col USING ERRCODE = 'restrict_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

-- TG_ARGV[0] = column holding a service id (nullable), TG_ARGV[1] = required services.kind,
-- or '@stock' to require services.track_stock. Checked on INSERT and when the column changes.
CREATE FUNCTION core_require_service_kind() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sid uuid := (to_jsonb(NEW) ->> TG_ARGV[0])::uuid; ok boolean;
BEGIN
  IF sid IS NULL THEN RETURN NEW; END IF;
  IF TG_ARGV[1] = '@stock' THEN
    SELECT track_stock INTO ok FROM services WHERE clinic_id = NEW.clinic_id AND id = sid;
  ELSE
    SELECT kind = TG_ARGV[1] INTO ok FROM services WHERE clinic_id = NEW.clinic_id AND id = sid;
  END IF;
  IF ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION '%.% must reference a % service', TG_TABLE_NAME, TG_ARGV[0], TG_ARGV[1] USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- Generic status machine. TG_ARGV holds allowed 'from>to' pairs. Same-status updates pass.
CREATE FUNCTION core_status_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status || '>' || NEW.status) = ANY (TG_ARGV) THEN
    RAISE EXCEPTION '% status % -> % not allowed', TG_TABLE_NAME, OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

------------------------------------------------------------------------------------------------
-- Existing tables: additions
------------------------------------------------------------------------------------------------
ALTER TABLE accounts ADD COLUMN locale text CHECK (locale IN ('uz-Cyrl','uz-Latn','ru'));
ALTER TABLE documents ADD CONSTRAINT documents_clinic_id_id_key UNIQUE (clinic_id, id);

CREATE TABLE clinic_settings (
  clinic_id uuid PRIMARY KEY REFERENCES clinics(id),
  default_locale text NOT NULL DEFAULT 'uz-Cyrl' CHECK (default_locale IN ('uz-Cyrl','uz-Latn','ru')),
  bed_day_rule jsonb NOT NULL DEFAULT '{"countAdmissionDay":true,"countDischargeDay":false,"minimumDays":1}'
    CHECK (jsonb_typeof(bed_day_rule->'countAdmissionDay') = 'boolean' AND jsonb_typeof(bed_day_rule->'countDischargeDay') = 'boolean'
       AND jsonb_typeof(bed_day_rule->'minimumDays') = 'number'),
  receipt_header jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(receipt_header) = 'object'),
  updated_by uuid REFERENCES accounts(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO clinic_settings(clinic_id) SELECT id FROM clinics;

------------------------------------------------------------------------------------------------
-- Catalog
------------------------------------------------------------------------------------------------
CREATE TABLE departments (
  id uuid PRIMARY KEY, clinic_id uuid NOT NULL REFERENCES clinics(id),
  name_uz_cyrl text NOT NULL CHECK (btrim(name_uz_cyrl) <> ''), name_uz_latn text, name_ru text, code_1c text,
  is_active boolean NOT NULL DEFAULT true,
  UNIQUE (clinic_id, id)
);
CREATE UNIQUE INDEX departments_code_1c ON departments(clinic_id, code_1c) WHERE code_1c IS NOT NULL;

CREATE TABLE service_groups (
  id uuid PRIMARY KEY, clinic_id uuid NOT NULL REFERENCES clinics(id), department_id uuid,
  name_uz_cyrl text NOT NULL CHECK (btrim(name_uz_cyrl) <> ''), name_uz_latn text, name_ru text, code_1c text,
  is_active boolean NOT NULL DEFAULT true,
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, department_id) REFERENCES departments(clinic_id, id)
);
CREATE UNIQUE INDEX service_groups_code_1c ON service_groups(clinic_id, code_1c) WHERE code_1c IS NOT NULL;

CREATE TABLE services (
  id uuid PRIMARY KEY, clinic_id uuid NOT NULL REFERENCES clinics(id), group_id uuid, department_id uuid,
  kind text NOT NULL CHECK (kind IN ('consultation','procedure','lab','diagnostic','bed','surgery','medicine','good','caretaker','other')),
  name_uz_cyrl text NOT NULL CHECK (btrim(name_uz_cyrl) <> ''), name_uz_latn text, name_ru text, code_1c text,
  unit text NOT NULL DEFAULT 'дона' CHECK (btrim(unit) <> ''),
  track_stock boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, group_id) REFERENCES service_groups(clinic_id, id),
  FOREIGN KEY (clinic_id, department_id) REFERENCES departments(clinic_id, id)
);
CREATE UNIQUE INDEX services_code_1c ON services(clinic_id, code_1c) WHERE code_1c IS NOT NULL;
-- A service's kind decides which tables may reference it; changing it later would orphan that meaning.
CREATE TRIGGER services_freeze BEFORE UPDATE ON services FOR EACH ROW EXECUTE FUNCTION core_freeze_columns('id','clinic_id','kind');
CREATE TRIGGER services_no_delete BEFORE DELETE ON services FOR EACH ROW EXECUTE FUNCTION core_no_delete();

CREATE TABLE service_prices (
  id uuid PRIMARY KEY, clinic_id uuid NOT NULL REFERENCES clinics(id), service_id uuid NOT NULL,
  price_uzs bigint NOT NULL CHECK (price_uzs >= 0),
  effective_from timestamptz NOT NULL,
  set_by uuid NOT NULL REFERENCES accounts(id), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, id), UNIQUE (clinic_id, service_id, effective_from),
  FOREIGN KEY (clinic_id, service_id) REFERENCES services(clinic_id, id)
);
CREATE TRIGGER service_prices_append_only BEFORE UPDATE OR DELETE ON service_prices FOR EACH ROW EXECUTE FUNCTION core_append_only();

CREATE TABLE doctor_profiles (
  clinic_id uuid NOT NULL REFERENCES clinics(id), user_id uuid NOT NULL, department_id uuid,
  specialty_uz_cyrl text NOT NULL CHECK (btrim(specialty_uz_cyrl) <> ''), specialty_uz_latn text, specialty_ru text,
  is_active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (clinic_id, user_id),
  FOREIGN KEY (clinic_id, user_id) REFERENCES memberships(clinic_id, user_id),
  FOREIGN KEY (clinic_id, department_id) REFERENCES departments(clinic_id, id)
);

CREATE TABLE doctor_services (
  clinic_id uuid NOT NULL REFERENCES clinics(id), user_id uuid NOT NULL, service_id uuid NOT NULL,
  PRIMARY KEY (clinic_id, user_id, service_id),
  FOREIGN KEY (clinic_id, user_id) REFERENCES doctor_profiles(clinic_id, user_id),
  FOREIGN KEY (clinic_id, service_id) REFERENCES services(clinic_id, id)
);

CREATE TABLE districts (
  id uuid PRIMARY KEY, clinic_id uuid NOT NULL REFERENCES clinics(id),
  name_uz_cyrl text NOT NULL CHECK (btrim(name_uz_cyrl) <> ''), name_uz_latn text, name_ru text, code_1c text,
  UNIQUE (clinic_id, id)
);
CREATE TABLE mahallas (
  id uuid PRIMARY KEY, clinic_id uuid NOT NULL REFERENCES clinics(id), district_id uuid NOT NULL,
  name_uz_cyrl text NOT NULL CHECK (btrim(name_uz_cyrl) <> ''), name_uz_latn text, name_ru text, code_1c text,
  UNIQUE (clinic_id, id), UNIQUE (clinic_id, district_id, id),
  FOREIGN KEY (clinic_id, district_id) REFERENCES districts(clinic_id, id)
);

CREATE TABLE room_types (
  id uuid PRIMARY KEY, clinic_id uuid NOT NULL REFERENCES clinics(id),
  name_uz_cyrl text NOT NULL CHECK (btrim(name_uz_cyrl) <> ''), name_uz_latn text, name_ru text, code_1c text,
  UNIQUE (clinic_id, id)
);
CREATE TABLE rooms (
  id uuid PRIMARY KEY, clinic_id uuid NOT NULL REFERENCES clinics(id), department_id uuid, room_type_id uuid,
  name text NOT NULL CHECK (btrim(name) <> ''), is_active boolean NOT NULL DEFAULT true,
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, department_id) REFERENCES departments(clinic_id, id),
  FOREIGN KEY (clinic_id, room_type_id) REFERENCES room_types(clinic_id, id)
);
CREATE TABLE beds (
  id uuid PRIMARY KEY, clinic_id uuid NOT NULL REFERENCES clinics(id), room_id uuid NOT NULL,
  label text NOT NULL CHECK (btrim(label) <> ''), bed_service_id uuid NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  UNIQUE (clinic_id, id), UNIQUE (room_id, label),
  FOREIGN KEY (clinic_id, room_id) REFERENCES rooms(clinic_id, id),
  FOREIGN KEY (clinic_id, bed_service_id) REFERENCES services(clinic_id, id)
);
CREATE TRIGGER beds_service_kind BEFORE INSERT OR UPDATE OF bed_service_id ON beds
  FOR EACH ROW EXECUTE FUNCTION core_require_service_kind('bed_service_id', 'bed');

CREATE TABLE expense_types (
  id uuid PRIMARY KEY, clinic_id uuid NOT NULL REFERENCES clinics(id),
  name_uz_cyrl text NOT NULL CHECK (btrim(name_uz_cyrl) <> ''), name_uz_latn text, name_ru text, code_1c text,
  is_active boolean NOT NULL DEFAULT true,
  UNIQUE (clinic_id, id)
);

------------------------------------------------------------------------------------------------
-- Patients and registration
------------------------------------------------------------------------------------------------
CREATE TABLE patient_counters (
  clinic_id uuid PRIMARY KEY REFERENCES clinics(id),
  last_no integer NOT NULL DEFAULT 0 CHECK (last_no >= 0)
);

ALTER TABLE patients
  ADD COLUMN patient_no integer CHECK (patient_no > 0),
  ADD COLUMN full_name text,
  ADD COLUMN birth_date date,
  ADD COLUMN gender text CHECK (gender IN ('male','female')),
  ADD COLUMN phone text CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  ADD COLUMN district_id uuid,
  ADD COLUMN mahalla_id uuid,
  ADD COLUMN address text,
  ADD COLUMN source text;

-- Existing patients: numbers in creation order per clinic; full name from the notebook display name.
UPDATE patients p SET patient_no = s.rn, full_name = p.display_name, birth_date = p.date_of_birth
  FROM (SELECT id, row_number() OVER (PARTITION BY clinic_id ORDER BY created_at, id) AS rn FROM patients) s
 WHERE p.id = s.id;
INSERT INTO patient_counters(clinic_id, last_no) SELECT c.id, coalesce(max(p.patient_no), 0)
  FROM clinics c LEFT JOIN patients p ON p.clinic_id = c.id GROUP BY c.id;

-- Insert paths that predate registration (the task-002 notebook, the demo) do not supply a number or
-- full name. Assign them here from the same counter so patient_no can be NOT NULL from day one.
CREATE FUNCTION patients_fill_defaults() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.full_name IS NULL THEN NEW.full_name := NEW.display_name; END IF;
  IF NEW.patient_no IS NULL THEN
    INSERT INTO patient_counters AS c (clinic_id, last_no) VALUES (NEW.clinic_id, 1)
      ON CONFLICT (clinic_id) DO UPDATE SET last_no = c.last_no + 1
      RETURNING last_no INTO NEW.patient_no;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER patients_fill_defaults BEFORE INSERT ON patients FOR EACH ROW EXECUTE FUNCTION patients_fill_defaults();

ALTER TABLE patients
  ALTER COLUMN patient_no SET NOT NULL,
  ALTER COLUMN full_name SET NOT NULL,
  ADD CONSTRAINT patients_full_name_check CHECK (btrim(full_name) <> ''),
  ADD CONSTRAINT patients_clinic_id_patient_no_key UNIQUE (clinic_id, patient_no),
  ADD CONSTRAINT patients_mahalla_needs_district CHECK (mahalla_id IS NULL OR district_id IS NOT NULL),
  ADD CONSTRAINT patients_district_fk FOREIGN KEY (clinic_id, district_id) REFERENCES districts(clinic_id, id),
  ADD CONSTRAINT patients_mahalla_fk FOREIGN KEY (clinic_id, district_id, mahalla_id) REFERENCES mahallas(clinic_id, district_id, id);
CREATE TRIGGER patients_freeze BEFORE UPDATE ON patients FOR EACH ROW EXECUTE FUNCTION core_freeze_columns('id','clinic_id','patient_no');
CREATE TRIGGER patients_no_delete BEFORE DELETE ON patients FOR EACH ROW EXECUTE FUNCTION core_no_delete();

CREATE TABLE visits (
  id uuid PRIMARY KEY, clinic_id uuid NOT NULL REFERENCES clinics(id), patient_id uuid NOT NULL, business_day_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('outpatient','inpatient')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','cancelled')),
  created_by uuid NOT NULL REFERENCES accounts(id), created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  UNIQUE (clinic_id, id), UNIQUE (clinic_id, patient_id, id),
  FOREIGN KEY (clinic_id, patient_id) REFERENCES patients(clinic_id, id),
  FOREIGN KEY (clinic_id, business_day_id) REFERENCES business_days(clinic_id, id),
  CHECK ((status = 'open') = (closed_at IS NULL))
);
CREATE TRIGGER visits_freeze BEFORE UPDATE ON visits FOR EACH ROW
  EXECUTE FUNCTION core_freeze_columns('id','clinic_id','patient_id','business_day_id','type','created_by','created_at');
CREATE TRIGGER visits_status BEFORE UPDATE OF status ON visits FOR EACH ROW
  EXECUTE FUNCTION core_status_transition('open>closed','open>cancelled');
CREATE TRIGGER visits_no_delete BEFORE DELETE ON visits FOR EACH ROW EXECUTE FUNCTION core_no_delete();

-- An encounter may belong to a visit of the same patient in the same clinic.
ALTER TABLE encounters ADD COLUMN visit_id uuid,
  ADD CONSTRAINT encounters_visit_fk FOREIGN KEY (clinic_id, patient_id, visit_id) REFERENCES visits(clinic_id, patient_id, id);

------------------------------------------------------------------------------------------------
-- Queues
------------------------------------------------------------------------------------------------
CREATE TABLE queue_points (
  id uuid PRIMARY KEY, clinic_id uuid NOT NULL REFERENCES clinics(id),
  kind text NOT NULL CHECK (kind IN ('doctor','department','service')),
  user_id uuid, department_id uuid, service_group_id uuid,
  name_uz_cyrl text NOT NULL CHECK (btrim(name_uz_cyrl) <> ''), name_uz_latn text, name_ru text,
  is_active boolean NOT NULL DEFAULT true,
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, user_id) REFERENCES memberships(clinic_id, user_id),
  FOREIGN KEY (clinic_id, department_id) REFERENCES departments(clinic_id, id),
  FOREIGN KEY (clinic_id, service_group_id) REFERENCES service_groups(clinic_id, id),
  CHECK (kind <> 'doctor' OR user_id IS NOT NULL),
  CHECK (kind <> 'department' OR department_id IS NOT NULL),
  CHECK (kind <> 'service' OR service_group_id IS NOT NULL)
);

CREATE TABLE queue_counters (
  clinic_id uuid NOT NULL REFERENCES clinics(id), business_day_id uuid NOT NULL, queue_point_id uuid NOT NULL,
  last_number integer NOT NULL DEFAULT 0 CHECK (last_number >= 0),
  PRIMARY KEY (business_day_id, queue_point_id),
  FOREIGN KEY (clinic_id, business_day_id) REFERENCES business_days(clinic_id, id),
  FOREIGN KEY (clinic_id, queue_point_id) REFERENCES queue_points(clinic_id, id)
);

CREATE TABLE queue_tickets (
  id uuid PRIMARY KEY, clinic_id uuid NOT NULL REFERENCES clinics(id),
  business_day_id uuid NOT NULL, visit_id uuid NOT NULL, queue_point_id uuid NOT NULL,
  number integer NOT NULL CHECK (number > 0),
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','called','in_progress','completed','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(), called_at timestamptz, started_at timestamptz, completed_at timestamptz,
  UNIQUE (clinic_id, id),
  UNIQUE (business_day_id, queue_point_id, number),
  UNIQUE (business_day_id, queue_point_id, visit_id),
  FOREIGN KEY (clinic_id, business_day_id) REFERENCES business_days(clinic_id, id),
  FOREIGN KEY (clinic_id, visit_id) REFERENCES visits(clinic_id, id),
  FOREIGN KEY (clinic_id, queue_point_id) REFERENCES queue_points(clinic_id, id)
);
CREATE TRIGGER queue_tickets_freeze BEFORE UPDATE ON queue_tickets FOR EACH ROW
  EXECUTE FUNCTION core_freeze_columns('id','clinic_id','business_day_id','visit_id','queue_point_id','number','created_at');
-- called -> waiting returns a patient who did not answer the call to the queue.
CREATE TRIGGER queue_tickets_status BEFORE UPDATE OF status ON queue_tickets FOR EACH ROW
  EXECUTE FUNCTION core_status_transition('waiting>called','waiting>in_progress','waiting>cancelled',
    'called>in_progress','called>waiting','called>cancelled','in_progress>completed','in_progress>cancelled');
CREATE TRIGGER queue_tickets_no_delete BEFORE DELETE ON queue_tickets FOR EACH ROW EXECUTE FUNCTION core_no_delete();

------------------------------------------------------------------------------------------------
-- Charges
------------------------------------------------------------------------------------------------
CREATE TABLE charge_lines (
  id uuid PRIMARY KEY, clinic_id uuid NOT NULL REFERENCES clinics(id), visit_id uuid NOT NULL, service_id uuid NOT NULL,
  performer_user_id uuid, queue_ticket_id uuid,
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_price_uzs bigint NOT NULL CHECK (unit_price_uzs >= 0),
  status text NOT NULL DEFAULT 'ordered' CHECK (status IN ('ordered','completed','cancelled')),
  source text NOT NULL CHECK (source IN ('registration','doctor','lab','inpatient','pharmacy','surgery','bed_day','caretaker','assistant')),
  created_by uuid NOT NULL REFERENCES accounts(id), created_at timestamptz NOT NULL DEFAULT now(),
  completed_by uuid REFERENCES accounts(id), completed_at timestamptz,
  cancelled_by uuid REFERENCES accounts(id), cancelled_at timestamptz, cancel_reason text,
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, visit_id) REFERENCES visits(clinic_id, id),
  FOREIGN KEY (clinic_id, service_id) REFERENCES services(clinic_id, id),
  FOREIGN KEY (clinic_id, performer_user_id) REFERENCES memberships(clinic_id, user_id),
  FOREIGN KEY (clinic_id, queue_ticket_id) REFERENCES queue_tickets(clinic_id, id),
  CHECK ((completed_by IS NULL) = (completed_at IS NULL)),
  CHECK ((cancelled_by IS NULL) = (cancelled_at IS NULL)),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CHECK (status <> 'ordered' OR completed_at IS NULL),
  CHECK (status <> 'completed' OR completed_at IS NOT NULL),
  CHECK (cancel_reason IS NULL OR btrim(cancel_reason) <> '')
);
CREATE FUNCTION charge_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.clinic_id, NEW.visit_id, NEW.service_id, NEW.quantity, NEW.unit_price_uzs, NEW.source, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.clinic_id, OLD.visit_id, OLD.service_id, OLD.quantity, OLD.unit_price_uzs, OLD.source, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'charge line price, quantity and identity are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'a cancelled charge line is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND (OLD.status || '>' || NEW.status) NOT IN ('ordered>completed','ordered>cancelled','completed>cancelled') THEN
    RAISE EXCEPTION 'charge line status % -> % not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'completed' AND NEW.status = 'cancelled' AND NEW.cancel_reason IS NULL THEN
    RAISE EXCEPTION 'cancelling a completed charge line needs a reason' USING ERRCODE = 'check_violation';
  END IF;
  -- Completion facts are written once.
  IF OLD.status = 'completed' AND (NEW.completed_by, NEW.completed_at) IS DISTINCT FROM (OLD.completed_by, OLD.completed_at) THEN
    RAISE EXCEPTION 'completion is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  -- Performer and ticket may be set only while the line is still ordered.
  IF OLD.status <> 'ordered' AND (NEW.performer_user_id, NEW.queue_ticket_id) IS DISTINCT FROM (OLD.performer_user_id, OLD.queue_ticket_id) THEN
    RAISE EXCEPTION 'performer can change only while ordered' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER charge_lines_guard BEFORE UPDATE ON charge_lines FOR EACH ROW EXECUTE FUNCTION charge_lines_guard();
CREATE TRIGGER charge_lines_no_delete BEFORE DELETE ON charge_lines FOR EACH ROW EXECUTE FUNCTION core_no_delete();

------------------------------------------------------------------------------------------------
-- Cashier
------------------------------------------------------------------------------------------------
CREATE TABLE cash_desks (
  id uuid PRIMARY KEY, clinic_id uuid NOT NULL REFERENCES clinics(id),
  name text NOT NULL CHECK (btrim(name) <> ''), is_active boolean NOT NULL DEFAULT true,
  UNIQUE (clinic_id, id)
);

CREATE TABLE cash_shifts (
  id uuid PRIMARY KEY, clinic_id uuid NOT NULL REFERENCES clinics(id),
  cash_desk_id uuid NOT NULL, business_day_id uuid NOT NULL, cashier_user_id uuid NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  opening_cash_uzs bigint NOT NULL CHECK (opening_cash_uzs >= 0),
  closed_at timestamptz, counted_cash_uzs bigint CHECK (counted_cash_uzs >= 0), close_report jsonb,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, cash_desk_id) REFERENCES cash_desks(clinic_id, id),
  FOREIGN KEY (clinic_id, business_day_id) REFERENCES business_days(clinic_id, id),
  FOREIGN KEY (clinic_id, cashier_user_id) REFERENCES memberships(clinic_id, user_id),
  CHECK ((status = 'open' AND closed_at IS NULL AND counted_cash_uzs IS NULL AND close_report IS NULL)
      OR (status = 'closed' AND closed_at IS NOT NULL AND counted_cash_uzs IS NOT NULL AND close_report IS NOT NULL))
);
CREATE UNIQUE INDEX cash_shifts_one_open_per_desk ON cash_shifts(cash_desk_id) WHERE status = 'open';
CREATE FUNCTION cash_shifts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'closed' THEN RAISE EXCEPTION 'a closed cash shift is immutable' USING ERRCODE = 'restrict_violation'; END IF;
  IF (NEW.id, NEW.clinic_id, NEW.cash_desk_id, NEW.business_day_id, NEW.cashier_user_id, NEW.opened_at, NEW.opening_cash_uzs)
     IS DISTINCT FROM (OLD.id, OLD.clinic_id, OLD.cash_desk_id, OLD.business_day_id, OLD.cashier_user_id, OLD.opened_at, OLD.opening_cash_uzs) THEN
    RAISE EXCEPTION 'cash shift opening facts are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cash_shifts_guard BEFORE UPDATE ON cash_shifts FOR EACH ROW EXECUTE FUNCTION cash_shifts_guard();
CREATE TRIGGER cash_shifts_no_delete BEFORE DELETE ON cash_shifts FOR EACH ROW EXECUTE FUNCTION core_no_delete();

CREATE TABLE discounts (
  id uuid PRIMARY KEY, clinic_id uuid NOT NULL REFERENCES clinics(id), visit_id uuid NOT NULL, charge_line_id uuid,
  kind text NOT NULL CHECK (kind IN ('percent','fixed')),
  percent_bp integer CHECK (percent_bp BETWEEN 1 AND 10000),
  amount_uzs bigint CHECK (amount_uzs > 0),
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  approved_by uuid NOT NULL REFERENCES accounts(id),
  created_by uuid NOT NULL REFERENCES accounts(id), created_at timestamptz NOT NULL DEFAULT now(),
  voided_by uuid REFERENCES accounts(id), voided_at timestamptz, void_reason text,
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, visit_id) REFERENCES visits(clinic_id, id),
  FOREIGN KEY (clinic_id, charge_line_id) REFERENCES charge_lines(clinic_id, id),
  CHECK ((kind = 'percent' AND percent_bp IS NOT NULL AND amount_uzs IS NULL)
      OR (kind = 'fixed' AND amount_uzs IS NOT NULL AND percent_bp IS NULL)),
  CHECK ((voided_by IS NULL AND voided_at IS NULL AND void_reason IS NULL)
      OR (voided_by IS NOT NULL AND voided_at IS NOT NULL AND coalesce(btrim(void_reason), '') <> ''))
);
-- Only voiding is allowed, once: every non-void column is frozen and a voided discount is final.
CREATE FUNCTION discounts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.voided_at IS NOT NULL THEN RAISE EXCEPTION 'a voided discount is immutable' USING ERRCODE = 'restrict_violation'; END IF;
  IF (to_jsonb(NEW) - ARRAY['voided_by','voided_at','void_reason']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['voided_by','voided_at','void_reason']) THEN
    RAISE EXCEPTION 'discounts are append-only except for voiding' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER discounts_guard BEFORE UPDATE ON discounts FOR EACH ROW EXECUTE FUNCTION discounts_guard();
CREATE TRIGGER discounts_no_delete BEFORE DELETE ON discounts FOR EACH ROW EXECUTE FUNCTION core_no_delete();

CREATE TABLE payments (
  id uuid PRIMARY KEY, clinic_id uuid NOT NULL REFERENCES clinics(id),
  visit_id uuid NOT NULL, cash_shift_id uuid NOT NULL, business_day_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('payment','refund')),
  method text NOT NULL CHECK (method IN ('cash','card','transfer')),
  amount_uzs bigint NOT NULL CHECK (amount_uzs > 0),
  refund_of uuid,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  received_by uuid NOT NULL REFERENCES accounts(id), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, id), UNIQUE (clinic_id, idempotency_key),
  FOREIGN KEY (clinic_id, visit_id) REFERENCES visits(clinic_id, id),
  FOREIGN KEY (clinic_id, cash_shift_id) REFERENCES cash_shifts(clinic_id, id),
  FOREIGN KEY (clinic_id, business_day_id) REFERENCES business_days(clinic_id, id),
  FOREIGN KEY (clinic_id, refund_of) REFERENCES payments(clinic_id, id),
  CHECK ((kind = 'refund') = (refund_of IS NOT NULL))
);
CREATE TRIGGER payments_append_only BEFORE UPDATE OR DELETE ON payments FOR EACH ROW EXECUTE FUNCTION core_append_only();

CREATE TABLE payment_allocations (
  clinic_id uuid NOT NULL REFERENCES clinics(id), payment_id uuid NOT NULL, charge_line_id uuid NOT NULL,
  amount_uzs bigint NOT NULL CHECK (amount_uzs > 0),
  PRIMARY KEY (payment_id, charge_line_id),
  FOREIGN KEY (clinic_id, payment_id) REFERENCES payments(clinic_id, id),
  FOREIGN KEY (clinic_id, charge_line_id) REFERENCES charge_lines(clinic_id, id)
);
CREATE TRIGGER payment_allocations_append_only BEFORE UPDATE OR DELETE ON payment_allocations FOR EACH ROW EXECUTE FUNCTION core_append_only();

CREATE TABLE receipt_counters (
  clinic_id uuid PRIMARY KEY REFERENCES clinics(id),
  last_no bigint NOT NULL DEFAULT 0 CHECK (last_no >= 0)
);

CREATE TABLE receipts (
  id uuid PRIMARY KEY, clinic_id uuid NOT NULL REFERENCES clinics(id),
  receipt_no bigint NOT NULL CHECK (receipt_no > 0), visit_id uuid NOT NULL, payment_id uuid,
  kind text NOT NULL CHECK (kind IN ('payment','refund','invoice')),
  snapshot jsonb NOT NULL,
  issued_by uuid NOT NULL REFERENCES accounts(id), issued_at timestamptz NOT NULL DEFAULT now(),
  print_count integer NOT NULL DEFAULT 0 CHECK (print_count >= 0),
  UNIQUE (clinic_id, id), UNIQUE (clinic_id, receipt_no),
  FOREIGN KEY (clinic_id, visit_id) REFERENCES visits(clinic_id, id),
  FOREIGN KEY (clinic_id, payment_id) REFERENCES payments(clinic_id, id),
  CHECK (kind = 'invoice' OR payment_id IS NOT NULL)
);
CREATE FUNCTION receipts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'print_count') IS DISTINCT FROM (to_jsonb(OLD) - 'print_count') OR NEW.print_count < OLD.print_count THEN
    RAISE EXCEPTION 'receipts are immutable except for an increasing print count' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER receipts_guard BEFORE UPDATE ON receipts FOR EACH ROW EXECUTE FUNCTION receipts_guard();
CREATE TRIGGER receipts_no_delete BEFORE DELETE ON receipts FOR EACH ROW EXECUTE FUNCTION core_no_delete();

CREATE TABLE cash_outs (
  id uuid PRIMARY KEY, clinic_id uuid NOT NULL REFERENCES clinics(id),
  cash_shift_id uuid NOT NULL, business_day_id uuid NOT NULL, expense_type_id uuid NOT NULL,
  amount_uzs bigint NOT NULL CHECK (amount_uzs > 0), note text,
  created_by uuid NOT NULL REFERENCES accounts(id), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, cash_shift_id) REFERENCES cash_shifts(clinic_id, id),
  FOREIGN KEY (clinic_id, business_day_id) REFERENCES business_days(clinic_id, id),
  FOREIGN KEY (clinic_id, expense_type_id) REFERENCES expense_types(clinic_id, id)
);
CREATE TRIGGER cash_outs_append_only BEFORE UPDATE OR DELETE ON cash_outs FOR EACH ROW EXECUTE FUNCTION core_append_only();

------------------------------------------------------------------------------------------------
-- Laboratory
------------------------------------------------------------------------------------------------
CREATE TABLE lab_results (
  id uuid PRIMARY KEY, clinic_id uuid NOT NULL REFERENCES clinics(id), charge_line_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  entered_by uuid NOT NULL REFERENCES accounts(id), entered_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, id), UNIQUE (charge_line_id, version),
  FOREIGN KEY (clinic_id, charge_line_id) REFERENCES charge_lines(clinic_id, id)
);
CREATE TRIGGER lab_results_append_only BEFORE UPDATE OR DELETE ON lab_results FOR EACH ROW EXECUTE FUNCTION core_append_only();

------------------------------------------------------------------------------------------------
-- Inpatient and surgery
------------------------------------------------------------------------------------------------
CREATE TABLE admissions (
  id uuid PRIMARY KEY, clinic_id uuid NOT NULL REFERENCES clinics(id),
  visit_id uuid NOT NULL UNIQUE, department_id uuid NOT NULL, attending_user_id uuid NOT NULL,
  admitted_at timestamptz NOT NULL, expected_discharge date, discharged_at timestamptz,
  status text NOT NULL DEFAULT 'admitted' CHECK (status IN ('admitted','discharged')),
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, visit_id) REFERENCES visits(clinic_id, id),
  FOREIGN KEY (clinic_id, department_id) REFERENCES departments(clinic_id, id),
  FOREIGN KEY (clinic_id, attending_user_id) REFERENCES memberships(clinic_id, user_id),
  CHECK ((status = 'discharged') = (discharged_at IS NOT NULL)),
  CHECK (discharged_at IS NULL OR discharged_at >= admitted_at)
);
CREATE TRIGGER admissions_freeze BEFORE UPDATE ON admissions FOR EACH ROW
  EXECUTE FUNCTION core_freeze_columns('id','clinic_id','visit_id','admitted_at');
CREATE TRIGGER admissions_status BEFORE UPDATE OF status ON admissions FOR EACH ROW
  EXECUTE FUNCTION core_status_transition('admitted>discharged');
CREATE TRIGGER admissions_no_delete BEFORE DELETE ON admissions FOR EACH ROW EXECUTE FUNCTION core_no_delete();

CREATE TABLE bed_assignments (
  id uuid PRIMARY KEY, clinic_id uuid NOT NULL REFERENCES clinics(id),
  admission_id uuid NOT NULL, bed_id uuid NOT NULL,
  from_at timestamptz NOT NULL, to_at timestamptz,
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, admission_id) REFERENCES admissions(clinic_id, id),
  FOREIGN KEY (clinic_id, bed_id) REFERENCES beds(clinic_id, id),
  CHECK (to_at IS NULL OR to_at >= from_at)
);
CREATE UNIQUE INDEX bed_assignments_one_open_per_bed ON bed_assignments(bed_id) WHERE to_at IS NULL;
CREATE UNIQUE INDEX bed_assignments_one_open_per_admission ON bed_assignments(admission_id) WHERE to_at IS NULL;
CREATE TRIGGER bed_assignments_freeze BEFORE UPDATE ON bed_assignments FOR EACH ROW
  EXECUTE FUNCTION core_freeze_columns('id','clinic_id','admission_id','bed_id','from_at');
CREATE FUNCTION bed_assignments_close_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.to_at IS NOT NULL AND NEW.to_at IS DISTINCT FROM OLD.to_at THEN
    RAISE EXCEPTION 'a closed bed assignment is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bed_assignments_close_once BEFORE UPDATE ON bed_assignments FOR EACH ROW EXECUTE FUNCTION bed_assignments_close_once();
CREATE TRIGGER bed_assignments_no_delete BEFORE DELETE ON bed_assignments FOR EACH ROW EXECUTE FUNCTION core_no_delete();

CREATE TABLE caretakers (
  id uuid PRIMARY KEY, clinic_id uuid NOT NULL REFERENCES clinics(id), admission_id uuid NOT NULL,
  full_name text NOT NULL CHECK (btrim(full_name) <> ''), phone text CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  from_date date NOT NULL, to_date date, daily_service_id uuid,
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, admission_id) REFERENCES admissions(clinic_id, id),
  FOREIGN KEY (clinic_id, daily_service_id) REFERENCES services(clinic_id, id),
  CHECK (to_date IS NULL OR to_date >= from_date)
);
CREATE TRIGGER caretakers_service_kind BEFORE INSERT OR UPDATE OF daily_service_id ON caretakers
  FOR EACH ROW EXECUTE FUNCTION core_require_service_kind('daily_service_id', 'caretaker');
CREATE TRIGGER caretakers_no_delete BEFORE DELETE ON caretakers FOR EACH ROW EXECUTE FUNCTION core_no_delete();

CREATE TABLE bed_day_charges (
  clinic_id uuid NOT NULL REFERENCES clinics(id), admission_id uuid NOT NULL, charge_date date NOT NULL,
  charge_line_id uuid NOT NULL UNIQUE,
  PRIMARY KEY (admission_id, charge_date),
  FOREIGN KEY (clinic_id, admission_id) REFERENCES admissions(clinic_id, id),
  FOREIGN KEY (clinic_id, charge_line_id) REFERENCES charge_lines(clinic_id, id)
);
CREATE TRIGGER bed_day_charges_append_only BEFORE UPDATE OR DELETE ON bed_day_charges FOR EACH ROW EXECUTE FUNCTION core_append_only();

CREATE TABLE caretaker_day_charges (
  clinic_id uuid NOT NULL REFERENCES clinics(id), caretaker_id uuid NOT NULL, charge_date date NOT NULL,
  charge_line_id uuid NOT NULL UNIQUE,
  PRIMARY KEY (caretaker_id, charge_date),
  FOREIGN KEY (clinic_id, caretaker_id) REFERENCES caretakers(clinic_id, id),
  FOREIGN KEY (clinic_id, charge_line_id) REFERENCES charge_lines(clinic_id, id)
);
CREATE TRIGGER caretaker_day_charges_append_only BEFORE UPDATE OR DELETE ON caretaker_day_charges FOR EACH ROW EXECUTE FUNCTION core_append_only();

CREATE TABLE surgeries (
  id uuid PRIMARY KEY, clinic_id uuid NOT NULL REFERENCES clinics(id),
  visit_id uuid NOT NULL, admission_id uuid, surgeon_user_id uuid NOT NULL, service_id uuid NOT NULL,
  performed_at timestamptz NOT NULL, document_id uuid,
  created_by uuid NOT NULL REFERENCES accounts(id), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, visit_id) REFERENCES visits(clinic_id, id),
  FOREIGN KEY (clinic_id, admission_id) REFERENCES admissions(clinic_id, id),
  FOREIGN KEY (clinic_id, surgeon_user_id) REFERENCES memberships(clinic_id, user_id),
  FOREIGN KEY (clinic_id, service_id) REFERENCES services(clinic_id, id),
  FOREIGN KEY (clinic_id, document_id) REFERENCES documents(clinic_id, id)
);
CREATE TRIGGER surgeries_service_kind BEFORE INSERT OR UPDATE OF service_id ON surgeries
  FOR EACH ROW EXECUTE FUNCTION core_require_service_kind('service_id', 'surgery');
CREATE TRIGGER surgeries_no_delete BEFORE DELETE ON surgeries FOR EACH ROW EXECUTE FUNCTION core_no_delete();

------------------------------------------------------------------------------------------------
-- Pharmacy stock
------------------------------------------------------------------------------------------------
CREATE TABLE stock_movements (
  id uuid PRIMARY KEY, clinic_id uuid NOT NULL REFERENCES clinics(id), service_id uuid NOT NULL,
  qty integer NOT NULL CHECK (qty <> 0),
  reason text NOT NULL CHECK (reason IN ('receipt','dispense','adjustment','return')),
  visit_id uuid, charge_line_id uuid,
  unit_cost_uzs bigint CHECK (unit_cost_uzs >= 0), supplier text, note text,
  created_by uuid NOT NULL REFERENCES accounts(id), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, service_id) REFERENCES services(clinic_id, id),
  FOREIGN KEY (clinic_id, visit_id) REFERENCES visits(clinic_id, id),
  FOREIGN KEY (clinic_id, charge_line_id) REFERENCES charge_lines(clinic_id, id),
  CHECK (reason NOT IN ('receipt','return') OR qty > 0),
  CHECK (reason <> 'dispense' OR (qty < 0 AND visit_id IS NOT NULL AND charge_line_id IS NOT NULL))
);
CREATE TRIGGER stock_movements_service_kind BEFORE INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION core_require_service_kind('service_id', '@stock');
CREATE TRIGGER stock_movements_append_only BEFORE UPDATE OR DELETE ON stock_movements FOR EACH ROW EXECUTE FUNCTION core_append_only();

------------------------------------------------------------------------------------------------
-- Doctor pay
------------------------------------------------------------------------------------------------
CREATE TABLE doctor_split_rules (
  id uuid PRIMARY KEY, clinic_id uuid NOT NULL REFERENCES clinics(id), user_id uuid NOT NULL,
  doctor_share_bp integer NOT NULL CHECK (doctor_share_bp BETWEEN 0 AND 10000),
  basis text NOT NULL CHECK (basis IN ('billed','paid')),
  discount_bearer text NOT NULL CHECK (discount_bearer IN ('clinic','doctor','proportional')),
  categories text[] NOT NULL CHECK (cardinality(categories) > 0 AND categories <@
    ARRAY['consultation','procedure','lab','diagnostic','bed','surgery','medicine','good','caretaker','other']::text[]),
  effective_from date NOT NULL,
  created_by uuid NOT NULL REFERENCES accounts(id), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, id), UNIQUE (clinic_id, user_id, effective_from),
  FOREIGN KEY (clinic_id, user_id) REFERENCES memberships(clinic_id, user_id)
);
CREATE TRIGGER doctor_split_rules_append_only BEFORE UPDATE OR DELETE ON doctor_split_rules FOR EACH ROW EXECUTE FUNCTION core_append_only();

CREATE TABLE payroll_periods (
  id uuid PRIMARY KEY, clinic_id uuid NOT NULL REFERENCES clinics(id),
  from_date date NOT NULL, to_date date NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','final')),
  finalized_by uuid REFERENCES accounts(id), finalized_at timestamptz,
  UNIQUE (clinic_id, id),
  CHECK (to_date >= from_date),
  CHECK ((status = 'final') = (finalized_by IS NOT NULL AND finalized_at IS NOT NULL)),
  CHECK (status = 'final' OR (finalized_by IS NULL AND finalized_at IS NULL))
);
CREATE FUNCTION payroll_periods_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'final' THEN RAISE EXCEPTION 'a final payroll period is immutable' USING ERRCODE = 'restrict_violation'; END IF;
  IF (NEW.id, NEW.clinic_id) IS DISTINCT FROM (OLD.id, OLD.clinic_id) THEN
    RAISE EXCEPTION 'payroll period identity is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payroll_periods_guard BEFORE UPDATE ON payroll_periods FOR EACH ROW EXECUTE FUNCTION payroll_periods_guard();
CREATE TRIGGER payroll_periods_no_delete BEFORE DELETE ON payroll_periods FOR EACH ROW EXECUTE FUNCTION core_no_delete();

CREATE TABLE payroll_lines (
  id uuid PRIMARY KEY, clinic_id uuid NOT NULL REFERENCES clinics(id),
  period_id uuid NOT NULL, user_id uuid NOT NULL, charge_line_id uuid NOT NULL, rule_id uuid NOT NULL,
  entitlement_uzs bigint NOT NULL CHECK (entitlement_uzs >= 0),
  from_receipts_uzs bigint NOT NULL CHECK (from_receipts_uzs >= 0),
  clinic_funded_uzs bigint NOT NULL CHECK (clinic_funded_uzs >= 0),
  UNIQUE (clinic_id, id), UNIQUE (period_id, charge_line_id),
  FOREIGN KEY (clinic_id, period_id) REFERENCES payroll_periods(clinic_id, id),
  FOREIGN KEY (clinic_id, user_id) REFERENCES memberships(clinic_id, user_id),
  FOREIGN KEY (clinic_id, charge_line_id) REFERENCES charge_lines(clinic_id, id),
  FOREIGN KEY (clinic_id, rule_id) REFERENCES doctor_split_rules(clinic_id, id)
);
-- Lines are the finalized snapshot: written in the finalizing transaction, never into a final period.
CREATE FUNCTION payroll_lines_open_period() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM payroll_periods WHERE clinic_id = NEW.clinic_id AND id = NEW.period_id AND status = 'final') THEN
    RAISE EXCEPTION 'payroll period is final' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payroll_lines_open_period BEFORE INSERT ON payroll_lines FOR EACH ROW EXECUTE FUNCTION payroll_lines_open_period();
CREATE TRIGGER payroll_lines_append_only BEFORE UPDATE OR DELETE ON payroll_lines FOR EACH ROW EXECUTE FUNCTION core_append_only();

------------------------------------------------------------------------------------------------
-- Indexes (minimum set from docs/DATA-MODEL.md, plus lookups the FKs and counters need)
------------------------------------------------------------------------------------------------
CREATE INDEX patients_phone ON patients(clinic_id, phone);
CREATE INDEX patients_full_name ON patients(clinic_id, lower(full_name));
CREATE INDEX visits_day ON visits(clinic_id, business_day_id);
CREATE INDEX visits_patient ON visits(clinic_id, patient_id, created_at);
CREATE INDEX queue_tickets_board ON queue_tickets(business_day_id, queue_point_id, status);
CREATE INDEX charge_lines_visit ON charge_lines(clinic_id, visit_id);
CREATE INDEX payments_day ON payments(clinic_id, business_day_id);
CREATE INDEX payments_visit ON payments(clinic_id, visit_id);
CREATE INDEX payment_allocations_line ON payment_allocations(clinic_id, charge_line_id);
CREATE INDEX discounts_visit ON discounts(clinic_id, visit_id);
CREATE INDEX cash_outs_day ON cash_outs(clinic_id, business_day_id);
CREATE INDEX stock_movements_service ON stock_movements(clinic_id, service_id);
CREATE INDEX service_prices_lookup ON service_prices(clinic_id, service_id, effective_from DESC);
CREATE INDEX lab_results_line ON lab_results(clinic_id, charge_line_id, version DESC);
CREATE INDEX bed_assignments_admission ON bed_assignments(clinic_id, admission_id);
CREATE INDEX doctor_split_rules_lookup ON doctor_split_rules(clinic_id, user_id, effective_from DESC);
CREATE INDEX payroll_lines_period ON payroll_lines(clinic_id, period_id, user_id);

-- New clinics get default settings so readers never have to guess a missing row.
CREATE FUNCTION clinics_default_settings() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN INSERT INTO clinic_settings(clinic_id) VALUES (NEW.id) ON CONFLICT DO NOTHING; RETURN NEW; END $$;
CREATE TRIGGER clinics_default_settings AFTER INSERT ON clinics FOR EACH ROW EXECUTE FUNCTION clinics_default_settings();
