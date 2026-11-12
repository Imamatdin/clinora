CREATE TABLE cashier_approvals (
 id uuid PRIMARY KEY, clinic_id uuid NOT NULL REFERENCES clinics(id),
 requested_by uuid NOT NULL REFERENCES accounts(id), approved_by uuid NOT NULL REFERENCES accounts(id),
 payload_hash text NOT NULL, expires_at timestamptz NOT NULL DEFAULT now()+interval '5 minutes', used_at timestamptz
);
