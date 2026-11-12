# Task 019: review fixes, access and records (003C, 004, 005, 007, 010)

Assigned to: Claude Code or Codex (builder). Review: the other model. Planner: 13 November 2026.
Base: `main`. Branch: `task-019-fixes`. Parallel with 020 and 021. Migration, if needed: `019_*.sql`.
Source: Codex review of merged `main` at `6fa5e1a` (findings quoted below). Each fix gets a regression test that fails before the fix.

1. **P1 Assistant approval drops manual notes and prescriptions** (`src/modules/assistant/service.ts:184-197`). Approval must start from the current document version, carry forward every notebook field and `rx.lines` the assistant did not change, and require the expected document revision so an intervening manual save is rejected as stale with a clear message.
2. **P1 Telegram replay bypass by reordering initData** (`src/modules/telegram/init-data.ts:65-66`). Fingerprint the canonical authenticated data (sorted data-check string plus hash), not the raw string.
3. **P1 Call next discloses a patient after assignment revocation** (`src/modules/registration/actions.ts:97, 346-349`). The active-ticket path and idempotent replay must recheck the current patient assignment; a revoked doctor gets no patient details.
4. **P2 Assistant routes ignore the shared-PC clinic restriction** (`src/server/assistant.ts:105-108`). Apply the same `actor.deviceClinicId` check as the main API to every assistant route.
5. **P2 New doctors cannot receive registrations** (`src/modules/catalog/actions.ts:250-256`). Linking a doctor profile creates or reactivates that doctor's queue point; deactivating the doctor deactivates it. Add queue-point management for service points (lab, ultrasound) in the catalog screen for administrators.
6. **P2 Reimporting an unchanged file undoes later prices** (`src/modules/import1c/plan.ts:143-146`). An identical file (same content hash) previously committed is reported as already imported and changes nothing. For a changed file, compare each price with the price last imported from 1C for that service (store import provenance on price rows), not with the current price, so manual prices made after an import survive.
7. **P2 Doctor Back button discards unsaved notes** (`src/web/doctor/screen.tsx:78`). Back goes through the navigation guard (save, discard or stay).

Acceptance: all regression tests pass with the existing suite; CI green. Handoff at most 40 lines.
