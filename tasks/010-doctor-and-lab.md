# Task 010: doctor and lab workspaces (increment C6)

Assigned to: Claude Code (builder). Review: Codex. Planner: 12 November 2026.
Base: `main` after 008. Branch: `task-010-doctor-lab`. Parallel with 005, 007, 009, 011-013; coordinate with 003C, which owns the assistant inside the visit note.
Owns: `src/modules/doctor/**`, `src/modules/lab/**`, `src/server/routes/{doctor,lab}.ts`, `src/web/{doctor,lab}/**`, `src/web/i18n/{doctor,lab}.*`, tests.
Read: `docs/SPEC-CMS.md` sections 4.4, 8, `docs/DATA-MODEL.md`, task-002 notebook code (visit notes reuse encounters/documents/document_versions).

## Build
1. Doctor home (phone first, Telegram Mini App and installed app): today's own queue with statuses, big "Call next" button, current patient card with history (previous visits, diagnoses, lab results).
2. Visit: open the encounter linked to the visit (create on first open), write the note (task-002 notebook, approval versions intact), mark consultation completed (completes the doctor's consultation charge line), add services or lab orders from the catalog (new charge lines, source doctor, price via `priceAt`).
3. Prescription: structured lines (medicine, dose, frequency, duration, notes) saved in the approved note version; server-rendered A4 PDF with clinic header, patient, doctor, date; printable and viewable on phone.
4. Lab workspace: list of ordered lab lines for today, filter by status; enter results per test (values with units and reference ranges, comment) as `lab_results` versions; confirm completes the charge line once; doctor sees results on the patient card.
5. Fix from 003C: after a visit is approved through the assistant, the notebook timeline must show the approved version (not "unapproved, revision 0"), and editing after approval must start an explicit amendment that references the approved version instead of a silent newer draft.
6. Leave a clear slot in the visit screen where 003C's assistant panel mounts (one registry line).

## Acceptance (CI)
- Doctor sees only own queue and routed patients; another doctor's patient returns 404.
- Completing a consultation or a lab test twice completes the line once.
- Lab role cannot read notes or touch payments; doctor cannot edit lab results.
- Approved note versions remain immutable; prescription PDF reflects the approved version exactly.
- Browser test at 360 px: doctor calls next, writes and approves a note with a prescription, orders a lab test; lab enters and confirms the result; doctor sees it.

Handoff at most 60 lines with PR and CI links.
