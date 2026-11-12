-- Task 003C (increment A1): doctor assistant, first slice.
-- Captures (browser recording or Telegram voice), transcripts with segment ids, extraction runs,
-- typed field proposals with source segments, field-by-field review and approval that writes an
-- immutable document version (reusing task-002 documents and document_versions).
-- Synthetic data only until the founders define a real-data process.

-- Telegram linking owned by this task until task 004 merges its own linking (see handoff).
CREATE TABLE assistant_telegram_link_codes (
  id uuid PRIMARY KEY, clinic_id uuid NOT NULL REFERENCES clinics(id), user_id uuid NOT NULL REFERENCES accounts(id),
  code_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL, consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (clinic_id, user_id) REFERENCES memberships(clinic_id, user_id)
);
CREATE TABLE assistant_telegram_links (
  id uuid PRIMARY KEY, clinic_id uuid NOT NULL REFERENCES clinics(id), user_id uuid NOT NULL REFERENCES accounts(id),
  telegram_user_id bigint NOT NULL CHECK (telegram_user_id > 0), telegram_chat_id bigint NOT NULL,
  telegram_name text NOT NULL DEFAULT '' CHECK (length(telegram_name) <= 200),
  code_id uuid NOT NULL REFERENCES assistant_telegram_link_codes(id),
  status text NOT NULL CHECK (status IN ('pending','active','revoked')),
  created_at timestamptz NOT NULL DEFAULT now(), confirmed_at timestamptz, revoked_at timestamptz,
  FOREIGN KEY (clinic_id, user_id) REFERENCES memberships(clinic_id, user_id)
);
-- One live link per Telegram identity and per staff member in a clinic.
CREATE UNIQUE INDEX assistant_tg_one_identity ON assistant_telegram_links(telegram_user_id) WHERE status <> 'revoked';
CREATE UNIQUE INDEX assistant_tg_one_member ON assistant_telegram_links(clinic_id, user_id) WHERE status <> 'revoked';
-- Telegram redelivers updates; each update id is processed once.
CREATE TABLE assistant_telegram_updates (update_id bigint PRIMARY KEY, received_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE assistant_captures (
  id uuid PRIMARY KEY, clinic_id uuid NOT NULL REFERENCES clinics(id), doctor_id uuid NOT NULL REFERENCES accounts(id),
  source text NOT NULL CHECK (source IN ('browser','telegram','simulated')),
  client_key text CHECK (client_key ~ '^[A-Za-z0-9_-]{16,100}$'),
  telegram_chat_id bigint, telegram_message_id bigint, telegram_file_id text CHECK (length(telegram_file_id) <= 300),
  duration_s integer CHECK (duration_s >= 0), mime_type text NOT NULL CHECK (mime_type ~ '^[a-z]+/[a-z0-9.+-]+$'),
  patient_id uuid, encounter_id uuid,
  status text NOT NULL CHECK (status IN ('receiving','pending_attach','queued','processing','done','failed','discarded')),
  stage text CHECK (stage IN ('transcribing','drafting')),
  error_code text CHECK (error_code ~ '^[A-Z_]{3,40}$'),
  attempts integer NOT NULL DEFAULT 0, lease_token uuid, lease_until timestamptz,
  chunk_count integer NOT NULL DEFAULT 0, byte_count bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), attached_at timestamptz, attached_by uuid REFERENCES accounts(id),
  finished_at timestamptz, audio_purged_at timestamptz,
  UNIQUE (clinic_id, id), UNIQUE (clinic_id, doctor_id, client_key), UNIQUE (telegram_chat_id, telegram_message_id),
  FOREIGN KEY (clinic_id, doctor_id) REFERENCES memberships(clinic_id, user_id),
  FOREIGN KEY (clinic_id, patient_id, encounter_id) REFERENCES encounters(clinic_id, patient_id, id),
  CHECK ((patient_id IS NULL) = (encounter_id IS NULL)),
  CHECK (source = 'telegram' OR encounter_id IS NOT NULL),
  CHECK (source <> 'telegram' OR (telegram_chat_id IS NOT NULL AND telegram_message_id IS NOT NULL AND telegram_file_id IS NOT NULL))
);
CREATE INDEX assistant_captures_doctor ON assistant_captures(clinic_id, doctor_id, status, created_at);

-- Raw audio is private and short-lived (purged 24 hours after capture on synthetic staging).
CREATE TABLE assistant_audio_chunks (
  capture_id uuid NOT NULL REFERENCES assistant_captures(id), seq integer NOT NULL CHECK (seq >= 0 AND seq < 400),
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'), size integer NOT NULL CHECK (size > 0),
  data bytea NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (capture_id, seq)
);

CREATE TABLE assistant_transcripts (
  id uuid PRIMARY KEY, clinic_id uuid NOT NULL, patient_id uuid NOT NULL, encounter_id uuid NOT NULL,
  capture_id uuid NOT NULL UNIQUE, provider text NOT NULL, simulated boolean NOT NULL,
  language text, latency_ms integer, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, patient_id, encounter_id, id),
  FOREIGN KEY (clinic_id, capture_id) REFERENCES assistant_captures(clinic_id, id),
  FOREIGN KEY (clinic_id, patient_id, encounter_id) REFERENCES encounters(clinic_id, patient_id, id)
);
-- Segments carry their encounter and patient, so a citation can be checked against both.
CREATE TABLE assistant_segments (
  id uuid PRIMARY KEY, clinic_id uuid NOT NULL, patient_id uuid NOT NULL, encounter_id uuid NOT NULL,
  transcript_id uuid NOT NULL, seq integer NOT NULL CHECK (seq >= 0),
  start_ms integer NOT NULL CHECK (start_ms >= 0), end_ms integer NOT NULL, CHECK (end_ms >= start_ms),
  speaker text NOT NULL CHECK (speaker IN ('doctor','patient','unknown')),
  text text NOT NULL CHECK (length(text) BETWEEN 1 AND 8000),
  UNIQUE (transcript_id, seq),
  FOREIGN KEY (clinic_id, patient_id, encounter_id, transcript_id) REFERENCES assistant_transcripts(clinic_id, patient_id, encounter_id, id)
);
CREATE INDEX assistant_segments_encounter ON assistant_segments(clinic_id, encounter_id);

CREATE TABLE assistant_drafts (
  id uuid PRIMARY KEY, clinic_id uuid NOT NULL, patient_id uuid NOT NULL, encounter_id uuid NOT NULL UNIQUE,
  form_id text NOT NULL, revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','approved')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, patient_id, encounter_id) REFERENCES encounters(clinic_id, patient_id, id)
);
CREATE TABLE assistant_extraction_runs (
  id uuid PRIMARY KEY, clinic_id uuid NOT NULL, draft_id uuid NOT NULL, capture_id uuid NOT NULL,
  provider text NOT NULL, model text, simulated boolean NOT NULL,
  status text NOT NULL CHECK (status IN ('done','failed')), error_code text,
  latency_ms integer, accepted_count integer NOT NULL DEFAULT 0, rejected_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (clinic_id, draft_id) REFERENCES assistant_drafts(clinic_id, id),
  FOREIGN KEY (clinic_id, capture_id) REFERENCES assistant_captures(clinic_id, id)
);
-- Every model proposal is kept as returned and validated, separate from what the doctor accepts.
CREATE TABLE assistant_proposals (
  id uuid PRIMARY KEY, clinic_id uuid NOT NULL, run_id uuid NOT NULL REFERENCES assistant_extraction_runs(id),
  draft_id uuid NOT NULL, field_key text NOT NULL, value jsonb, category text,
  evidence uuid[] NOT NULL DEFAULT '{}',
  disposition text NOT NULL CHECK (disposition IN ('applied','held','rejected')),
  reject_reason text CHECK (reject_reason ~ '^[a-z_]{3,40}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (clinic_id, draft_id) REFERENCES assistant_drafts(clinic_id, id)
);
-- Field history: one row per change; the highest field_revision is current.
CREATE TABLE assistant_field_versions (
  id uuid PRIMARY KEY, clinic_id uuid NOT NULL, draft_id uuid NOT NULL,
  field_key text NOT NULL, field_revision integer NOT NULL CHECK (field_revision > 0),
  value jsonb, category text NOT NULL,
  status text NOT NULL CHECK (status IN ('proposed','accepted','edited','cleared')),
  origin text NOT NULL CHECK (origin IN ('ai','clinician')),
  evidence uuid[] NOT NULL DEFAULT '{}', proposal_id uuid REFERENCES assistant_proposals(id),
  actor_id uuid REFERENCES accounts(id), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (draft_id, field_key, field_revision),
  FOREIGN KEY (clinic_id, draft_id) REFERENCES assistant_drafts(clinic_id, id),
  CHECK (origin <> 'ai' OR status = 'proposed' OR actor_id IS NOT NULL),
  CHECK (status = 'proposed' OR actor_id IS NOT NULL),
  CHECK (status <> 'proposed' OR (origin = 'ai' AND cardinality(evidence) > 0 AND proposal_id IS NOT NULL))
);
CREATE TABLE assistant_approvals (
  id uuid PRIMARY KEY, clinic_id uuid NOT NULL, patient_id uuid NOT NULL, draft_id uuid NOT NULL UNIQUE,
  document_id uuid NOT NULL, version_id uuid NOT NULL UNIQUE, revision integer NOT NULL,
  draft_revision integer NOT NULL, field_versions jsonb NOT NULL,
  approved_by uuid NOT NULL REFERENCES accounts(id), approved_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (clinic_id, draft_id) REFERENCES assistant_drafts(clinic_id, id),
  FOREIGN KEY (document_id, version_id) REFERENCES document_versions(document_id, id)
);

-- Transcripts, segments, proposals, field history, runs and approvals are append-only.
CREATE TRIGGER assistant_transcripts_immutable BEFORE UPDATE OR DELETE ON assistant_transcripts FOR EACH ROW EXECUTE FUNCTION immutable_revision();
CREATE TRIGGER assistant_segments_immutable BEFORE UPDATE OR DELETE ON assistant_segments FOR EACH ROW EXECUTE FUNCTION immutable_revision();
CREATE TRIGGER assistant_proposals_immutable BEFORE UPDATE OR DELETE ON assistant_proposals FOR EACH ROW EXECUTE FUNCTION immutable_revision();
CREATE TRIGGER assistant_field_versions_immutable BEFORE UPDATE OR DELETE ON assistant_field_versions FOR EACH ROW EXECUTE FUNCTION immutable_revision();
CREATE TRIGGER assistant_runs_immutable BEFORE UPDATE OR DELETE ON assistant_extraction_runs FOR EACH ROW EXECUTE FUNCTION immutable_revision();
CREATE TRIGGER assistant_approvals_immutable BEFORE UPDATE OR DELETE ON assistant_approvals FOR EACH ROW EXECUTE FUNCTION immutable_revision();
