# C8 reporting and payroll

All routes are under `/api/clinics/:clinicId`. JSON POSTs use the existing session and CSRF guard.

| Route | Access | Behavior |
| --- | --- | --- |
| POST `reports/dashboard` | CEO | `{from,to}` ISO dates, inclusive, at most 367 calendar dates |
| GET `reports/days` | CEO, administrator, cashier | Available business days |
| GET `reports/days/:id` | CEO, administrator, cashier | Persisted close snapshot, or live open-day report |
| POST `reports/days/:id/print` | CEO, administrator, cashier | `{format:"pdf"\|"thermal"}`, A4 or 80 mm cash report |
| POST `reports/export` | CEO | `{from,to,format:"pdf"\|"xlsx"}` |
| POST `reports/full-export` | CEO | `{}`, clinical/operational CSV ZIP, with audit event |
| GET `payroll/rules` | CEO, doctor | Doctor roster and dated rule history; doctors receive only their own |
| POST `payroll/rules` | CEO | Append a dated rule, never replace one or backdate into a final period |
| POST `payroll/earnings` | CEO, doctor | `{from,to}`; doctors receive only their own earnings |
| POST `payroll/finalize` | CEO | Freeze a closed, nonfuture period; exact duplicate is a safe replay |
| POST `payroll/export` | CEO | `{from,to,format:"pdf"\|"xlsx"}` |

Downloads return `{name,mime,base64}` through the authenticated JSON client. PDFs are generated on the server using the bundled Uzbek-capable font. XLSX monetary cells are explicit text to preserve whole-UZS precision, including values beyond Excel's numeric precision. CSV cells neutralize spreadsheet formulas. Authentication secrets and transient raw audio are excluded from the data archive.

## Meanings and consistency

- Patient counts are distinct patients in the selected visit cohort. New means the first noncancelled visit is in the selected period. Outpatient and inpatient cohorts may overlap.
- Service value, discounts and outstanding balance describe visits belonging to the selected business days, valued as of the end date. Gross collections, refunds and cash outs describe their own posting business days; a later payment on an older visit still counts on its receipt day.
- Net receipts = collections minus refunds. Cash outs are shown separately. Clinic-funded doctor entitlement is never revenue.
- Doctor/department revenue follows payment allocations and signed allocation corrections. Their service, patient, discount and debt drilldowns use the visit cohort.
- A single SQL statement captures the reporting source ledgers under one MVCC snapshot. Monetary SQL JSON projections cast bigint to text before parsing; calculations use bigint throughout.
- Close locks the business day, rejects open shifts, reconciles the ledgers, stores the report and queues a notice in the same transaction. New financial writes take a shared day lock, preventing races across the close boundary. Old empty pre-C8 snapshots are left untouched and fall back to a recomputation.
- Cash-print reports include each shift's opening cash, expected cash, counted cash and discrepancy. No printer-specific driver integration is claimed.

## Payroll and notifications

The existing billing library remains the sole share calculator. A charge uses the rule effective on its visit's business date. Missing rules block a calculation instead of inventing a split. Period earnings are changes in cumulative entitlement; later receipts do not pay a billed entitlement twice, and later refunds carry signed corrections forward.

Finalization writes append-only `payroll_lines` and a daily accrual snapshot. Arbitrary subperiods use frozen daily accruals for finalized dates and live accruals elsewhere. Overlapping final periods are rejected. The final-period API never returns the full internal daily snapshot to a doctor.

The close transaction stores a totals-only outbox row. After commit, the task-004 service resolves currently active CEO recipients and attempts delivery once. No real Telegram calls run in tests. Failed or uncertain sends remain recorded, without automatic blind retries; a process crash between commit and dispatch leaves an unattempted outbox row for operational reconciliation.
