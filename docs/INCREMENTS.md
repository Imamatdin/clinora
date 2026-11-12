# Delivery increments (clinic system)

Updated 12 November 2026. Increments are ordered by dependency. Each ends at a gate: the listed checks pass in CI on GitHub-hosted runners before the next increment that depends on it starts. Independent increments run in parallel on separate branches.

| # | Delivered behavior | Gate |
| --- | --- | --- |
| C1 | Roles, staff sign-in by login/phone, administrator manages staff, business day open/close, role-based navigation, Uzbek Cyrillic shell | Wrong-role API calls return 403 for every new route; one open day per clinic enforced by the database; i18n has no hardcoded UI strings |
| C2 | Billing core library: money type, invoice math, discounts, payment allocation, refunds, doctor split calculation, bed-day counting (pure TypeScript, no DB) | Unit and property tests cover every rule in the brief; no floats in money paths |
| C3 | Catalog: departments, categories, services, price history, doctors and their services; import from the clinic's 1C `.dt` dump (catalog objects only, see `docs/1C-BASELINE.md`) and from 1C list exports (.xlsx and CSV); names in uz-Cyrl, uz-Latn and ru; preview before commit | Charges resolve the price at record time; import is idempotent and reports rejected rows; a real export from Gʻofurov klinikasi imports cleanly |
| C4 | Registration, visits, routing, queue tickets with printing | 50 concurrent ticket requests for one point produce 50 distinct consecutive numbers; duplicate patient warning; routed doctor gains access, others do not |
| C5 | Cashier: cash desks and shifts, charge lines, discounts with reason and approver, partial payments, cash/card, refunds, cash out with expense types, receipts on 58/80 mm thermal paper | Double submit records one payment; balance identities hold (value - discount - paid = due); receipt prints from Chrome on Windows |
| C6 | Doctor and laboratory workspaces: own queue, consultation status, visit notes (task-002 notebook), prescription PDF; lab confirms tests, charges post once | Doctor cannot read another doctor's patient; lab cannot touch payments; repeated lab confirm posts one charge |
| C7 | Inpatient: admissions, rooms and beds, transfers, caretakers staying with the patient and their charges, daily bed charges, configurable bed-day rule, discharge invoice | Spec example (5 bed days + services) totals 1,000,000 UZS exactly; rerunning the daily job adds nothing |
| C8 | Day close, cashier cash report (printable), CEO dashboard, reports, doctor split and payroll report, CEO-only export (PDF/Excel) | Day close total equals sum of payments for that day; every dashboard number recomputes from records |
| C9 | PWA install, offline-tolerant registration and queue, deployment (staging separate from production, demo seeding off in production), backups, go-live checklist with parallel run | Installs on Android and Windows; registration made offline syncs once without duplicates; restore from backup tested; login rate limiting keyed per account so a whole clinic behind one public IP is never locked out; TLS, secure cookies and trusted-proxy settings verified on the real host |

| C10 | Pharmacy stock (medicines, goods, stock receipts, dispensing charges) and surgery charges; in go-live scope (decided 12 Nov) | Stock never goes negative without an explicit override; every dispense links to a visit and a charge |

After C9 and C10: AI documentation from conversation on visit notes, Telegram, inpatient patient app, external integrations. Detailed briefs from the previous planner are kept in `docs/backlog/ai-documentation/` (their task numbers 003-006 are superseded by this table; renumber when scheduled). Accounting stays in the clinic's 1C; a daily export to 1C is a later integration, not a replacement of 1C accounting.

## Process rules (speed)

- Handoff: 60 lines maximum, using `HANDOFF_TEMPLATE.md` headings. Link CI run URLs; do not commit CI logs into `docs/verification/`.
- Write a failing test first only for security or money defects. Otherwise write the tests alongside the code.
- Keep heavy work (PostgreSQL, browser tests, builds) on GitHub-hosted runners. Imamatdin's laptop has 8 GB RAM.
- Run the Windows job only on pull requests. Linux job on every push.
- One task per branch. Rebase on `main` before opening the PR. Do not edit files owned by another active task.
