# Task 003B: billing core library (increment C2)

Assigned to: Codex. Planner: 12 November 2026.
Base: `main` after PR #1 is merged. Branch: `task-003b-billing-core`.
Read first: `docs/PRODUCT.md` (non-negotiable rules), `docs/SPEC-CMS.md` sections 7, 10, 11 and 13.

## Goal

A pure TypeScript library that every money feature will call: invoice totals, discounts, payment allocation, refunds, doctor revenue shares and inpatient bed days. No database, no HTTP, no UI. Exhaustively tested so the cashier, payroll and CEO reports can trust it.

Owned files: `src/modules/billing/**` and `tests/billing-*.test.ts`. You may add `fast-check` as a dev dependency. Touch nothing else (task 003A is editing the server, migrations and web app in parallel).

## Rules to implement

Money
- `Uzs` is a branded `bigint` of whole UZS. Constructors reject non-integers, negatives where not allowed, and numbers outside the safe range. Formatter for display: digit groups separated by a space, suffix `сўм` (example: `1 000 000 сўм`).

Charge lines and invoice
- A line: `{ id, unitPrice: Uzs, quantity: positive integer, status: 'ordered' | 'completed' | 'cancelled', category, doctorId? }`. Cancelled lines count for nothing.
- Invoice: `value` (sum of active lines), `discount`, `payable = value - discount`, `paid = payments - refunds`, `due = payable - paid`, and status `unpaid | partially_paid | paid | refunded`. `due` is never negative.

Discounts
- Percent discounts are integer basis points 0-10000; fixed discounts are `Uzs`. Line-level or visit-level.
- Percent amount = floor(base * bp / 10000).
- A discount never exceeds the value it applies to. 100% gives payable 0 with every line still present.
- Visit-level discounts are spread across active lines in proportion to line value using the largest-remainder method, so per-line discounts sum exactly to the visit discount.
- Every discount requires a non-empty reason and an approver id (validated here, enforced again in the API later).

Payments and refunds
- A payment is allocated to lines oldest first, against each line's payable amount. Paying more than `due` is rejected.
- A refund cannot exceed `paid`. It reverses allocations newest first.
- Output the per-line allocation so payroll can use it.

Doctor share
- Rule: `{ doctorShareBp, basis: 'billed' | 'paid', discountBearer: 'clinic' | 'doctor' | 'proportional', categories: string[] }` (only lines in `categories` count).
- Per line, billed basis:
  - clinic bears discount: floor(value * bp / 10000)
  - doctor bears discount: max(0, floor(value * bp / 10000) - lineDiscount)
  - proportional: floor((value - lineDiscount) * bp / 10000)
- Paid basis: the billed-basis amount scaled by allocatedPaid / linePayable, floored. A fully paid line gives the billed-basis amount.
- Clinic share = line amount received minus doctor share. Doctor plus clinic always sums to the money involved, never more.

Bed days
- Rule: `{ countAdmissionDay: boolean, countDischargeDay: boolean, minimumDays: integer >= 1 }`, dates as `YYYY-MM-DD` already converted to Asia/Tashkent.
- Days = calendar days between admission and discharge, adjusted by the two flags, never below `minimumDays`. An open admission counts up to a given "as of" date.

## Acceptance

- Spec example: 5 bed days at 100,000 + lab 250,000 + ultrasound 150,000 + other 100,000 = 1,000,000 UZS.
- Spec example: 500,000 service with 100% discount gives payable 0, line kept.
- Property tests (fast-check): per-line discounts sum to the visit discount; allocations sum to paid; doctor share + clinic share equals amount received on every line; `due >= 0` after any valid sequence of payments and refunds; no result depends on line input order except allocation order.
- Typecheck clean; the new tests run in `npm run test:unit` on Linux and Windows CI.

Return a handoff of at most 60 lines with the PR link and CI run link.
