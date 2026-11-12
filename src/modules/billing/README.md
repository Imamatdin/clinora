# Billing core (C2)

Pure TypeScript; public exports are in `index.ts`. No database, permissions, HTTP,
clock, provider calls or side effects. Monetary inputs and results are nonnegative
whole UZS. `uzs` accepts bigint, digit strings and safe integer numbers; all money
arithmetic uses bigint. Transport adapters must serialize bigint as decimal strings.

## Invoice contract

`calculateInvoice(lines, discounts?, transactions?)` returns all original lines,
totals, net per-line allocations and copied transaction events. Supply lines oldest
first (caller-owned chronological order). Ordered and completed lines are active;
cancelled lines retain their identity but have zero value and allocation.

At most one discount per line and one per visit are accepted. Line discounts apply
first; the visit discount applies proportionally to remaining payable values. Fixed
discounts cap at their base. Percentages floor. Largest-remainder ties use line ID
code-unit ordering, so rearranging lines never changes their discount amounts.
Discount input order is irrelevant. Reasons and approver IDs are mandatory; these
are validation, not authorization.

Supply payments/refunds in chronological order with distinct event IDs. Each payment
fills the oldest outstanding lines; each refund unwinds the newest outstanding
allocation lots. Repayments create new lots. Overpayments, over-refunds and zero
transactions throw. The output allocations are net of refunds. Duplicate IDs throw;
the later persistence/API layer must enforce request idempotency and append-only
storage, including links from reversals to original transactions. This library does
not rewrite or persist events. Replaying against edited charges can reject an old
payment; the caller must reconcile changes, never discard ledger events.

Status: fully returned receipts => refunded; zero due => paid (including empty and
fully discounted invoices); positive net receipts => partially_paid; otherwise unpaid.
Partial refunds leave partially_paid unless all receipts have been returned.

## Doctor shares

`calculateDoctorShares(invoice.lines, doctorId, rule)` filters active lines by doctor
and eligible categories. `billedBasisAmount` preserves the specified gross formula.
Paid basis scales it by net allocation / line payable, with integer flooring.

Clarification approved by Imamatdin, 12 November 2026:

- `doctorFromReceipts + clinicShare = amountReceived` on every line.
- `doctorEntitlement = doctorFromReceipts + clinicFundedShare`.
- Only the clinic discount bearer may have clinic-funded entitlement. For other
  bearers distributable entitlement is capped at receipts, including billed basis;
  the uncapped accrual remains available as `billedBasisAmount`.
- A zero-payable line on paid basis has full billed entitlement when the clinic
  bears the discount; otherwise entitlement is zero. Never divide by zero.

Clinic funding is a separate obligation, not collected revenue. These results do
not pay a doctor, enforce approval, or choose the clinic's split rule.

## Bed days

`countBedDays` accepts validated `YYYY-MM-DD` clinic-local dates; the caller converts
timestamps to Asia/Tashkent first. Closed stays count interior dates plus configured
admission/discharge dates. Same-day stays count the date at most once, then apply
the minimum. Open stays require an explicit as-of date and include that current day;
the discharge flag applies only to actual discharge. Invalid/reversed dates throw.

Run `npm run typecheck` and `npm run test:unit`. Billing tests include deterministic
edge cases and fast-check properties; shrinking failures report a replay seed/path.
