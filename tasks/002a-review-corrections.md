# Clinora task 002a — authorize cached retries

Planner review: 12 November 2026, Asia/Tashkent.
Repository: https://github.com/Imamatdin/clinora
Review branch: `task-002-patient-notebook`
Reviewed commit: `b348991c87363eda79d30f983b7d46478dda9105`
PR: https://github.com/Imamatdin/clinora/pull/1

## Builder instruction

Continue the existing repository and task-002 branch. Inspect the current HEAD and preserve unrelated changes. Fix the two authorization paths below, add real PostgreSQL/HTTP regressions, and return the updated handoff. This is a bounded correction to task 002, not a new feature increment. Do not start task 003 or merge the PR as part of this assignment.

Keep heavy builds, PostgreSQL and browser tests on GitHub-hosted runners, respecting the user's local RAM constraint. Use synthetic records only. No production access, deployment or live clinical data is needed.

## Review result and evidence

The notebook implementation is present in the committed source. The planner independently fetched the branch and confirmed its HEAD. GitHub's API reports both final runs completed successfully at that exact commit:

- https://github.com/Imamatdin/clinora/actions/runs/43067423860
- https://github.com/Imamatdin/clinora/actions/runs/43067594228

Independent checks in the planner's cloud checkout passed: `npm ci --ignore-scripts`, `npm run typecheck`, `npm run test:unit` (13 passed), `npm run build`, and `npm run test:built`. The tracked checkout remained unchanged. The committed CI log records 8 passing PostgreSQL/HTTP tests and 3 passing browser scenarios for the application ancestor. The planner did not rerun PostgreSQL or browser tests and has not independently reproduced the findings through HTTP; these are findings from tracing the actual source. The builder must demonstrate failing regressions before fixing them.

Task 002 is pending these corrections. Passing existing tests does not cover the replay cases below.

## Finding 1 — a draft replay skips the encounter-to-patient check

Priority: P1. File: `src/server/notebook.ts`, lines 73–81 and 177–211 in the reviewed commit.

`allowedPatient()` authorizes the patient supplied in the URL. A draft's replay scope is `draft.save:${encounterId}`, without the URL's patient ID. The SQL that verifies the actual clinic/patient/encounter relationship is inside the callback passed to `idempotent()`. When a cached result exists, the helper returns it before that callback runs.

Consequently, an assigned clinician can save a note for patient A, lose access to A, and replay the saved request under another permitted patient B's URL while retaining A's encounter ID and the original key/body. The route authorizes B, then returns A's cached clinical document. On a cache miss, the same mismatched URL reaches SQL and is rejected. Cache hits and misses therefore enforce different access rules.

Regression scenario:

1. Create an active clinician with assigned-patient scope, patients A and B, and assignments to both. Do not use a clinic-wide owner for this test.
2. Create encounter EA for A. Save a synthetic note with key K and retain the exact request body.
3. Remove the clinician's assignment to A, leaving the account, membership, session and B assignment active.
4. Confirm reading A is denied and reading B still succeeds.
5. POST the original body with K to `/api/clinics/C/patients/B/encounters/EA/draft`.
6. Require a non-disclosing 404, no A identifiers or note content, and no new revision/audit/replay write. The current source path returns the cached successful response instead.
7. Also cover the mismatched URL while both assignments exist, and with a fresh key. A mismatched patient/encounter pair must never return a successful cached document.

## Finding 2 — patient creation replay returns an inaccessible patient

Priority: P2. Same file, lines 73–81 and 165–175.

The patient-create route checks clinical membership, then returns a cached `PatientView` without checking current access to that patient. Removing the creator's patient assignment does not prevent this cached response. Its contents include the patient's name, birth date, medical-record number and identifiers.

Regression scenario:

1. An assigned-scope clinician creates patient A with key K; retain the exact request body.
2. Remove only the clinician's assignment to A. Keep clinical membership active.
3. Confirm A is absent from permitted search and GET A returns 404.
4. Replay the original create request with K. Require a non-disclosing denial with no patient data. Do not create another patient or restore the assignment.
5. Preserve successful same-key replay while the clinician remains authorized.

## Required behavior

- Every cached clinical response must pass current account, membership and resource authorization before disclosure. A known idempotency key is not authorization.
- Validate the actual clinic/patient/encounter/document relationship on cache hits as well as misses. Scoping the key more narrowly is useful, but does not replace this check.
- For patient creation retries, authorize the patient identified by the stored result before returning that result. Denied retries must not rerun creation or grant access.
- Keep checks and effects transactionally consistent with the existing revocation approach. Use a consistent lock order across requests; avoid introducing deadlocks when combining replay locks and document locks.
- Preserve legitimate lost-response recovery: an authorized replay returns the original successful result even when its original expected revision is now stale. Do not put a current-revision comparison ahead of replay resolution and accidentally break retries.
- Keep changed-payload conflicts, actor/clinic isolation, single creation under simultaneous retries, immutable revisions and atomic audit/replay writes working.
- Do not clear all replay records as the fix, weaken assigned-patient access, or change historical migrations already applied. If a schema change is needed, add a migration and verify existing records.

## Verification and delivery

Add the regressions to the real HTTP/PostgreSQL suite. Capture their failure on the reviewed behavior and success after correction. Also exercise revoked membership/session denial on cached routes and retain the existing concurrent retry tests.

Run the full existing Linux aggregate and Windows compatibility checks remotely on the final application commit. Return the commit, PR/run links, changed files, regression names/results and any failures. Distinguish implementation, tests, push and deployment; deployment remains out of scope. Update the handoff to describe the actual replay authorization guarantee.

Next after review: task 003 remains browser consultation capture, native Telegram voice-message transcription, secure clinician linking, explicit encounter attachment and cross-device recovery. Documentation automation/approval, workflows/integrations/patient accounts and release work remain tasks 004–006. This correction does not remove or expand those planned increments.
