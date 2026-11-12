# Delivery increments (clinic system)

Updated 12 November 2026. Increments are ordered by dependency. Each ends at a gate: the listed checks pass in CI on GitHub-hosted runners before the next increment that depends on it starts. Independent increments run in parallel on separate branches.

| # | Delivered behavior | Gate |
| --- | --- | --- |
| C1 | Roles, staff sign-in by login/phone, administrator manages staff, business day open/close, role-based navigation, Uzbek Cyrillic shell | Wrong-role API calls return 403 for every new route; one open day per clinic enforced by the database; i18n has no hardcoded UI strings |
| C2 | Billing core library: money type, invoice math, discounts, payment allocation, refunds, doctor split calculation, bed-day counting (pure TypeScript, no DB) | Unit and property tests cover every rule in the brief; no floats in money paths |
| C3 | Catalog: departments, categories, services, price history, doctors and their services; CSV/JSON import | Charges resolve the price at record time; import is idempotent and reports rejected rows |
| C4 | Registration, visits, routing, queue tickets with printing | 50 concurrent ticket requests for one point produce 50 distinct consecutive numbers; duplicate patient warning; routed doctor gains access, others do not |
| C5 | Cashier: charge lines, discounts with reason and approver, partial payments, cash/card, refunds, receipts on 58/80 mm thermal paper | Double submit records one payment; balance identities hold (value - discount - paid = due); receipt prints from Chrome on Windows |
| C6 | Doctor and laboratory workspaces: own queue, consultation status, visit notes (task-002 notebook), prescription PDF; lab confirms tests, charges post once | Doctor cannot read another doctor's patient; lab cannot touch payments; repeated lab confirm posts one charge |
| C7 | Inpatient: admissions, rooms and beds, transfers, daily bed charges, configurable bed-day rule, discharge invoice | Spec example (5 bed days + services) totals 1,000,000 UZS exactly; rerunning the daily job adds nothing |
| C8 | Day close, cashier cash report (printable), CEO dashboard, reports, doctor split and payroll report, CEO-only export (PDF/Excel) | Day close total equals sum of payments for that day; every dashboard number recomputes from records |
| C9 | PWA install, offline-tolerant registration and queue, deployment, backups, go-live checklist with parallel run | Installs on Android and Windows; registration made offline syncs once without duplicates; restore from backup tested |

After C9: AI documentation from conversation on visit notes, Telegram, inpatient patient app, external integrations (the earlier increments 3-7).

## Process rules (speed)

- Handoff: 60 lines maximum, using `HANDOFF_TEMPLATE.md` headings. Link CI run URLs; do not commit CI logs into `docs/verification/`.
- Write a failing test first only for security or money defects. Otherwise write the tests alongside the code.
- Keep heavy work (PostgreSQL, browser tests, builds) on GitHub-hosted runners. Imamatdin's laptop has 8 GB RAM.
- Run the Windows job only on pull requests. Linux job on every push.
- One task per branch. Rebase on `main` before opening the PR. Do not edit files owned by another active task.
