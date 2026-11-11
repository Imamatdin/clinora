# Proposed task 002 — First patient timeline

Proposal for planner review, not an already approved new assignment. Stop task 001
after returning its handoff; do not implement later increments automatically.

## Useful flow

1. An explicitly clinic-authorized clinician signs in. New registration cannot grant
   clinician membership. An administrator grants a scoped invitation/approval through
   a documented local bootstrap process, without credential defaults.
2. The clinician sees the clinic's patient list and accessible empty/error states,
   creates a synthetic patient chart without a patient login, and opens its timeline.
3. Start an encounter with location, specialty, actual occurrence date/time/timezone
   (including a retrospective/date-only case), then save a draft.
4. Reload and restart the server. Reopen the same saved patient and encounter from
   the timeline. Two sessions operate on the same backend data; a stale write returns
   STALE_VERSION instead of overwriting. No live recording/AI/export controls yet.

## Implementation sequence

- Bring up a dedicated local/test PostgreSQL instance (Docker daemon is currently
  unavailable; install/start a suitable local service or restore Docker).
- Add one migration history for accounts, token-digest sessions, clinic membership,
  patients, encounters, append-only document versions and scoped idempotency records.
  Acknowledged writes commit before responding. Use clinic-qualified foreign keys.
- Implement server authentication, CSRF/body/rate protections and current membership
  lookup. Adapt the larger CRM's proven session practices without importing its
  generic/dental Store or public doctor grants. Keep patient portal and Telegram
  account linking disabled until their dedicated increment.
- Implement transactional repository/API with runtime validation, version checking,
  scoped replay and synthetic fixtures. Do not use localStorage or an in-memory
  clinical fallback. Give authorization failures consistent non-leaking responses.
- Replace the status shell with compact patient/timeline/encounter views. Verify
  keyboard operation, reload, error recovery, desktop and phone containment in a
  browser. Introduce shared accessible UI primitives selectively where useful.

## Acceptance evidence

Run against a fresh migrated database. Prove restart persistence; forbidden reads
and mutations for unauthenticated, blocked, revoked, wrong-clinic and wrong-patient
actors; rejection of self-assigned roles; separation of occurrence and entry time;
same-key replay with no duplicate encounter; changed-payload conflict; concurrent
stale edit rejection; bounded logs and no client secret imports. Include complete
create → save → restart → reopen scenario and browser evidence, not just policy tests.

## Open inputs carried forward

Exact presentation date/duration/devices/languages; real clinic forms and first
specialties; patient-link/guardian release rules; authorized destination interface;
canonical pricing and hosting/data-handling arrangements. These do not block the
synthetic shared foundation. They do block claims of live integration, all-specialty
clinical validation, production patient access or billing readiness.
