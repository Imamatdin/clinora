-- Task 020: a CEO/administrator approves an out-of-stock ward dispense by PIN on the same shared PC.
-- Failed approvals are counted per approver and device here, never on account_pins, so mistyped
-- approvals cannot lock the approver out of their own sign-in. Five failures lock the pair for
-- 15 minutes (enforced in src/modules/inpatient/actions.ts).
CREATE TABLE ward_override_attempts (
  approver_id uuid NOT NULL REFERENCES accounts(id),
  device_id uuid NOT NULL REFERENCES devices(id),
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 5),
  locked_at timestamptz,
  PRIMARY KEY (approver_id, device_id),
  CHECK ((locked_at IS NOT NULL) = (failed_attempts = 5))
);
