# Task 002 Working patient notebook

Owner: builder agent. Reviewer: planning assistant. Date: 11 November 2026.

## Outcome

An authorized doctor signs in, selects the clinic, creates a fictional patient, starts a dated encounter, saves a structured draft, reloads or restarts the server, and reopens the same draft from that patient's history. A second doctor or clinic cannot gain access by changing IDs. This must work through the UI and real HTTP routes backed by PostgreSQL.

This is the first usable clinical increment. The task is complete only when the user flow works. Contracts, a status screen, mocked API responses, or a database diagram alone do not satisfy it.

## Start from the existing repository

Read AGENTS.md, existing contracts, ARCHITECTURE-001, REUSE-MANIFEST, THREAT-MODEL, NEXT-INCREMENT, and the task 001 verification logs. Record actual HEAD, local changes, and the final documentation commit. Re-run the existing check once. Preserve the foundation and existing policy behavior; fix demonstrated baseline issues without rebuilding the repo or re-auditing all reference apps.

The reported local path is `C:\Users\imama\Documents\Codex\2026-11-11\new-project-x20`. Discover the actual environment rather than assuming that path exists elsewhere. There is no known remote or deployment to modify.

## 1 Establish real local and test PostgreSQL

Use one migration history under db/migrations. Create accounts, sessions, clinics, memberships, patient assignments, patient records, encounters, document revisions, idempotency records, and audit events as required by the existing contracts. Prefer database constraints and foreign keys that prevent cross-clinic references in addition to application authorization. Use transactions for related writes.

Provide a reproducible local setup, such as a pinned PostgreSQL container with a health check and a persistent volume. Use a dedicated existing local PostgreSQL instance if available. Resolve routine Docker startup or configuration; never reuse a production database or silently fall back to SQLite. Avoid destructive cleanup against an arbitrary DATABASE_URL. Tests must use a clearly identified dedicated test database/schema and fail safely when its identity is not explicitly configured.

Do not hide skipped PostgreSQL tests behind a green aggregate check. If the environment cannot run PostgreSQL, continue independent implementation and report the database acceptance checks as blocked. Do not claim task 002 complete.

## 2 Implement authenticated clinic access

Use the established identity contracts and a reviewed session implementation. Local development must work without an external paid service or a fake browser role switch. Reuse sound password/session mechanisms if suitable; never adopt plaintext passwords or request-supplied authorization roles.

Implement explicit owner/bootstrap provisioning plus clinic-scoped clinician invitation or approval. An initial owner is provisioned through a documented setup command using user-supplied credentials, not a known production default or a public admin-creation endpoint. Invitations must be scoped, expiring, and single-use, with only a hash stored. The local workflow can output a link for manual delivery without requiring an email provider; do not add a live messaging integration.

Approval of clinic membership is separate from proof of professional credentials. Retain those states honestly. For the synthetic demo, documented seeded clinician verification is allowed; production must not manufacture that status during signup. New or pending accounts cannot access clinical routes.

Persist sessions server-side, store session token hashes, set HttpOnly cookies with explicit deployment-aware Secure/SameSite behavior, and protect authenticated browser mutations against CSRF. Do not make any supplied bearer/cookie claim sufficient by itself. Apply login throttling and avoid credential/account-existence leaks. Logout, expiry, blocked membership, and permission revocation must take effect. Request logs must not contain credentials or clinical content.

Resolve actor, current active clinic membership, and patient assignment on the server. Minimum fixture roles are clinic owner and clinician; clinical access must remain an explicit permission rather than an accidental consequence of a billing/admin role. Do not implement patient portal login yet.

## 3 Persist patient identity and chronological encounters

Support creating, viewing, and searching clinic-scoped patients with an internal stable ID and optional clinic medical-record number. Repeated names are allowed; never merge by name or phone. Enforce unique medical-record numbers within their clinic where present. Include the agreed minimal demographics with optional fields rather than inventing unnecessary required medical facts.

An encounter records patient, clinic/location, responsible clinician, specialty, occurrence time with timezone/precision, creation/update times, status, and provenance. Location and diagnosis history belong to each visit. Preserve date-only or unknown timestamps from the existing contracts; do not silently invent midnight as an exact clinical event time. Define clear sorting/display for incomplete dates.

The timeline links each encounter to its draft/history. Historical diagnoses remain historical and retain their source/date. In task 002, clinical assessment entered by a doctor can remain a visibly unapproved draft. Do not present it as an approved diagnosis merely because it was saved.

Keep patient/encounter references scoped in every read, search, mutation, and link. Return consistent non-disclosing responses for records outside the actor's access; avoid existence leaks via counts or search suggestions.

## 4 Save revisioned drafts with concurrency protection

Implement a minimal structured note using the existing contracts: reported information, observed/measured findings, assessment, and plan, with a configurable specialty/template identifier. Blank information stays blank or explicitly unrecorded. Do not seed normal examinations or confirmed diagnoses by default.

Saving creates or advances a server-controlled version. An update must name its expected version; two updates from the same base version cannot both silently succeed. Store the revision and audit event in the same transaction. Return a typed conflict and retain the user's unsaved input for resolution. Do not rely on a client-side version check alone.

Use scoped idempotency keys for create/save operations where retries could duplicate records. A replay of the same operation and payload returns its original result; reuse of a key with a different payload fails explicitly. Handle simultaneous identical requests and a retry following a lost response. Derive actor/clinic scope on the server; one doctor's key cannot disclose another doctor's result.

Approval transactions and clinical export UI are task 004, but the current APIs must reject attempts to set approved status, approving actor, or immutable revision fields directly. Existing approval policy tests must remain intact. No visible approval/export button may pretend to work.

## 5 Deliver the first real doctor workspace

Replace the status-only screen with sign-in/onboarding and a practical responsive workspace. Keep a health/status endpoint for diagnostics. Required screens: approved/pending account state; clinic selection when applicable; patient list/search; create patient; patient header and dated timeline; new encounter; draft editor; reopen saved draft.

On desktop, keep patient context, visit dates/location, and editing space immediately accessible. On mobile, provide readable stacked views and obvious navigation. Avoid the old oversized notebook decoration and horizontally scrolling essential stages. Use clear saving, saved, unsaved, error, and conflict states. Do not announce 'saved' until the server acknowledges persistence.

Provide a deliberate save action plus protection against losing dirty edits on navigation. Autosave is welcome if reliable, but must not make the unsaved state invisible. Preserve local editor contents on recoverable failures without treating browser storage as the authoritative chart. Do not add clinical content to long-lived local storage casually.

Use clearly synthetic fixtures to make the demo useful. The demo setup must be explicit and disabled for production; never hardcode demo role-switch shortcuts into the real authorization flow. No pricing/payments, charts of invented outcomes, marketing pages, bot, recording, or AI controls are required in this task. Their future scope remains in the delivery plan.

## 6 Verify the complete path and failures

Use actual PostgreSQL and real HTTP requests, not only direct policy-unit calls. Include at least these scenarios:

| Scenario | Required evidence |
| --- | --- |
| Fresh local setup | Migrations and explicit synthetic setup work from the documented environment; second migration run is safe |
| Access grant | Unauthorized signup cannot grant doctor access; pending/expired/replayed invitation fails; valid scoped invitation or approval works |
| Session boundaries | Logout, expiry, invalid token, revoked/blocked membership, and CSRF failures are enforced by HTTP routes |
| Clinic and patient boundaries | Doctor A cannot read/change/search clinic B's patients; a same-clinic unassigned patient is also denied under the selected assignment policy |
| Persistent chart | Create patient/encounter/draft; restart application with the same database; reopen identical saved content |
| Timeline fidelity | Multiple visits retain their own dates, location, clinician, specialty, draft status, and historical assessments |
| Duplicate requests | Same key/payload creates once, including concurrent requests; changed payload with reused key conflicts; retry after lost response returns original result |
| Concurrent edits | Two clients update the same version; one succeeds and one receives a conflict without losing its editor contents |
| Failure behavior | Unavailable database or failed transaction never yields a fake success or a partial patient/encounter/revision/audit write |
| Forged approval | Direct client status/actor/version manipulation cannot create an approved document |
| Real UI | Login through save/reopen is exercised at approximately 390px and 1280px; no essential horizontal overflow; keyboard labels/focus and errors work |

Tests should assert meaningful behavior, not hit an arbitrary count. Keep pure contract tests alongside the new integration tests. Update CI with an isolated PostgreSQL service and explicit test configuration. Retain a clear distinction between locally executed checks and remote CI, which may remain unrun without a remote.

## Return and stopping point

Return the dated existing handoff with exact commands/results, migration identifiers, source paths, current commit, and remaining issues. Include how to run the UI and how to provision a synthetic doctor without exposing credentials. Provide a short demo walkthrough, browser evidence using only synthetic data, and the key negative-access/concurrency results.

Provide a clean committed source archive or accessible repository link plus exact commit so the planner can review implementation, not only a narrative. Exclude ignored work directories, dependencies, databases, private environment files and secrets. Do not push publicly without the user's established destination and an appropriate source/secret check.

Stop after this working notebook increment and its evidence. Task 003 will add both native Telegram voice-message transcription and live browser capture, using these identities and records. Do not begin those integrations while task 002's persistence/access behavior remains unverified.
