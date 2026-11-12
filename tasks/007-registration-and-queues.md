# Task 007: registration, visits and queues (increment C4)

Assigned to: Claude Code (builder). Review: Codex. Planner: 12 November 2026.
Base: `main` after 005 (catalog) is merged. Branch: `task-007-registration`.
Read first: `docs/SPEC-CMS.md` sections 3, 5, 6, 14; `docs/PRODUCT.md` (ease-of-use rules, data model direction); `docs/1C-BASELINE.md` (КАБУЛ document, Туман and МФЙ catalogs).

## Goal

The registrar finds or registers a patient in under 60 seconds, picks doctors and services, and prints one queue ticket per doctor or service point. Routed doctors gain access to that patient; nobody else does.

## Build

1. Migration `007_registration.sql`:
   - Patients: add clinic-unique human patient number (sequence per clinic), full name, birth date, gender, phone (normalized E.164), district and mahalla (catalog references), address text, acquisition source (enum list configurable later). Keep the task-002 columns and provenance.
   - `visits` (clinic, patient, business_day, type outpatient|inpatient, status, created_by, created_at); a visit belongs to the open business day; creating one with no open day is rejected with a clear message.
   - `queue_points` (a doctor, a department or a service point such as lab or ultrasound), `queue_counters` (business_day, queue_point, last_number), `queue_tickets` (visit, queue_point, number, status waiting|called|in_progress|completed|cancelled, timestamps). Unique (business_day, queue_point, number) and unique (business_day, queue_point, visit).
   - Visit service lines: `charge_lines` created here as `ordered` with `unit_price_uzs` from `priceAt(service, now)` and quantity; status changes come later (C5/C6). Use the 003B money types.
2. Number allocation: `UPDATE queue_counters ... RETURNING` inside the visit transaction (row lock), never `max()+1`.
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
