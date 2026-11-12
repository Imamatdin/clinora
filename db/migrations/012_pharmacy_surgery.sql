ALTER TABLE membership_roles DROP CONSTRAINT membership_roles_role_check;
ALTER TABLE membership_roles ADD CONSTRAINT membership_roles_role_check CHECK
  (role IN ('ceo','administrator','registrar','doctor','laboratory','cashier','inpatient','pharmacy'));

CREATE TABLE pharmacy_settings (
  clinic_id uuid NOT NULL, service_id uuid NOT NULL, low_stock_threshold integer NOT NULL CHECK (low_stock_threshold >= 0),
  updated_by uuid NOT NULL REFERENCES accounts(id), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clinic_id,service_id), FOREIGN KEY (clinic_id,service_id) REFERENCES services(clinic_id,id)
);
-- The requester cannot manufacture an approval by supplying a manager's account id.
-- A manager must execute the action in their own authenticated session.
ALTER TABLE stock_movements ADD COLUMN override_approved_by uuid REFERENCES accounts(id);
ALTER TABLE stock_movements ADD COLUMN override_reason text;
ALTER TABLE stock_movements ADD CONSTRAINT stock_override_pair CHECK
  ((override_approved_by IS NULL AND override_reason IS NULL) OR
   (override_approved_by IS NOT NULL AND coalesce(length(trim(override_reason)),0) > 0));
ALTER TABLE surgeries ADD COLUMN charge_line_id uuid;
ALTER TABLE surgeries ADD CONSTRAINT surgery_charge_fk FOREIGN KEY (clinic_id,charge_line_id) REFERENCES charge_lines(clinic_id,id);
CREATE UNIQUE INDEX surgery_charge_once ON surgeries(charge_line_id);
CREATE UNIQUE INDEX stock_charge_once ON stock_movements(charge_line_id) WHERE reason='dispense';
