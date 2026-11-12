CREATE TABLE cashier_approvals (
 id uuid PRIMARY KEY, clinic_id uuid NOT NULL REFERENCES clinics(id),
 requested_by uuid NOT NULL REFERENCES accounts(id), approved_by uuid NOT NULL REFERENCES accounts(id),
 payload_hash text NOT NULL, expires_at timestamptz NOT NULL DEFAULT now()+interval '5 minutes', used_at timestamptz
);
-- Repricing a paid line moves allocations without rewriting historical receipts.
CREATE TABLE cashier_allocation_adjustments (
 id uuid PRIMARY KEY, clinic_id uuid NOT NULL REFERENCES clinics(id), payment_id uuid NOT NULL,
 charge_line_id uuid NOT NULL, discount_id uuid NOT NULL, delta_uzs bigint NOT NULL CHECK(delta_uzs<>0),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(clinic_id,payment_id) REFERENCES payments(clinic_id,id),
 FOREIGN KEY(clinic_id,charge_line_id) REFERENCES charge_lines(clinic_id,id),
 FOREIGN KEY(clinic_id,discount_id) REFERENCES discounts(clinic_id,id)
);
CREATE TRIGGER cashier_adjustments_append_only BEFORE UPDATE OR DELETE ON cashier_allocation_adjustments
 FOR EACH ROW EXECUTE FUNCTION core_append_only();
