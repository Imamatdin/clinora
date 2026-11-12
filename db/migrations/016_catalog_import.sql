-- Task 005 (increment C3): catalog editing and 1C / spreadsheet import. Catalog tables come from
-- 010_core_schema.sql; this file adds only what import and editing need on top.

-- Address and room-type lists can be retired like every other catalog list.
ALTER TABLE districts ADD COLUMN is_active boolean NOT NULL DEFAULT true;
ALTER TABLE mahallas ADD COLUMN is_active boolean NOT NULL DEFAULT true;
ALTER TABLE room_types ADD COLUMN is_active boolean NOT NULL DEFAULT true;

-- Re-import matches rows by their 1C code, so a code may appear once per clinic and list.
CREATE UNIQUE INDEX districts_code_1c ON districts(clinic_id, code_1c) WHERE code_1c IS NOT NULL;
CREATE UNIQUE INDEX mahallas_code_1c ON mahallas(clinic_id, code_1c) WHERE code_1c IS NOT NULL;
CREATE UNIQUE INDEX room_types_code_1c ON room_types(clinic_id, code_1c) WHERE code_1c IS NOT NULL;
CREATE UNIQUE INDEX expense_types_code_1c ON expense_types(clinic_id, code_1c) WHERE code_1c IS NOT NULL;

-- Doctors as listed in the clinic's 1C (Справочник.ВРАЧЛАР). A 1C doctor is reference data only: it
-- grants nothing. An administrator links it to a staff account, which creates the doctor_profiles row.
CREATE TABLE catalog_doctors (
  id uuid PRIMARY KEY, clinic_id uuid NOT NULL REFERENCES clinics(id),
  full_name text NOT NULL CHECK (btrim(full_name) <> ''), code_1c text,
  department_id uuid,
  specialty_uz_cyrl text, specialty_uz_latn text, specialty_ru text,
  linked_user_id uuid,
  is_active boolean NOT NULL DEFAULT true,
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, department_id) REFERENCES departments(clinic_id, id),
  FOREIGN KEY (clinic_id, linked_user_id) REFERENCES memberships(clinic_id, user_id)
);
CREATE UNIQUE INDEX catalog_doctors_code_1c ON catalog_doctors(clinic_id, code_1c) WHERE code_1c IS NOT NULL;
CREATE UNIQUE INDEX catalog_doctors_linked ON catalog_doctors(clinic_id, linked_user_id) WHERE linked_user_id IS NOT NULL;

-- An import is staged first, previewed, then committed in one transaction. Staged rows hold catalog
-- reference data only: the .dt is parsed in the administrator's browser and patient or document
-- objects are never extracted, so they can never reach these tables.
CREATE TABLE import_batches (
  id uuid PRIMARY KEY, clinic_id uuid NOT NULL REFERENCES clinics(id),
  source text NOT NULL CHECK (source IN ('dt','xlsx','csv')),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  total_rows integer NOT NULL CHECK (total_rows BETWEEN 1 AND 50000),
  status text NOT NULL DEFAULT 'staging' CHECK (status IN ('staging','committed','discarded')),
  summary jsonb,
  created_by uuid NOT NULL REFERENCES accounts(id), created_at timestamptz NOT NULL DEFAULT now(),
  finished_by uuid REFERENCES accounts(id), finished_at timestamptz,
  UNIQUE (clinic_id, id)
);
CREATE TABLE import_batch_rows (
  clinic_id uuid NOT NULL, batch_id uuid NOT NULL, seq integer NOT NULL CHECK (seq >= 0),
  row jsonb NOT NULL,
  PRIMARY KEY (batch_id, seq),
  FOREIGN KEY (clinic_id, batch_id) REFERENCES import_batches(clinic_id, id) ON DELETE CASCADE
);
