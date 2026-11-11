# ADR 001 — Increment 0 foundation

Date: 11 November 2026, Asia/Tashkent. Status: local engineering decision within task 001.

## Shape and dependencies

One TypeScript application contains a React/Vite client, Node HTTP server, shared
runtime-validated contracts and server-only modules. npm is the only package
manager; exact direct versions and `package-lock.json` are retained. No proprietary
hosting, Supabase deployment, provider account or database is needed to run this
increment. No upstream application was replaced in place.

React/React DOM 18.3.1 and TypeScript 5.8.3 keep the available documentation app's
compatible language/UI baseline. Vite 8.3.8 supports the installed Node 22.17.1
according to its registry engines (`^20.19.0 || >=22.12.0`); the actual build passes.
Vite's built-in TSX transform is sufficient for this static status screen, avoiding
an unnecessary React plugin/compiler dependency. Node's test runner plus tsx
4.23.15 runs the server policies and real HTTP tests. Zod 4.6.7 provides one shared
runtime boundary and inferred TypeScript types. All are pinned; these choices
establish compatibility, not a production dependency/security certification.
An initial audit flagged the inherited Zod 3 line for oversized-collection memory
exhaustion. The foundation was updated explicitly to patched 4.6.7 and rechecked;
no force-install flags were used. See [the reviewed advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).

Official references consulted: [Vite requirements](https://vite.dev/guide/) and
[Node test runner](https://nodejs.org/download/release/latest-jod/docs/api/test.html).
The CI definition matches local Node 22.17.1 and npm 11.12.1 and checks Windows
and Linux. Hosted CI has not run. Upgrade the Node patch level and verify before
any production rollout; the installed developer runtime is not a deployment choice.

## Authority and authorization

`src/contracts/index.ts` separates registration, email ownership, professional
verification, clinic-granted membership, patient links and Telegram identity.
Registration rejects extra privilege fields. An administrator role alone grants
no clinical read privilege. A clinician can have a clinic-wide or assigned-patient
scope. Professional verification remains independently recorded; an active clinic
grant does not assert a medical license was checked.

`src/modules/identity/access.ts` checks trusted session state, expiry, blocked
accounts, current membership, clinic and patient scope. These are tested policy
primitives, not an authentication system. No login, registration, invitation or
clinical API handler is active in this increment. The HTTP server rejects every
`/api/*` path except health with 401, including supplied bearer/cookie/role claims.

Next increment: resolve opaque session-token digests and current membership in
the authoritative transaction; never deserialize a client Principal as trusted.
Recheck membership for reads, writes, exports, subscriptions and background jobs.
Clinic administrators explicitly invite/grant clinicians; self-registration is
unprivileged. Add hashing, secure sessions, CSRF protection, throttling and recovery
before exposing any clinical route. No password or test-login bypass is shipped.

## Storage boundary

PostgreSQL is the target single authoritative relational store. Increment 0 has
no clinical persistence, migration runner, localStorage records or pretend database.
`src/modules/patients/repository.ts` is a transaction interface only. Docker CLI is
installed locally but its daemon is unavailable; no PostgreSQL server was launched
or tested. Increment 1 needs a local/test database, one migration history under
`db/migrations/`, and a concrete repository. Do not inherit two upstream histories.

Every clinical lookup includes clinic and patient scope. Enforce composite foreign
keys for clinic-qualified records and document versions. Store occurrence separately
from entry time: exact offset instant + IANA timezone, date-only + timezone, or an
explicit unknown reason. Diagnosis status distinguishes historical/resolved/current.
Do not merge people across clinics using name, phone or Telegram ID.

## Versions, approval, evidence and delivery

Document versions are append-only snapshots: original AI drafts, clinician edits
and reasoned amendments are separate. Approval references the exact current version,
revision, patient/clinic and actor. Pure policies reject stale or mismatched versions,
unreviewed AI drafts, unresolved fields, repeated approval and revoked access.
Persistence must enforce immutability and optimistic concurrency atomically;
the current functions do not establish those database guarantees.

Transcript evidence includes segment ID, segment revision and time range. Fields
separate source category, review status and origin. Unknown is `null`; no default
negative examination or zero is supplied. AI proposals require evidence, without
invented confidence scores. A later service must check references against the same
patient/encounter and preserve manual corrections; a valid shape alone cannot prove
source truth or clinical correctness.

Integration jobs reference the approved version and scoped idempotency key. An
uncertain external write cannot be dispatched again by the policy guard: reconciliation
is required first. No adapter, queue or retry worker is implemented. The future
transaction reserves `(clinic, actor, operation, key)` uniquely with a payload hash;
same payload replays the stored result, changed payload conflicts. Save the result
and outbox job atomically. Actual duplicate prevention is still unimplemented.

## Client and operational boundary

The client only displays real server availability and explicit unimplemented states.
No price is guessed, no onboarding state is faked, and no clinical action buttons are
present. Next increment provides a compact patient/timeline workspace. Phone,
desktop and Telegram will use the same API; browser storage is not synchronization.
The Node server binds to loopback and serves only the built index and allowlisted
generated JS/CSS assets. No general request logging is enabled. No provider secrets
or clinical source are imported by the browser module graph.
