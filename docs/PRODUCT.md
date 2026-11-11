# Clinora product definition

Updated 11 November 2026. This is the current planning baseline; newer explicit user corrections take precedence.

Clinora is a doctor-facing clinical assistant built around a persistent patient record. It should turn consultation conversations into accurate draft documentation, assist subsequent workflow steps, and transfer approved outputs to supported destination systems. A doctor reviews and approves clinical documents. The same permitted records must be available through Telegram, phone, and desktop.

## Agreed direction

- Work in a new repository, selectively reusing suitable supplied components.
- Build and deliver in working increments, with a clean, working demonstration for the upcoming President Tech Award presentation. The exact event date and demo duration are not yet supplied; do not invent them.
- Support all three automation layers: live documentation, clinic workflow actions, and integration with existing systems. The exact actions and destination interfaces remain to be established.
- Maintain a patient profile and dated clinical history: when a checkup happened, where, which doctor/specialty was involved, what was reported or examined, and what diagnosis or assessment was recorded.
- Support different specialties through a shared core with specialty-specific templates and extensions. Broad configurability is not proof of reliability for every specialty.
- Improve UI, authentication and doctor access, recurring onboarding behavior, inconsistent pricing presentation, and overall reliability.
- The user reports that the founders have customers ready to pay. Treat this as a founder-reported commercial signal, not verified revenue, contracts, or a confirmed price.

## Patient record and accounts

The user's 'per client account' is interpreted as a persistent patient identity and medical notebook, with eventual patient access to their own permitted record. This interpretation is explicit so it can be corrected. A clinical chart does not require a patient to create a login before receiving care. The mechanism for linking a patient login, handling guardians, and granting cross-clinic access remains open.

Working proposal: each clinic maintains its authorized patient records. Each encounter references the patient, clinic/location, clinician, specialty, occurrence time and timezone, status, and source. Store occurrence time separately from entry/update time so imported or retrospectively entered visits do not appear to have happened today. Preserve imported provenance and uncertain or date-only timestamps.

The timeline groups encounters and associated documents, findings, diagnoses, laboratory results, referrals, and follow-up events. Diagnoses retain their original date, clinician, and status; do not display every historical diagnosis as a current active condition. Amendments add a traceable revision rather than erasing history.

## Automation layers

1. Conversation capture: record deliberately, transcribe, extract evidence-backed facts, handle corrections, update specialty fields, and prepare drafts.
2. Workflow assistance: reuse confirmed facts across the clinic's forms, track missing requirements, prepare tasks/referrals/follow-ups from explicit clinician decisions, and expose items requiring review.
3. Integration: export or send approved outputs to supported destinations, retaining external identifiers, sync status, errors, and reconciliation history. Manual export is an explicit interim handoff, not completed integration.

The architecture must support all three. Which external adapter is implemented first depends on the clinic's actual destination system and authorized interface. An internal contract-tested adapter or labeled simulator can establish the integration architecture without falsely claiming live connectivity.

## Working architecture proposal

Use a TypeScript modular monolith with a responsive React workspace and a server API. Preserve compatible code where practical. Prefer a single authoritative relational store and a single migration history. PostgreSQL is the production target; the builder must document the local development setup and any inherited SQLite assumptions before reuse. Do not introduce microservices, separate copies of patient databases, or multiple incompatible auth systems to combine the prototypes.

Modules: identity and clinic access; patients and encounters; capture/transcription; evidence-backed extraction; templates/documents; approvals/audit; workflow jobs; integration adapters; patient portal; plan configuration. Infrastructure choices and deployment credentials are not settled. No dependency on a specific proprietary app builder is required for the new core.

Each extracted field should carry source references, status, and revision. Useful states include reported, observed, uncertain, corrected, and clinician-confirmed. Do not invent confidence scores. A timestamped transcript reference allows the doctor to inspect the supporting text.

The phone and desktop access the same saved encounter. Use versioned updates and an authenticated event mechanism for changes. Reconnect by fetching the current server version. Clinical details belong in the protected workspace; the bot can provide navigation and appropriately scoped notifications or summaries.

## Working demonstration proposal

Use a clearly fictional patient. An authorized doctor opens a dated patient history, starts a new encounter, captures a short consultation, sees the correct form update, corrects a fact, continues on the second device, reviews and approves a document, and reopens it from the timeline. Show one workflow task and an honestly labeled export or supported integration result.

Test the same scenario with a correction, absent examination findings, interrupted capture, and repeated submission. Measure end-to-end completion and correction effort. A scripted successful consultation alone is not the release criterion.

## Details that do not block the shared foundation

- Actual clinic forms, required fields, and workflow recording.
- First specialties to validate with participating clinicians.
- Exact presentation date, devices, languages, and allotted time.
- Which system receives final documents; authorized API/export options and credentials.
- Patient account linking and which documents patients can see.
- Verified pricing, hosting budget, and production data-handling arrangements.

Keep these visible in the backlog. Do not repeatedly ask the user to redefine the overall vision. Implement reversible shared foundations while those details arrive.
