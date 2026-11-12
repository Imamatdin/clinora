# Increment 0 threat model

Date: 11 November 2026. Scope: local foundation, contracts and policy primitives;
not a full security audit or claim of clinical readiness.

Assets: patient identity/history, audio/transcripts, evidence, original drafts,
human edits, approved snapshots, session tokens, clinic membership and provider keys.
Trust boundaries: untrusted client/provider output → server validation; server →
authoritative PostgreSQL transaction; outbox worker → external destination; bot →
authenticated workspace. Neither frontend checks nor schema validation establishes
actor identity or clinical truth.

| Threat / failure | Current foundation | Required enforcement before feature activation |
| --- | --- | --- |
| Signup self-grants clinician or verified title | Strict registration shape rejects extra fields; clinical HTTP routes closed | Server invitation/grant, audit actor, no user-editable role mapping; keep professional verification separate |
| Cross-clinic or wrong-patient identifier guessing | Tested session/membership/clinic/patient policy; no clinical endpoint active | Fresh DB checks on every operation; composite FKs; scope exports/jobs/events; subscriptions close or recheck on revocation |
| Revoked/blocked/expired account reuses old session | Policy rejects revoked/blocked/expired inputs on each invocation | Store token digests, secure cookies, session rotation/revocation; current permissions from DB, never stale token role claims |
| Telegram patient becomes doctor; same-name patient link | Identity link cannot satisfy membership; verified patient link requires explicit verifier/proof | Signed initData verification, one-time account-link proof, scoped session; clinician privileges require clinic grant; no chart matching by name/phone |
| Browser claims approval or stale edits replace approval | Exact-version policy rejects stale/mismatched/unreviewed versions | Immutable rows, conditional current-version comparison and approval insert in one transaction; approved export loads snapshot from DB; amendments append with reason |
| Repeated requests/segments duplicate records/actions | Idempotency/segment contracts and uncertain-write dispatch guard only | Unique scoped keys, payload-hash conflict, stored replay result and outbox in same transaction; unique segment revision coordinates; no blind retry after external timeout |
| AI invents examination/treatment or erases human correction | Unknown values preserved; evidence required for AI field shape; categories and conflicts explicit | Verify evidence ownership/revision, protected manual edits, typed allowed proposals, explicit clinician instructions for actions, clinician evaluation before use |
| Clinical text/token leaks in logs or bot messages | No request logging, source file server or bot delivery; no patient data supplied | Allowlisted structured event metadata; protected auditable clinical store; redacted provider errors; bot sends navigation by default; never log query tokens/raw audio |
| Secrets enter browser bundle or public repo | Web entry imports only React/CSS; env disabled; source/work/env paths unavailable over built HTTP; no upstream code/env copied | Separate server config, reviewed bundle and staged-file checks on every adapter; no VITE_ provider secrets or copied deployment config |
| CSRF, brute force, oversized payload and credential recovery abuse | No credential or clinical mutation endpoint exists | Authentication adapter, CSRF/origin protections, secure session cookies, rate limits/body limits, recovery/token lifecycle tests before exposing routes |
| Premature or misrouted external clinical write | No adapter/worker; integrations unavailable | Authorized destination contract, explicit approved snapshot/action matrix, transaction outbox, external IDs and reconciliation, fresh revoked-access checks at delivery |

Inherited enforcement: **none is active in this core**. The larger CRM's session
test suite and security helpers are reuse candidates; adopting them later requires
new core integration tests. Current closed routes protect an empty foundation, not
a deployed patient chart. Database isolation, persistence, concurrent approvals,
duplicate replay and external recovery remain unimplemented and unverified.

## Task 002 update — 11 November 2026

The text above records the increment-0 boundary. Task 002 adds concrete PostgreSQL
enforcement in `src/server/notebook.ts`, session/password handling in `security.ts`
and migration `001_notebook.sql`. See `ARCHITECTURE-002.md` and its dated handoff for
current evidence rather than treating the earlier gaps as still all unimplemented.

New controls include hashed opaque sessions, unprivileged registration, bounded
asynchronous scrypt checks, exact-Origin/session CSRF checks, deployment-aware secure
cookies, explicit owner clinical permission, hashed expiring scoped invitations,
fresh transactional membership/assignment reads, non-disclosing patient denials,
composite SQL foreign keys, append-only document snapshots, expected-version locks,
transactional audit/idempotency writes and advisory-lock replay serialization.
Failed DB operations return generic errors without SQL or clinical-content logging.

Runtime is loopback-only. Release review must still cover reverse proxy/rate-limit
policy, HTTPS deployment, DB least-privilege roles and backups, email verification,
credential recovery, professional verification, retention, real clinical evaluation,
and the later approval/export/audio/Telegram/integration boundaries. PostgreSQL
credentials in CI are disposable test-service fixtures, not application defaults.
Browser test credentials are generated in memory. Only synthetic UI screenshots
are retained; no authentication trace or patient dataset is uploaded.

## Task 006 update — 12 November 2026 (staging deployment package)

The runtime is no longer loopback-only when `HOST=0.0.0.0` (container image). New controls:
`TRUST_PROXY_HOPS` reads only the proxy-appended last `X-Forwarded-For` entry (forged entries
ignored, invalid values fall back to the TCP peer); HSTS on HTTPS deployments; startup refuses
staging/production without HTTPS origin, secure cookies and a database; host-only session cookie
(no `Domain`); allowlisted JSON access logs with identifiers stripped from routes; secrets only in
Secret Manager; gitleaks (repository) and trivy (image layers) block deploys; keyless WIF deploy
identity limited to this repository's `main`; demo seeding refuses `APP_ENV=production`.
Open risk: the per-IP login limit (40 attempts / 15 min, successful attempts included) applies to a
whole clinic behind one public IP once client IPs are resolved correctly; C9 requires per-account
keying. See `docs/DEPLOY.md`.
