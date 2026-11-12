CREATE TABLE accounts (
 id uuid PRIMARY KEY, email text NOT NULL UNIQUE CHECK(email=lower(email)), display_name text NOT NULL,
 password_hash text NOT NULL, status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','blocked')),
 email_verified boolean NOT NULL DEFAULT false, professional_verification jsonb NOT NULL DEFAULT '{"status":"unverified"}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE clinics (id uuid PRIMARY KEY, name text NOT NULL);
CREATE TABLE memberships (
 id uuid PRIMARY KEY, clinic_id uuid NOT NULL REFERENCES clinics(id), user_id uuid NOT NULL REFERENCES accounts(id),
 role text NOT NULL CHECK(role IN ('administrator','clinician')), is_owner boolean NOT NULL DEFAULT false,
 clinical_access boolean NOT NULL DEFAULT false, patient_scope text NOT NULL DEFAULT 'assigned' CHECK(patient_scope IN ('clinic','assigned')),
 status text NOT NULL CHECK(status IN ('active','invited','revoked','blocked')), revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 granted_by uuid NOT NULL REFERENCES accounts(id), granted_at timestamptz NOT NULL DEFAULT now(), UNIQUE(clinic_id,user_id)
);
CREATE TABLE sessions (
 id uuid PRIMARY KEY, token_hash text NOT NULL UNIQUE, user_id uuid NOT NULL REFERENCES accounts(id),
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE invitations (
 id uuid PRIMARY KEY, clinic_id uuid NOT NULL REFERENCES clinics(id), email text NOT NULL,
 token_hash text NOT NULL UNIQUE, created_by uuid NOT NULL REFERENCES accounts(id), expires_at timestamptz NOT NULL,
 consumed_at timestamptz, revoked_at timestamptz
);
CREATE TABLE patients (
 id uuid PRIMARY KEY, clinic_id uuid NOT NULL REFERENCES clinics(id), display_name text NOT NULL,
 mrn text, date_of_birth date, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0), provenance jsonb NOT NULL,
 UNIQUE(clinic_id,id), UNIQUE(clinic_id,mrn)
);
CREATE TABLE patient_assignments (
 clinic_id uuid NOT NULL, patient_id uuid NOT NULL, user_id uuid NOT NULL,
 PRIMARY KEY(clinic_id,patient_id,user_id),
 FOREIGN KEY(clinic_id,patient_id) REFERENCES patients(clinic_id,id),
 FOREIGN KEY(clinic_id,user_id) REFERENCES memberships(clinic_id,user_id)
);
CREATE TABLE encounters (
 id uuid PRIMARY KEY, clinic_id uuid NOT NULL, patient_id uuid NOT NULL, clinician_id uuid NOT NULL,
 data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(clinic_id,patient_id,id), FOREIGN KEY(clinic_id,patient_id) REFERENCES patients(clinic_id,id),
 FOREIGN KEY(clinic_id,clinician_id) REFERENCES memberships(clinic_id,user_id)
);
CREATE TABLE documents (
 id uuid PRIMARY KEY, clinic_id uuid NOT NULL, patient_id uuid NOT NULL, encounter_id uuid NOT NULL UNIQUE,
 current_revision integer NOT NULL DEFAULT 0 CHECK(current_revision>=0), current_version_id uuid,
 UNIQUE(clinic_id,patient_id,id),
 FOREIGN KEY(clinic_id,patient_id,encounter_id) REFERENCES encounters(clinic_id,patient_id,id)
);
CREATE TABLE document_versions (
 id uuid PRIMARY KEY, document_id uuid NOT NULL, clinic_id uuid NOT NULL, patient_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0), created_by uuid NOT NULL REFERENCES accounts(id),
 data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(document_id,revision), UNIQUE(document_id,id),
 FOREIGN KEY(clinic_id,patient_id,document_id) REFERENCES documents(clinic_id,patient_id,id)
);
ALTER TABLE documents ADD CONSTRAINT current_version_ref FOREIGN KEY(id,current_version_id) REFERENCES document_versions(document_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION immutable_revision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Append-only clinical revisions'; END $$;
CREATE TRIGGER immutable_document_versions BEFORE UPDATE OR DELETE ON document_versions FOR EACH ROW EXECUTE FUNCTION immutable_revision();
CREATE TABLE idempotency_records (
 clinic_id uuid NOT NULL REFERENCES clinics(id), actor_id uuid NOT NULL REFERENCES accounts(id), operation text NOT NULL,
 key text NOT NULL, payload_hash text NOT NULL, response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(clinic_id,actor_id,operation,key)
);
CREATE TABLE audit_events (
 id uuid PRIMARY KEY, actor_id uuid NOT NULL REFERENCES accounts(id), clinic_id uuid REFERENCES clinics(id),
 action text NOT NULL, resource_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE login_limits (key text PRIMARY KEY, attempts integer NOT NULL, reset_at timestamptz NOT NULL);
CREATE INDEX patient_search_scope ON patients(clinic_id,created_at,id);
CREATE INDEX encounter_patient ON encounters(clinic_id,patient_id,created_at);
CREATE INDEX session_expiry ON sessions(expires_at);
