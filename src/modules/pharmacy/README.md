# Pharmacy and surgery integration (task 012)

`dispense(ctx, { visitId, serviceId, qty, idempotencyKey, overrideReason? })` is
exported from `actions.ts` for doctor/inpatient actions. Call it inside
`transaction(pool, tx => ...)`, with the signed-in actor and clinic. It rechecks
current membership/roles, and doctors need a patient assignment. Never catch an
action failure and commit the enclosing transaction. Stock movement, completed
charge and audit commit together. Quantity is whole units; money is whole UZS
transported as decimal strings. All stock actions lock the same service row
before summing movements so concurrent depletion cannot race.

Routes under `/api/clinics/:clinicId`:

- GET `pharmacy/stock`, `pharmacy/visits`, `pharmacy/stock/:serviceId/history`.
- POST `pharmacy/receipts`: serviceId, qty, unitCostUzs, supplier, optional note.
- POST `pharmacy/dispense`: visitId, serviceId, qty, optional overrideReason.
- POST `pharmacy/adjustments`: serviceId, signed qty, reason, optional overrideReason.
- POST `pharmacy/threshold`: serviceId, threshold.
- GET `surgery/options`: permitted visits, active surgeons, surgery catalog and
  existing notebook documents belonging to those visits.
- POST `surgery`: visitId, surgeonId, serviceId, performedAt (ISO instant), optional
  admissionId and documentId. Admission and notebook document must match the visit.

All POST bodies carry `idempotencyKey` (8–200 characters). Reuse the same key and
payload after an uncertain response. Different payload with that key gives 409.
Keys are clinic/actor/action scoped. The UI keeps a key on failure until inputs
change. Authentication, CSRF and current authorization still apply on replay.

Pharmacy role, administrator and CEO can manage stock. Doctor/inpatient actors
can dispense through the shared action and API. To consume below zero, a CEO or
administrator executes the request themselves with a nonempty overrideReason;
the authenticated actor becomes the recorded approver. A pharmacist cannot
nominate another person's id as approval. Negative adjustments use the same rule.
Surgery is available to doctors, inpatient staff and managers. Doctors may only
record themselves on their assigned patients; the surgeon must be an active
doctor with an active profile. Closed visits/business days reject new charges.

Surgery and dispense write the shared `charge_lines` table. The cashier module
can read them without a separate billing adapter. Missing prices reject the
whole operation. Surgery resolves historical price at performedAt; dispense
resolves price at execution. Operation notes stay in the notebook; no note text
is copied into audit events. For a note to be offered, its encounter must have
the matching visit_id (the doctor module owns that linkage).

Stock history has no edit/delete route. Corrections are new signed adjustments.
Migration 012 adds the pharmacy role, per-item thresholds, override provenance
and an explicit surgery charge link without changing the core migration.
