-- Task 010 (increment C6), migration 017: doctor and laboratory workspaces.
-- Approval of a doctor-written visit note. The assistant (task 003C) keeps its own assistant_approvals;
-- both reference an immutable document_versions row, and src/modules/documents/approvals.ts reads
-- them together so "the latest approval of a document" has one answer.
CREATE TABLE note_approvals (
  id uuid PRIMARY KEY, clinic_id uuid NOT NULL REFERENCES clinics(id), patient_id uuid NOT NULL,
  document_id uuid NOT NULL, version_id uuid NOT NULL UNIQUE, revision integer NOT NULL CHECK (revision > 0),
  -- The approval this one supersedes after an explicit amendment; null for the first approval.
  amends_approval_id uuid,
  approved_by uuid NOT NULL REFERENCES accounts(id), approved_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, id), UNIQUE (document_id, revision),
  FOREIGN KEY (clinic_id, patient_id, document_id) REFERENCES documents(clinic_id, patient_id, id),
  FOREIGN KEY (document_id, version_id) REFERENCES document_versions(document_id, id)
);
CREATE TRIGGER note_approvals_immutable BEFORE UPDATE OR DELETE ON note_approvals FOR EACH ROW EXECUTE FUNCTION immutable_revision();

-- One visit encounter per doctor per visit: opening the same queue ticket twice, or from two devices,
-- reuses the encounter instead of creating a second note.
CREATE UNIQUE INDEX encounters_one_per_doctor_visit ON encounters(clinic_id, visit_id, clinician_id) WHERE visit_id IS NOT NULL;
