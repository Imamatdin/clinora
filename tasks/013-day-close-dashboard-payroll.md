# Task 013: day close, CEO dashboard, doctor pay, Telegram daily report (increment C8)

Assigned to: Claude Code (builder). Review: Codex. Planner: 12 November 2026.
Base: `main` after 008. Branch: `task-013-ceo`. Parallel with the other feature tasks (reads their tables; build against the seeded demo data).
Owns: `src/modules/{reports,payroll}/**`, `src/server/routes/{reports,payroll}.ts`, `src/web/{ceo,reports}/**`, `src/web/i18n/{ceo,reports}.*`, tests.
Read: `docs/SPEC-CMS.md` section 13, `docs/PRODUCT.md` decisions (doctor split visible to the doctor), billing library doctor shares (after 003B1).

## Build
1. Business-day close (extends 003A's close): refuses while cash shifts are open; writes `close_snapshot` with patients (new/returning, outpatient/inpatient), service value, discounts, collected by method, refunds, cash outs, outstanding balances, per doctor and department; printable cash report on 80 mm and A4.
2. CEO dashboard (phone first): today live and any date range; every number recomputed from records, each tappable down to the lines behind it.
3. Doctor split rules: CEO sets per doctor (share, basis, discount bearer, counted service kinds, effective date); history kept; each doctor sees own rule, its history and own earnings for any period.
4. Payroll: compute per doctor per period with the billing library; finalize writes immutable `payroll_lines`; export PDF and Excel.
5. Exports (CEO only): reports to PDF and Excel; full clinic data export (CSV zip) with audit event.
6. Telegram daily report: on day close, send the CEO a notice with totals and a button to the report (no patient names), via the task-004 notification service when merged.

## Acceptance (CI)
- Day close totals equal sums of payments, refunds and cash outs for that day; closing with an open shift is rejected.
- Dashboard numbers match a direct SQL recomputation on the demo data.
- A split change dated tomorrow does not change today's payroll; a finalized period never changes.
- A doctor reads only their own rule and earnings; non-CEO roles get 403 on exports.
- Daily report payload contains no patient fields.

Handoff at most 60 lines with PR and CI links.
