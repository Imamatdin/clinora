# Task 020: review fixes, offline, inpatient, pharmacy, surgery (011, 012, 016)

Assigned to: Claude Code or Codex (builder). Review: the other model. Planner: 13 November 2026.
Base: `main`. Branch: `task-020-fixes`. Parallel with 019 and 021. Migration, if needed: `021_*.sql`.
Source: Claude review of merged code. Each fix gets a regression test that fails before the fix.

1. **P1 Offline registrations wiped on user switch** (`src/web/registration/outbox.ts:45,55`, `offline.tsx:109,132`). Planner decision: never delete queued items that patients hold tickets for. Keep them locked to the user who created them (as the session-expiry path does with `lockOutbox`), show any user on that device a banner "N offline registrations waiting for <name> to sign in", and sync them when that user signs in again. FORBIDDEN or lost role: keep them locked and tell an administrator on that device; never silently clear. Revoking the device is the only path that deletes them, after a confirmation that names the count.
2. **P3 One offline conflict blocks every later entry** (`offline.tsx:122`). Move the conflicting entry to the attention list and continue syncing the rest in order.
3. **P1 Surgery and pharmacy pickers hide patients admitted on earlier days** (`src/modules/surgery/actions.ts:169`, `src/server/routes/pharmacy.ts:179`). `visitOptions` includes visits with an active admission regardless of business day, matching `visitForCharge`. Test: admit on day 1, close day, open day 2, record surgery and dispense.
4. **P2 Discharge invoice frozen after discharge** (`src/modules/inpatient/actions.ts:223-224`). Keep the lines frozen at discharge, compute paid and due live; the PDF shows "lines as of discharge, payments as of <now>".
5. **P2 Backdated bed-day charges** (`src/modules/inpatient/actions.ts:170,180`). `created_at` is the real creation time; the billed date lives in `bed_day_charges.charge_date` (and caretaker equivalent). Task 021 relies on this.
6. **P3 Ward cannot dispense out-of-stock medicine even with approval** (`inpatient/contracts.ts`, `actions.ts:138`). Pass an override reason and an approver (CEO or administrator by PIN on the same device) through to the pharmacy dispense action.
7. **P3 Dispense retry after visit close returns NOT_FOUND** (`pharmacy/actions.ts:82`). Look up the idempotency key before checking the visit.

Acceptance: regression tests pass with the existing suite; CI green. Handoff at most 40 lines.
