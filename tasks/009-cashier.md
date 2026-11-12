# Task 009: cashier (increment C5)

Assigned to: Claude Code (builder). Review: Codex. Planner: 12 November 2026.
Base: `main` after 008. Branch: `task-009-cashier`. Parallel with 005, 007, 010-013.
Owns: `src/modules/cashier/**`, `src/server/routes/cashier.ts`, `src/web/cashier/**`, `src/web/i18n/cashier.*`, tests.
Read: `docs/SPEC-CMS.md` sections 10-12, `docs/DATA-MODEL.md` Cashier, `src/modules/billing/README.md` (use the 003B library for all money math).

## Build
1. Shifts: open a shift on a cash desk with opening cash (one open shift per desk, only within an open business day); close with counted cash; close report (expected cash = opening + cash payments - cash refunds - cash outs; difference shown) stored in `close_report` and printable on 80 mm.
2. Patient bill: find by patient number, phone digits or queue ticket; show charge lines, discounts, paid, due using `billing` invoice functions. Lines grouped by doctor or department.
3. Discounts: percent or fixed, line or visit, reason required, approver must hold ceo or administrator role (cashier may request; approval by PIN of the approver on the same device, or later from their phone). Void with reason. All audited.
4. Payments: cash, card, transfer; full or partial; idempotency key from the client per press; allocations computed by `billing` and stored in `payment_allocations`; receipt number from the core counter; receipt snapshot stored; print 80 mm HTML. Overpayment rejected.
5. Refunds: against a specific payment, not more than paid, reason required, ceo/administrator approval, reverses allocations newest first, refund receipt.
6. Cash out: expense type, amount, note, from the open shift; printable slip.
7. Screen: one big "Take payment" action, number pad, confirmation in words ("Aliyevdan 250 000 сўм нақд оламизми?"), success with print.

## Acceptance (CI)
- Double press with the same key records one payment; two different keys record two.
- Balance identities from the billing library hold after any sequence of payments, refunds and discounts.
- Cashier without approval cannot apply a discount or refund; laboratory/doctor roles get 403 on all cashier routes.
- Shift close expected cash equals the arithmetic of its own movements; a closed shift accepts nothing.
- Payment outside an open business day or without an open shift is rejected.
- Browser test: open shift, take a partial cash payment and a card payment, apply an approved discount, refund part, cash out, close shift, print report.

Handoff at most 60 lines with PR and CI links.
