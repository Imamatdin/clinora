# Task 003B1: billed-basis doctor entitlement (correction to 003B)

Assigned to: Claude Code or Codex (small, self-contained). Planner: 12 November 2026.
Base: `main`. Branch: `task-003b1-billed-entitlement`. Touch only `src/modules/billing/**` and `tests/billing-*.test.ts`.

## Why

The 003B brief told you to cap non-clinic-bearer entitlements at receipts. That was the planner's mistake: it turns "billed" basis into "paid" basis whenever an invoice is unpaid or partly paid. On billed basis the doctor earns on what was billed, whether or not the patient has paid yet; the clinic advances the uncollected part.

## Change

Per line, for both bases keep `doctorFromReceipts + clinicShare = amountReceived` exactly as now, and define:

- Billed basis: `doctorEntitlement = billedBasisAmount` (the formula for the chosen discount bearer, never capped by receipts). `doctorFromReceipts = min(doctorEntitlement, amountReceived)`. `clinicFundedShare = doctorEntitlement - doctorFromReceipts`, for every discount bearer.
- Paid basis: unchanged from the merged code (scaled by allocated paid / line payable; zero-payable rule as approved).
- `clinicFundedShare >= 0` always. Update the README section and the property tests accordingly; add explicit cases: unpaid line on billed basis for each bearer, half-paid line, fully paid line, 100% discount for each bearer.

## Acceptance

All existing invariants still hold; new cases pass; typecheck clean; CI green. Handoff at most 30 lines.
