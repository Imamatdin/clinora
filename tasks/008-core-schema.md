# Task 008: core schema (unlocks parallel feature work)

Assigned to: Claude Code (builder). Review: Codex. Planner: 12 November 2026.
Base: `main`. Branch: `task-008-core-schema`. Start now; merge before 005, 007, 009-013 begin.
Read first: `docs/DATA-MODEL.md` (the contract), `docs/PRODUCT.md` non-negotiable rules.

## Goal

Every core table from `docs/DATA-MODEL.md` exists with its constraints, so feature tasks build in parallel without touching each other's schema. No feature logic and no UI here.

## Build

1. `db/migrations/010_core_schema.sql` implementing `docs/DATA-MODEL.md` exactly: tables, clinic-qualified foreign keys, checks, partial unique indexes, the append-only and status-transition triggers, minimum indexes. Existing data from migrations 001-002 must migrate cleanly (patients get `patient_no` assigned in creation order per clinic and `full_name` from `display_name`).
2. `src/contracts/db/*.ts`: zod schemas and TypeScript row types for every new table, one file per area (catalog, registration, queue, charges, cashier, lab, inpatient, stock, payroll). Feature tasks import these.
3. `src/server/repo/` helpers only where shared by several features: `priceAt(clinicId, serviceId, at)`, `nextPatientNo`, `nextQueueNumber`, `nextReceiptNo` (all row-lock counters inside the caller's transaction), and `withAudit(tx, actor, action, resource, detail)`.
4. Demo seed (`npm run db:demo`, refuses in production): a synthetic clinic with the full catalog shape (3 departments, 10 doctors with profiles and services, 40 services across all kinds with prices, 10 lab tests, room types, 8 rooms, 20 beds, districts and mahallas, 15 medicines with stock, expense types, 2 cash desks, split rules for each doctor) using realistic Uzbek names in all three scripts. Synthetic only.
5. Parallel-work plumbing so later tasks do not collide:
   - Server routes: a registry `src/server/routes/index.ts` where each feature adds one import line; each feature's routes live in its own file.
   - Web: a module registry for role home screens and navigation; each feature adds its screens in `src/web/<feature>/` and one registry line.
   - i18n: split dictionaries per feature, `src/web/i18n/<feature>.<locale>.ts`, merged by the i18n index; move the existing strings into `core.*`.

## Acceptance (CI)

- Fresh database and upgrade from a task-003A database both migrate; rerun is a no-op.
- Triggers proven by tests: payments/cash_outs/stock_movements/split rules/service_prices reject UPDATE and DELETE; charge line price and quantity immutable; illegal status transitions rejected; discount needs reason and approver; one open shift per desk; one open bed assignment per bed.
- A row in clinic A cannot reference a row in clinic B (FK failure test).
- `priceAt` returns the right price around a price change; counters give distinct values under 50 concurrent calls.
- Existing tests from 001-003A still pass.

Return a handoff of at most 60 lines with the PR link and CI run link.
