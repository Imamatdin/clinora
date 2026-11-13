# Clinora product definition

Updated 12 November 2026 by the planner. Supersedes the 11 November baseline. Newer explicit corrections from Imamatdin take precedence.

## What Clinora is now

Clinora is an operating system for private clinics in Uzbekistan. It runs the whole patient journey in one integrated system: registration, queues, outpatient visits, laboratory, inpatient stays, cashier, discounts, receipts, daily cash close, staff pay and the CEO dashboard. The full requirements are in `docs/SPEC-CMS.md`, which is the source of truth for scope.

The clinical notebook built in tasks 001-002 stays. It becomes the doctor's visit notes inside the clinic system. AI documentation from conversation (the original Clinora idea) becomes a module on top of those notes after the clinic system is live. Telegram, patient portal and external integrations move after it as well. Nothing from the earlier scope is deleted; it is re-sequenced.

## First customer

- One private clinic (about 150 outpatients and 20+ inpatients per day) goes live first. Target handoff: 19 November 2026. The clinic paying for the system is the founders' traction evidence.
- Users at that clinic: CEO, administrator, registrars, doctors, laboratory staff, cashiers, inpatient staff. Most are not technical. Few buttons, minimal typing, large touch targets, Uzbek Cyrillic UI.
- Hardware: existing Windows PCs, phones, thermal receipt printers (model to be confirmed). Internet may drop.

## Non-negotiable rules for every builder

1. Money is stored and computed as integer UZS (`bigint` in PostgreSQL, `bigint` in TypeScript). No floats anywhere in money paths.
2. A charge line stores the unit price in force when the service was recorded. Later price changes never change past charges.
3. Payments, refunds, discounts and audit events are append-only. A correction is a new row (refund, void) that references the original, with actor and reason.
4. Every payment request carries an idempotency key. A repeated submit records one payment.
5. Revenue reports use money actually received, not service value.
6. Every query and mutation is scoped to the actor's clinic and checked on the server against the actor's current roles. The frontend hides; the server decides.
7. A doctor sees only patients routed to them. Full-clinic export is CEO-only.
8. Historical business days are never overwritten. Every visit, charge and payment belongs to one business day.
9. All UI strings go through the i18n dictionary. Default locale `uz-Cyrl`.
10. Synthetic data in development and demos. Real clinic reference data (services, prices, doctors) may be imported once Imamatdin provides it. Real patient data only after the founders define the process.

## Access and Telegram (decided 12 November 2026)

- Phones: the same screens run as a Telegram Mini App from the clinic bot or as the installed app on the home screen; doctors choose (customer interviews raised doubts about Telegram, so both ship and the usability test sets the default). In the Mini App, The server validates Telegram's signed init data (HMAC with the bot token, freshness window) on every session start and checks current roles on every request. No password in daily phone use.
- Linking: the administrator creates a staff account; Clinora issues a single-use, expiring invite link; tapping it in Telegram binds that Telegram user id to the staff account. A Telegram id alone never grants access; blocking the staff account ends access on the next request.
- Clinic PCs: the installed web app (PWA) stays signed in per device for the shift; people switch user with a short PIN so every action is attributed to the right person.
- One backend, one database, live updates across devices.
- Bot messages carry notices and a button into the app, never diagnoses, results or patient details.

## Security and access rules (task 022, 13 November 2026)

- **Telegram voice capture** is a clinic setting, **off by default**. The CEO turns it on under Staff → Access settings. While off, a doctor's voice note to the bot is answered "recording through Telegram is off in your clinic; record in the app" and nothing is stored. In-app recording in the doctor assistant is always available.
- **Day-close notice** in Telegram says only "Day closed" with a button into the app. Collected, refunds and expenses appear only inside the app (day report), never in Telegram.
- **No public self-registration.** Accounts exist only as staff created by an administrator (then linked by a Telegram invite) or by invitation to an existing account.
- **Approval PINs** (discounts, refunds, voids, out-of-stock ward dispenses): one failure counter per approver across every computer and session. Five wrong PINs lock that person's approving until a CEO or another administrator clears it (audited); there is no time-based unlock. The approver gets a Telegram notice without amounts or patient data. CEO and administrator PINs have at least 6 digits; an older or shorter PIN must be changed (prompted at next sign-in) before it approves anything. A guess is counted only against a real visit, payment or stay in the clinic.
- **Credential resets.** When someone else resets a person's password or issues their Telegram invite, the person gets a Telegram notice (sent to the chat linked at that moment) and, on next sign-in, "Your password was reset by <name> at <time>". An administrator's reset or invite for a doctor waits for a CEO's confirmation (Staff → Requests to confirm); after confirming, the administrator repeats the action within an hour, once. CEO accounts are managed only by a CEO.
- **Doctor notes.** Only the encounter's own doctor reads the draft, writes or approves it (doctor workspace, notebook and assistant alike). Other doctors with access to the patient see only approved versions.
- **Routing access** lasts while the visit is open and for 30 days after it closes (CEO setting, Staff → Access settings), and for the whole inpatient stay. Routing the patient again grants it again. A doctor keeps reading their own approved notes after access ends.
- A write refused by a database rule (closed business day, discharged stay, append-only record) answers 409 with a plain message, not a server error.

## Ease-of-use rules (apply to every screen)

The test: a 60-year-old doctor who only uses Telegram finishes the task on the first try without help.

1. One main action per screen, one large button; secondary actions behind "More".
2. Pick from searchable lists instead of typing wherever possible.
3. Amounts and phone numbers use a large number pad; amounts display with space groups and `сўм`.
4. Uzbek Cyrillic default; Russian and Uzbek Latin one tap away; use the clinic's own terms from its 1C.
5. Body text at least 16 px, touch targets at least 48 px, high contrast, no icon-only buttons.
6. Money actions confirm in words on one screen; other actions offer a short undo; errors say what to do next.
7. Drafts autosave; registration and queue keep working offline with a visible banner and sync once.
8. Skippable first-run walkthrough per role; printable one-page cheat sheet per role.
9. Before go-live, two real staff per role complete their main tasks unaided. Targets: register a patient under 60 s, take a payment under 30 s.

Human-readable version for the founders: the Claude Doc "Clinora: what we're building".

## Agent layer (the founders' "more agentic" pivot)

The assistant turns speech or text into proposed actions in the clinic system; a person approves clinical and financial actions with one tap; read-only questions answer directly. Build every mutation now so the assistant can reuse it later:

- Each mutation is a typed, validated server action (zod schema in, typed result out) with actor, clinic, idempotency key and audit, callable by the UI and later by the assistant. No business logic lives only in a React component or route handler.
- The assistant always acts as the signed-in person, through the same permission checks. It never holds wider access.
- Proposals are stored as drafts with source references (transcript segment ids) until approved; approval executes the action and records who approved which version.
- If the AI provider is unavailable, every workflow completes by hand.
- Speech accuracy (Uzbek, Russian, mixed) is measured on phone microphones in a real exam room before any accuracy claim.

Previous planner's detailed AI briefs: `docs/backlog/ai-documentation/`.

## Decisions from Imamatdin, 12 November 2026 (evening)

- Printing: industry defaults, no printer-model targeting. Receipts and queue tickets render for 80 mm thermal paper (ESC/POS printers via the operating-system driver, printed from the browser) and stay readable at 58 mm. Prescriptions, invoices and reports render as A4 PDF. Staff adjust in their print dialog.
- Documents (prescription, invoices, reports) are generated on the server as PDF, viewable on screen and printable, so low-memory phones never render heavy documents. Printing is expected mostly from clinic PCs.
- Languages: Uzbek Cyrillic, Uzbek Latin and Russian all ship. Each clinic has a default; each person can override it. Gʻofurov klinikasi defaults to Uzbek Cyrillic (CEO's request); new clinics default to Uzbek Latin, the official script.
- Doctor split: adjustable per doctor by the CEO, effective from a date forward, every change recorded with who and when. Each doctor sees their own rule, its change history and their own earnings. A change never rewrites past periods.
- Caretakers: optional entry on an admission with an optional charge. Low priority; details later.
- Testing: Mashxura is a doctor and leads clinical testing.
- Founders receive the working platform for their own testing on 15 November 2026. President's Tech Award: 19 November 2026, the same day as the clinic go-live. Work is sequenced, never scoped down, to meet these. The doctor assistant slice (A1) is the award demo, so it runs in parallel now on the existing notebook, on a staging environment with synthetic data, separate from the live clinic.

## Data model direction

Reuse the task-002 foundation: accounts, sessions, clinics, memberships, patients, patient_assignments, encounters, documents, document_versions, idempotency_records, audit_events.

Add, through new migrations only:

- `membership_roles` (a member can hold several roles: ceo, administrator, registrar, doctor, laboratory, cashier, inpatient). Replace the single `memberships.role` check by reading roles from this table.
- Staff sign-in by login name or phone, email optional. Clinic staff often have no email.
- Registration fields on `patients`: clinic-unique patient number, full name, birth date, gender, phone, region, district, address, acquisition source.
- `business_days` (one open day per clinic; open/close actor and time; close snapshot).
- `visits`: operational and billing container for one arrival (outpatient or inpatient), linked to a business day. A visit has many encounters (one per doctor seen) and many charge lines.
- `departments`, `service_categories`, `services`, `service_prices` (price history), doctor profiles and doctor-service links.
- `queue_points`, `queue_counters`, `queue_tickets`: independent numbering per queue point per business day, unique per day and point, race-safe.
- `charge_lines`, `discounts`, `payments`, `payment_allocations`, `receipts`.
- `rooms`, `beds`, `admissions`, `bed_day_charges` (one charge per admission per date).
- `doctor_split_rules` (versioned per doctor: percentage, basis, discount handling, which revenue counts) and payroll period snapshots.
- `day_close_reports` (snapshot of the cash report at close).

Routing a patient to a doctor creates the `patient_assignments` row, so the existing assigned-scope access check gives "doctor sees only their own patients" for free.

## Open inputs (do not block building)

- Which modules the first clinic needs on 19 November (inpatient and laboratory expected, to be confirmed).
- Thermal printer model and paper width; devices in use.
- The clinic's actual split rules and pay basis.
- Export of the 1C reference data (Imamatdin will provide CSV or JSON).
- Hosting location and data-handling arrangement for real patients.
- President's Tech Award date and what is shown there.
