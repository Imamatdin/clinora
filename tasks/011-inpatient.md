# Task 011: inpatient (increment C7)

Assigned to: Claude Code (builder). Review: Codex. Planner: 12 November 2026.
Base: `main` after 008. Branch: `task-011-inpatient`. Parallel with the other feature tasks.
Owns: `src/modules/inpatient/**`, `src/server/routes/inpatient.ts`, `src/web/inpatient/**`, `src/web/i18n/inpatient.*`, tests.
Read: `docs/SPEC-CMS.md` section 7, `docs/DATA-MODEL.md` Inpatient, billing library `countBedDays`.

## Build
1. Admit: from a visit (type inpatient) choose department, attending doctor, room and free bed (bed map per room showing free/occupied), expected discharge.
2. Transfer between beds (closes one assignment, opens another, same timestamp).
3. Daily charges: an idempotent job (run on demand and on business-day open) that creates one bed-day charge line per admission per date via `bed_day_charges`, using the clinic's bed-day rule and the bed's service price at that date; same for caretakers with a daily service. Rerunning adds nothing.
4. Ward screen (phone): my patients by room, add services and medicines to a stay (charge lines, source inpatient; medicine dispensing calls the pharmacy action from task 012 when merged, otherwise creates the charge line only and records a TODO in the handoff).
5. Caretakers: optional, name and phone, optional daily charge.
6. Discharge: final invoice (all lines across the stay via billing library), printable A4 PDF, frees the bed; unpaid balance shown to the cashier.

## Acceptance (CI)
- Spec example (5 bed days at 100 000 plus lab 250 000, ultrasound 150 000, other 100 000) totals exactly 1 000 000.
- Daily job rerun is a no-op; a transfer mid-stay charges each date once at the right bed's price.
- A bed cannot hold two open assignments; discharged stays accept no new charges.
- Bed-day rule changes apply to dates after the change only.
- Browser test: admit, add a service, run daily charges for 3 days, transfer, discharge, print invoice.

Handoff at most 60 lines with PR and CI links.
