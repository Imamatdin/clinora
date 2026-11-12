# Cashier (task 009)

Routes register under `/api/clinics/:clinicId/cashier`. Current cashier, CEO or
administrator membership is required on every route and action. Every mutation
runs inside the existing request transaction. Visits serialize balances; shifts
serialize movements and closing; shared business-day locks prevent payments racing
day close. Opening uses the schema's one-open-shift-per-desk constraint.

Money crosses JSON boundaries as decimal UZS strings. C2 computes invoices,
discounts, oldest-line-first payment allocations and newest-first refund reversals.
Refunds are restricted to the remaining balance of their specific original payment
and retain its method. Payment keys are clinic-unique, payload-checked and bound to
the receiving actor; retries return the original receipt without another movement.

Managers can approve directly in their authenticated workspace. Cashiers use a
manager's PIN: an approval credential is bound to actor, clinic, visit, operation
and typed payload, expires after five minutes and can be consumed once. Manager
roles and account status are rechecked at execution. Failed PIN checks return a
committed error response so failed-attempt counters persist; five failures lock the
existing account PIN. No PIN or reason text is put in general audit logs.

Discount changes may move existing net receipts between lines. Migration 011 adds
an append-only allocation correction ledger, preserving payment provenance and
original receipt snapshots. Consumers of per-line receipts must sum signed payment
allocations (refunds subtract) **and cashier_allocation_adjustments.delta_uzs**.
The invoice read and targeted refund actions already do so. Applying a discount
below total net receipts is rejected; refund the excess before applying it. At most
one active discount per target follows C2; void before replacing a discount.

Cash close stores opening cash, cash payments/refunds, cash outs, expected, counted,
difference and close time. Card and transfer payments do not inflate cash. Closed
shifts accept no movements. Close shifts before closing the business day.

The web module provides patient-number, phone-digit and queue-number lookup,
grouped bills, number pad, confirmation, approval, refund, cash-out and close
controls. Stored receipts can be reprinted after reload. Print HTML targets 80 mm;
actual printer/driver testing and deployment remain separate from browser tests.

Verification: `npm run typecheck`, `npm run test:unit`, and on CI PostgreSQL,
`npm run check`. Tests use isolated schemas and synthetic patients only.

Task 021: approval failures use a separate per-approver, per-enrolled-device counter,
with five failures causing a 15-minute cooldown. Password/Telegram sessions without
an enrolled device use the requesting account as the scope (new sessions do not reset it).
Shared-PC sign-in PIN counters are independent. A discount void stores the approving
manager in voided_by; its audit event retains the requesting cashier.
