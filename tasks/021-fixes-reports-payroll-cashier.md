# Task 021: review fixes, reports, day close, payroll, cashier (009, 013)

Assigned to: Claude Code or Codex (builder). Review: the other model. Planner: 13 November 2026.
Base: `main` after 020 merges (uses its bed-day `created_at` fix). Branch: `task-021-fixes`. Migration, if needed: `022_*.sql`.
Source: Claude review of merged code. Each fix gets a regression test that fails before the fix.

1. **P2 Inpatient charges missing from daily and range reports** (`src/modules/reports/actions.ts:97,105`). Attribute service value to the business day on which a charge line was created (for bed days, the day the charge was posted), not to the visit's date. Outstanding balance in the close snapshot and dashboard is clinic-wide as of that moment. Test: a 3-day stay; the sum of the three daily reports equals the range report.
2. **P2 Every report loads the entire clinic history** (`src/modules/reports/records.ts:27-42`, `business-days/actions.ts:50`, `payroll/actions.ts:177`). Filter by date range and clinic in SQL using existing indexes; do the heavy read before taking the business-day lock, then lock and verify nothing changed (or compute inside a short transaction). A doctor's own earnings read only that doctor's lines.
3. **P2 One unbalanced visit blocks the whole close** (`records.ts:72`). Skip and flag such a visit in the report ("needs review") instead of failing.
4. **P2 Payroll fails if any doctor lacks a split rule** (`payroll/actions.ts:141`). Show those doctors as "rule missing" with their lines; finalize refuses only while any listed doctor lacks a rule, with a clear message naming them.
5. **P3 Split rule for a future date cannot be corrected** (`payroll/actions.ts:130`). Allow replacing a rule whose effective date is in the future (audited); past and current rules stay immutable.
6. **P3 Approval PIN failures lock the approver's shared-PC PIN** (`cashier/actions.ts:317-323`). Count approval attempts separately per approver and device.
7. **P3 Discount void records the cashier, not the approver** (`cashier/actions.ts:431-435`). Store the approver on the void.
8. **P3 Cashier sees clinic-wide revenue detail** (`reports/actions.ts:159`). The cashier gets only the printable cash report for their own shifts and the day total.
9. **P3 Telegram day report sent inline** (`src/server/app.ts:88`, `reports/notify.ts`). Queue it in a small outbox table after commit; a background worker sends with retry; close returns without waiting.
10. **P3** Bump `fflate` to 0.8.3 or later (moderate advisory flagged by npm audit) and rerun the 1C import tests.
11. **P3** Write the missing `docs/HANDOFF-TASK-009` summary as part of this handoff (5 lines).

Acceptance: regression tests pass with the existing suite; CI green. Handoff at most 40 lines.
