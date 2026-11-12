# Task 007: registration, visits and queues (increment C4)

Assigned to: Claude Code (builder). Review: Codex. Planner: 12 November 2026.
Base: `main` after 008 (core schema) is merged; runs in parallel with 005 using the seeded demo catalog. Branch: `task-007-registration`.
Read first: `docs/SPEC-CMS.md` sections 3, 5, 6, 14; `docs/PRODUCT.md` (ease-of-use rules, data model direction); `docs/1C-BASELINE.md` (КАБУЛ document, Туман and МФЙ catalogs).

## Goal

The registrar finds or registers a patient in under 60 seconds, picks doctors and services, and prints one queue ticket per doctor or service point. Routed doctors gain access to that patient; nobody else does.

## Build

1. Tables come from the core schema (`docs/DATA-MODEL.md`): patients (registration columns), patient_counters, visits, queue_points, queue_counters, queue_tickets, charge_lines. Charge lines created here are `ordered` with `unit_price_uzs` from `priceAt`. Work in `src/modules/registration/**`, `src/server/routes/registration.ts`, `src/web/registration/**`, `src/web/i18n/registration.*`.
2. Number allocation: use the core `nextQueueNumber` and `nextPatientNo` helpers inside the visit transaction, never `max()+1`.
3. Routing a patient to a doctor creates the `patient_assignments` row for that doctor, so task-002 assigned-scope access applies unchanged.
4. Search: by last 4+ phone digits, patient number, or name in any script (Cyrillic/Latin transliteration-insensitive match is a plus, document what you implement). Duplicate warning when name + birth date or phone already exists; the registrar can still proceed with a reason.
5. Registrar screen: one search box, results as large cards, "New patient" form with pick lists for district/mahalla/source, then "Who does the patient see?" with doctor and service pick lists showing today's queue length per point, then "Print tickets". Everything through i18n in three languages; number pad for phone; works at 360 px and on desktop.
6. Ticket printing: server-rendered HTML for 80 mm paper (readable at 58 mm), auto-opens the print dialog; one ticket per queue point with clinic name, patient number, queue point, number, date and time. No diagnosis on tickets.
7. Queue board API for doctors (list own tickets for today, call next, mark in progress); the doctor UI comes in C6 but expose and test the API now.
8. Every action is a typed server action with idempotency key and audit, per PRODUCT.md "Agent layer".

## Acceptance (CI)

- 50 concurrent ticket requests for one point give 50 distinct consecutive numbers; repeating a request with the same idempotency key gives the same ticket.
- No open business day: visit creation rejected; tickets never cross days; numbering restarts each day.
- Routed doctor can read the patient; an unrouted doctor gets 404; registrar cannot read clinical notes.
- Charge lines store the price in force at creation; changing the catalog price later does not change them.
- Duplicate warning appears for same phone or same name + birth date.
- Browser test: registrar registers a new patient, routes to two doctors and lab, prints three tickets; returning patient found by last 4 phone digits.

Return a handoff of at most 60 lines with the PR link and CI run link.
