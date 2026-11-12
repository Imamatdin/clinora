# Clinora data model (core schema contract)

Planner: 12 November 2026. Task 008 implements this as `db/migrations/010_core_schema.sql`. Feature tasks build on it in parallel and must not redefine these tables. A feature that needs a missing column adds its own migration named `0NN_<task>_<what>.sql` with the next free number at merge time (the runner applies by name and tracks applied files, so merge order is safe).

## Conventions

- Every table: `id uuid PRIMARY KEY` unless noted, `clinic_id uuid NOT NULL REFERENCES clinics(id)`, plus `UNIQUE (clinic_id, id)` so other tables can use clinic-qualified foreign keys `(clinic_id, x_id)`. Cross-clinic references are impossible by construction.
- Money: `bigint` whole UZS, named `*_uzs`, `CHECK (>= 0)` unless stated. Basis points: `integer` 0-10000, named `*_bp`.
- Names: `name_uz_cyrl text NOT NULL`, `name_uz_latn text`, `name_ru text` ("names" below). Imported rows keep `code_1c text`.
- Times: `timestamptz`. Business dates: `date`. Actor columns reference `accounts(id)`.
- Soft state: `is_active boolean NOT NULL DEFAULT true`. Nothing financial or clinical is ever hard-deleted.
- Append-only (UPDATE/DELETE raise via trigger, except the listed void/close columns): payments, payment_allocations, cash_outs, stock_movements, doctor_split_rules, service_prices, discounts (void columns only), receipts (print_count only), lab_results.
- Enums are `text` with `CHECK (... IN (...))`.

## Existing (tasks 001-003A, unchanged)

accounts, clinics (+timezone), memberships, membership_roles, sessions, invitations, patients, patient_assignments, encounters, documents, document_versions, idempotency_records, audit_events, business_days, login_limits. Task 003C owns `003_assistant.sql`; task 004 owns `004_device_access.sql`.

## Clinic settings

- `clinic_settings` (PK `clinic_id`): `default_locale` (uz-Cyrl|uz-Latn|ru), `bed_day_rule jsonb` ({countAdmissionDay, countDischargeDay, minimumDays}), `receipt_header jsonb` (name, address, phone, tax id), `updated_by`, `updated_at`.
- `accounts`: add `locale` nullable (personal override).

## Catalog

- `departments`: names, code_1c, is_active.
- `service_groups`: department_id null, names, code_1c, is_active.
- `services`: group_id null, department_id null, `kind` consultation|procedure|lab|diagnostic|bed|surgery|medicine|good|caretaker|other, names, code_1c, `unit` text default 'дона', `track_stock boolean DEFAULT false`, is_active.
- `service_prices`: service_id, `price_uzs`, `effective_from timestamptz`, set_by, created_at; UNIQUE (service_id, effective_from). Price at time t = latest row with effective_from <= t.
- `doctor_profiles`: PK (clinic_id, user_id) referencing memberships; department_id, `specialty` names, is_active.
- `doctor_services`: PK (clinic_id, user_id, service_id).
- `districts`: names, code_1c. `mahallas`: district_id, names, code_1c.
- `room_types`: names, code_1c. `rooms`: department_id null, room_type_id null, name, is_active. `beds`: room_id, label, `bed_service_id` (a service of kind bed, gives the daily price), is_active.
- `expense_types`: names, code_1c, is_active.

## Patients and registration

- `patients`: add `patient_no integer` (UNIQUE clinic_id, patient_no), `full_name`, `birth_date date`, `gender` male|female null, `phone` (E.164) null, `district_id` null, `mahalla_id` null, `address` null, `source` null. Keep existing columns.
- `patient_counters`: PK clinic_id, `last_no integer`.
- `visits`: patient_id, business_day_id, `type` outpatient|inpatient, `status` open|closed|cancelled, created_by, created_at, closed_at null.
- `encounters`: add `visit_id` null (clinic-qualified FK).

## Queues

- `queue_points`: `kind` doctor|department|service, user_id null, department_id null, service_group_id null, names, is_active.
- `queue_counters`: PK (business_day_id, queue_point_id), `last_number integer NOT NULL DEFAULT 0`.
- `queue_tickets`: business_day_id, visit_id, queue_point_id, `number integer`, `status` waiting|called|in_progress|completed|cancelled, created_at, called_at, started_at, completed_at; UNIQUE (business_day_id, queue_point_id, number); UNIQUE (business_day_id, queue_point_id, visit_id).

## Charges

- `charge_lines`: visit_id, service_id, performer_user_id null, queue_ticket_id null, `quantity integer CHECK (> 0)`, `unit_price_uzs`, `status` ordered|completed|cancelled, `source` registration|doctor|lab|inpatient|pharmacy|surgery|bed_day|caretaker|assistant, created_by, created_at, completed_by, completed_at, cancelled_by, cancelled_at, cancel_reason. Status moves only ordered -> completed, ordered -> cancelled, completed -> cancelled (with reason); price and quantity never change after insert (trigger).

## Cashier

- `cash_desks`: name, is_active.
- `cash_shifts`: cash_desk_id, business_day_id, cashier_user_id, opened_at, `opening_cash_uzs`, closed_at null, `counted_cash_uzs` null, `close_report jsonb` null, `status` open|closed. Partial UNIQUE: one open shift per desk.
- `discounts`: visit_id, charge_line_id null (null = whole visit), `kind` percent|fixed, `percent_bp` null, `amount_uzs` null (exactly one set), `reason text NOT NULL CHECK (length > 0)`, `approved_by NOT NULL`, created_by, created_at, voided_by, voided_at, void_reason.
- `payments`: visit_id, cash_shift_id, business_day_id, `kind` payment|refund, `method` cash|card|transfer, `amount_uzs CHECK (> 0)`, `refund_of` null (payments.id, required when kind = refund), `idempotency_key text NOT NULL` with UNIQUE (clinic_id, idempotency_key), received_by, created_at.
- `payment_allocations`: PK (payment_id, charge_line_id), `amount_uzs CHECK (> 0)`.
- `receipt_counters`: PK clinic_id, `last_no bigint`.
- `receipts`: `receipt_no bigint` (UNIQUE clinic_id, receipt_no), visit_id, payment_id null, `kind` payment|refund|invoice, `snapshot jsonb NOT NULL`, issued_by, issued_at, `print_count integer DEFAULT 0`.
- `cash_outs`: cash_shift_id, business_day_id, expense_type_id, `amount_uzs CHECK (> 0)`, note, created_by, created_at.

## Laboratory

- `lab_results`: charge_line_id, `version integer`, `result jsonb` (values, units, reference ranges, comment), entered_by, entered_at; UNIQUE (charge_line_id, version). Latest version is current.

## Inpatient and surgery

- `admissions`: visit_id (UNIQUE), department_id, attending_user_id, admitted_at, expected_discharge date null, discharged_at null, `status` admitted|discharged.
- `bed_assignments`: admission_id, bed_id, from_at, to_at null. Partial UNIQUE: one open assignment per bed and one per admission.
- `caretakers`: admission_id, full_name, phone null, from_date, to_date null, `daily_service_id` null (service of kind caretaker).
- `bed_day_charges`: PK (admission_id, charge_date), charge_line_id. Same for caretakers: `caretaker_day_charges` PK (caretaker_id, charge_date), charge_line_id.
- `surgeries`: visit_id, admission_id null, surgeon_user_id, service_id, performed_at, document_id null (operation note), created_by.

## Pharmacy stock

- `stock_movements`: service_id (track_stock = true), `qty integer CHECK (<> 0)` (positive in, negative out), `reason` receipt|dispense|adjustment|return, visit_id null, charge_line_id null, `unit_cost_uzs` null, supplier text null, note, created_by, created_at. Stock on hand = sum(qty). A dispense that would go below zero requires an adjustment reason and a CEO or administrator approver (enforced in the action, recorded in note/audit).

## Doctor pay

- `doctor_split_rules`: user_id, `doctor_share_bp`, `basis` billed|paid, `discount_bearer` clinic|doctor|proportional, `categories text[]` (service kinds counted), `effective_from date`, created_by, created_at. Rule in force on a date = latest effective_from <= date. Visible to that doctor.
- `payroll_periods`: from_date, to_date, `status` draft|final, finalized_by, finalized_at.
- `payroll_lines`: period_id, user_id, charge_line_id, rule_id, `entitlement_uzs`, `from_receipts_uzs`, `clinic_funded_uzs`; written when a period is finalized (snapshot, immutable).

## Indexes (minimum)

patients (clinic_id, phone), patients (clinic_id, lower(full_name)), visits (clinic_id, business_day_id), queue_tickets (business_day_id, queue_point_id, status), charge_lines (clinic_id, visit_id), payments (clinic_id, business_day_id), stock_movements (clinic_id, service_id), audit_events existing.
