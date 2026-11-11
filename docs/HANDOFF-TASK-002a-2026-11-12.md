# Clinora implementation handoff — task 002a

Date: 12 November 2026, Asia/Tashkent.
Task/increment: bounded task-002 replay-authorization correction; no new feature increment.
Repository: https://github.com/Imamatdin/clinora
Branch: `task-002-patient-notebook`; existing PR: https://github.com/Imamatdin/clinora/pull/1
Reviewed application: `b348991c87363eda79d30f983b7d46478dda9105`.
Test-only checkpoint: `7a282252c932adccf139a191d4815ec434619032`.
Initial correction: `e98660820eebfb1d7bd2e51afc749628a91ed262`.
Verified final application: `6ab065f5864a1a0a31c9c9c232c516b827c35a13`.
Exact final delivery commit is recorded in the output receipt / PR head.

## Delivered behavior

Implemented in source: cached clinical results require a mandatory resource-specific
authorization callback before returning their stored response. An idempotency key
identifies a result; it is not a permission grant.

- Patient-create replay validates the stored patient/clinic and checks its current
  assignment before returning its historical patient view. It does not recreate
  the patient or restore a revoked assignment. The specific assignment is read and
  pinned after the key wait so concurrent authorized creators observe a newly
  committed grant rather than the request's earlier assignment-list snapshot.
- Draft replay validates the cached snapshot's clinic/patient/encounter/document/
  version/revision identities against the requested resource and PostgreSQL
  document/version relationship. A mismatched URL cannot return a cached note,
  whether both patients remain assigned or original access was revoked.
- Encounter-create replay also validates its stored encounter/document relationship.
  This makes the callback required for all three current clinical replay paths.
- Current session/account/membership checks remain before replay lookup. Existing
  assignment locks remain held through the transaction. Replay-key advisory lock
  precedes document key-share or write locks on every path; no document lock is
  introduced before the replay lock.
- An authorized same-body retry returns its exact original snapshot even when a
  newer revision exists. Expected-current-revision checking remains in the cache-miss
  write callback. Changed-payload conflicts remain for authorized resources.

**Verified remotely on the final application commit:** the reviewed module produced
the three exact unauthorized cached successes (200, 200, 201 instead of 404), then
all five new regression scenarios passed against the restored corrected source.
The full Linux aggregate and Windows compatibility passed. GitHub's initial
scheduling block was resolved; results below supersede the pending checkpoint.
Planner acceptance is a separate review decision; no PR merge or deployment occurred.

## Decisions and changes

- No schema/migration changes, cache clearing, operation-key format change, access
  broadening, new application, task-003 work or PR merge.
- `src/server/notebook.ts`: required replay callback; current patient assignment
  refresh; actual document/snapshot relationship validation under consistent locks.
- `tests/integration/replay-authorization.test.ts`: five real PostgreSQL/HTTP cases
  detailed below; uses assigned-scope clinician rather than clinic-wide owner.
- `scripts/check-replay-before.mjs` plus reviewed-branch CI step: fetch the exact
  reviewed commit, temporarily run its server module against current regressions,
  require exactly three disclosure failures (actual 200, 200, 201 versus required
  404) plus two compatibility passes, then restore the candidate byte-for-byte and
  run the complete existing aggregate. The proof artifact is uploaded separately.
  This historical proof stage is limited to the task-002 review branch; normal
  regressions remain part of the full suite on every branch.
- Correction brief preserved in `tasks/002a-review-corrections.md`. Architecture,
  README and earlier handoff now point to this status rather than treating the old
  green checks as coverage of cached-result authorization.

The intended failure-first workflow could not execute before authoring the local
candidate: the test-only checkpoint was pushed first, but GitHub allocated no jobs.
The candidate was subsequently saved/pushed while that immutable checkpoint remained
available. This deviation is explicit. Once scheduling resumed, the final CI proof
stage actually captured the reviewed module's failures before executing the
corrected aggregate. The original test-only queued run was not used as a claimed
failure result. The archived proof contains actual HTTP status mismatches and TAP
results, not results inferred from source or test names.

## Verification evidence

| Exact command/scenario | Result | Meaning / limit |
| --- | --- | --- |
| `git status --short`, `git log`, `git ls-remote origin refs/heads/task-002-patient-notebook` before edits | Clean checkout; local/remote matched reviewed `b348991` | Existing source confirmed and preserved |
| Source trace of `idempotent()` and its three callers | Confirmed the two authorization bypasses described by planner | Code finding; not independent pre-fix HTTP reproduction |
| `git diff --check` | Passed | Patch formatting only; not type/runtime validation |
| Test-only remote runs `43097432827` (push), `43097437345` (PR) | Queued with zero jobs during the initial checkpoint | Not used as claimed failure evidence; final workflow independently executes the reviewed module |
| Initial corrected remote runs `43099341380` (push), `43099348669` (PR) | Queued with zero jobs during the initial checkpoint | Superseded by actual verified final application run |
| `gh api .../actions/runs/.../jobs` | `total_count: 0` for queued proof runs | Scheduling block confirmed; no local fallback started |
| Cancellation attempt against stalled test-only run | API 409: run has not been queued yet; GET still reports queued | GitHub scheduling inconsistency; no repo settings changed |
| Final CI: reviewed module + `node scripts/check-replay-before.mjs` | **Passed**: reviewed behavior has 3 failing authorization cases, 2 passing compatibility cases; exact 404-versus-200/200/201 mismatches asserted; candidate restore assertion passed | Real PostgreSQL/HTTP before-fix proof; expected failures isolated from corrected aggregate |
| Final Linux CI: `npm run check` | **Passed**: 13 foundation/policy tests, 13 PostgreSQL/HTTP tests (all 5 new cases passed), 3 browser scenarios, typecheck/build/compiled smoke; zero skipped PG checks | Full existing aggregate plus correction regressions on `6ab065f`; synthetic tests, not clinical validation |
| Final Windows `npm run typecheck`, `npm run test:unit`, `npm run build`, `npm run test:built` | **All passed**, 13 foundation/policy tests | Windows compatibility; real DB/browser coverage belongs to Linux job |
| Final Linux `npm audit --omit=dev --audit-level=high` and `node --import tsx scripts/check-provision.mjs` | **Passed**: zero known production dependency vulnerabilities; synthetic setup/repeat migration passed | Advisory snapshot and retained setup behavior, not a full security audit |

Passing application PR run: https://github.com/Imamatdin/clinora/actions/runs/43099855143
Push run with successful Linux/Windows jobs: https://github.com/Imamatdin/clinora/actions/runs/43099847851
Raw proof: `docs/verification/task-002a-before.txt`.
Redacted Linux output: `docs/verification/task-002a-linux.txt`.

Regression scenarios:

1. **cached and fresh draft saves reject mismatched patient/encounter while both assignments remain active** — fresh and cached wrong-patient URL must return non-disclosing 404; revision/audit/replay counts unchanged.
2. **cached draft cannot be replayed through another permitted patient after original assignment revocation** — A denied, B accessible, A's cached note through B denied without identifiers/content or writes.
3. **patient-create replay reauthorizes stored patient and never recreates a chart or restores revoked assignment** — authorized exact replay first, then revoked GET/search/create replay denied; counts/assignment remain unchanged.
4. **authorized stale-version replays stay exact; cached routes still deny revoked membership and session** — original revision-1 response survives a later revision; changed payload still conflicts; cached routes reject revoked membership/session with no clinical writes.
5. **simultaneous assigned-clinician patient-create retries return the same newly authorized patient** — four same-key requests must all return one patient, with one assignment/audit/replay addition.

All earlier concurrency, clinic isolation, immutable-version and transaction-failure
tests remain intact and required in the aggregate. No heavy tests, PostgreSQL,
browser installation or application build were run on the user's limited-RAM machine.

## Remaining issues

No correction acceptance checks remain blocked or skipped in the verified final
application run. The initial scheduling delay is historical. Planner review and
the task-002 production/clinical limitations still apply. The historical red-proof
step is limited to this review branch; future branches retain the full regression
suite without repeatedly substituting an old application module. No schema was
changed and no replay record was cleared. No user credentials or production access
were needed. Node/dependency tooling emits an existing `url.parse()` deprecation
warning; it did not fail the checks and was not changed in this bounded patch.

## Delivery state

- Implemented: source correction and five real HTTP/PostgreSQL regressions.
- Tested: actual reviewed-module failures, corrected PostgreSQL/HTTP regressions,
  complete Linux aggregate and Windows compatibility on final application `6ab065f`, all passed.
- Committed/pushed: existing task-002 branch and PR; exact delivered head in receipt.
- Merged: no. Deployed: no. Production systems or real patient data affected: none.
- Task 003: not started; original voice/Telegram and subsequent task scope retained.

## Next step

Return the verified before/after evidence and source for planner review. Only after correction acceptance should the planner
assign task 003. This handoff supersedes earlier broad replay-authorization claims.
