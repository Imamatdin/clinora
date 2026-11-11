# Task 002 — Working notebook decisions

11 November 2026, Asia/Tashkent. Continues the foundation; does not replace the app.

## Runtime and execution

Node 22.17.1 / npm 11.12.1 remain the checked baseline. PostgreSQL 17.9 is pinned
for reproducible local Compose and CI. `pg` and its type definitions are 8.23.1.
Playwright 1.65.0 is a development/test dependency, not shipped in browser assets.
The user's local-RAM constraint means task 002's installation, compilation,
PostgreSQL and Chromium acceptance runs happen on GitHub-hosted runners. Local
activity after that instruction is text editing, Git, small metadata/lockfile
operations, log retrieval and evidence inspection. No local application/database
is started for task 002 verification. No persistent hosting is provided by CI.

## Schema and transactions

`001_notebook.sql` creates accounts, clinics, memberships, hashed sessions,
invitations, patients/assignments, encounters, documents, append-only versions,
idempotency results, audit events and login counters. Date-only birth dates use a
date parser that retains calendar strings. Clinical occurrence is preserved as
validated JSON with its exact/date/unknown precision, independent of entry time.
Foreign keys qualify clinic and patient references together. A deferred composite
reference connects the document's current snapshot to its own version.

`src/server/database.ts` supplies PostgreSQL transactions and checksum-verified
migrations. `src/server/notebook.ts` is the concrete task-002 application/repository
implementation: its SQL remains server-only and parameterized. It uses the existing
access policy on freshly loaded authoritative records. The older repository port
also describes future approvals/integrations and is not claimed as completely
implemented. No SQLite or clinical in-memory fallback exists.

Reads/mutations acquire current session/account and membership share locks for
the transaction, including assignment rows. Revocation waits for already-authorized
transactions and takes effect on subsequent operations. Concurrent draft updates
lock the document row and compare expectedRevision inside that transaction.
Version insert, head advance, audit and idempotency result commit together. A DB
failure maps to a generic 503; clinical text and SQL diagnostics are not logged.

Idempotency uses `(clinic, actor, operation, key)` with a canonical validated-payload
hash. A PostgreSQL transaction advisory lock serializes simultaneous identical
requests before checking/creating the persisted result. A mismatching payload is
409. Task 002a requires each replay caller to recheck the stored result's actual
resource authorization before returning it. Patient-create retries refresh and pin
the stored patient's current assignment after the replay-key wait. Draft/encounter
retries validate the actual clinic/patient/encounter/document relationship; a draft
also validates its immutable historical snapshot without comparing the current
revision. Replay-key locks precede document locks on both hit and miss paths.
The task-002a handoff records actual reviewed-module failures and the passing
corrected PostgreSQL/HTTP regressions. Request input
object key order is normalized by the strict shared schemas.

## Identity and privilege

No request role switch, default privileged password or public owner endpoint.
Owner provisioning is a CLI operation with explicitly supplied credentials. Its
clinical_access flag is independent of its owner/admin role. An owner without
that flag can invite but cannot read patient records. The account's professional
verification remains unverified; neither signup nor invitation asserts a license.
Owner workflows grant clinicians assigned-patient scope; creating a patient adds
an assignment to its creating clinician. Explicitly provisioned clinical owners
can inspect the clinic's records. Further assignment management is an owner
administration extension, not an implicit grant to all doctors.

Registration is strictly unprivileged. Passwords use asynchronous Node scrypt,
random 16-byte salts and timing-safe comparison; nonexistent logins run the same
KDF. Opaque 256-bit session tokens are stored as SHA-256 digests and expire after
eight hours. Cookies are HttpOnly, Path=/ and SameSite=Strict; Secure is explicitly
enabled for HTTPS production. Production startup rejects missing DB/HTTPS/Secure
configuration. The server remains loopback-bound for this increment; deploying a
proxy/service is a separate task. No patient login is implemented.

Every browser mutation checks the configured exact Origin, JSON content type and,
after authentication, a session-derived CSRF token returned only by /auth/me.
Bearer fallback is deliberately unsupported. Login/registration are limited in
PostgreSQL by hashed identity and socket IP counters (8 per email and 40 per IP
per 15 minutes); forwarded IP claims are not trusted. This simple bound includes
successful login attempts; distributed abuse and production proxy/rate policy
still require a release review. Body and timeout limits bound requests.

Invitation hashes only are stored, bound to email/clinic/issuer and a 48-hour
expiry. Acceptance is authenticated, single-use and atomic; revoked issuers
cannot grant outstanding invitations. Existing revoked memberships cannot be
silently reinstated by this path. The raw link is returned only to the authorized
owner for manual delivery, uses a URL fragment and is removed from browser history
after capture. No email/Telegram transmission occurs.

## Clinical meaning and UI

Four manual fields — reported, observed/measured, assessment, plan — are blank by
default. Empty values persist as null, and saved fields remain proposed in an
unapproved clinician draft. No current diagnosis or treatment order is created by
saving text. Existing approval guards remain; no approval/export API is exposed.
No AI-generated material, media, inference scores or default normal examination.

The workspace supports login, pending account/invitation, clinic selection,
permitted-patient search/create, dated timeline, new encounter and revisioned editor.
Timeline uses known dates descending, date-only precision explicitly labeled and
undated visits last. Each visit retains its own location, specialty, author and
unapproved assessment. Equal date keys are ordered deterministically by entry/id.
Exact instants with different offsets must be ordered by elapsed time, not string
representation; the sorter normalizes exact timestamps before comparison.
For mixed precision, date-only keys sort after exact instants on the same UTC
calendar day. This is a display policy, not a fabricated occurrence time; dates
remain date-only in storage and are labeled as such in the UI.

Manual saving is acknowledged only after the transaction commits. Navigation and
browser unload warn on dirty note edits. Failed saves and 409 conflicts retain
editor text in component memory, with an explicit latest-version comparison and
choice before retry. There is no clinical localStorage. A lost response can be
retried with the same in-memory operation key while the page stays open; a full
page reload intentionally discards unsaved browser memory after the warning.

## Limits carried forward

No production deployment, credential recovery, verified email delivery,
professional-license adjudication, fine-grained assignment management UI, patient
portal, audio/Telegram, AI, clinical approval or export is claimed. There is no
global patient matching across clinics. PostgreSQL-backed permission, failure,
concurrency, restart and remote browser evidence is required before marking the
increment complete. See the dated task-002 handoff for actual outcomes.
