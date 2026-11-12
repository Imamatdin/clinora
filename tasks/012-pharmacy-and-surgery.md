# Task 012: pharmacy stock and surgery (increment C10)

Assigned to: Claude Code (builder). Review: Codex. Planner: 12 November 2026.
Base: `main` after 008. Branch: `task-012-pharmacy-surgery`. Parallel with the other feature tasks.
Owns: `src/modules/{pharmacy,surgery}/**`, `src/server/routes/{pharmacy,surgery}.ts`, `src/web/{pharmacy,surgery}/**`, `src/web/i18n/{pharmacy,surgery}.*`, tests.
Read: `docs/DATA-MODEL.md` Pharmacy stock and surgery, `docs/1C-BASELINE.md` (Дорилар, Товары, Дори_ДармонПриходи, ХИРУРГИЯ).

## Build
1. Stock receipt: add incoming stock for a medicine or good (quantity, unit cost, supplier, note).
2. Dispense action `dispense(visitId, serviceId, qty)`: in one transaction writes a negative stock movement and a charge line (price via `priceAt`); export it for tasks 010 and 011 to call. Going below zero requires an override reason and ceo/administrator approval.
3. Stock screen: on hand per item, low-stock threshold per item (setting) with a "running low" list, movement history per item, adjustment with reason.
4. Surgery: record a surgery on a visit or admission (surgeon, operation service, time, optional operation note via the notebook), creating its charge line(s).
5. Role access: a pharmacy capability for administrators and a pharmacist (add role `pharmacy` through your own migration, update role lists and tests).

## Acceptance (CI)
- Stock on hand equals the sum of movements; concurrent dispenses of the last unit: one succeeds, one is rejected without override.
- Dispense creates exactly one movement and one charge line; retry with the same idempotency key creates nothing new.
- Override without approver rejected; with approver recorded in audit.
- Surgery charge appears on the patient bill.

Handoff at most 60 lines with PR and CI links.
