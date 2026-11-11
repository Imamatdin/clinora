# Clinora implementation handoff — task 002a

Date: 12 November 2026, Asia/Tashkent.
Task/increment: bounded task-002 replay-authorization correction; no new feature increment.
Repository: https://github.com/Imamatdin/clinora
Branch: `task-002-patient-notebook`; existing PR: https://github.com/Imamatdin/clinora/pull/1
Reviewed application: `b348991c87363eda79d30f983b7d46478dda9105`.
Test-only checkpoint: `7a282252c932adccf139a191d4815ec434619032`.
Initial correction: `e98660820eebfb1d7bd2e51afc749628a91ed262`.
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

**UNVERIFIED at delivery checkpoint:** runtime before/after reproduction and final
Linux/Windows acceptance. GitHub is holding the new runs as queued with zero jobs;
no new pass or observed failing HTTP response is claimed. This is a source correction
awaiting required remote evidence, not completed acceptance of task 002a.

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
available. This deviation is explicit. The CI proof stage must still capture the
reviewed module's failures before running the corrected aggregate; no failure-first
result has been invented or inferred from a test name.

## Verification evidence

| Exact command/scenario | Result | Meaning / limit |
| --- | --- | --- |
| `git status --short`, `git log`, `git ls-remote origin refs/heads/task-002-patient-notebook` before edits | Clean checkout; local/remote matched reviewed `b348991` | Existing source confirmed and preserved |
| Source trace of `idempotent()` and its three callers | Confirmed the two authorization bypasses described by planner | Code finding; not independent pre-fix HTTP reproduction |
| `git diff --check` | Passed | Patch formatting only; not type/runtime validation |
| Test-only remote runs `43097432827` (push), `43097437345` (PR) | **Queued, zero jobs** when checked repeatedly | Before-fix regressions have not executed |
| Initial corrected remote runs `43099341380` (push), `43099348669` (PR) | **Queued, zero jobs** at checkpoint | No corrected Linux/Windows result claimed |
| `gh api .../actions/runs/.../jobs` | `total_count: 0` for queued proof runs | Scheduling block confirmed; no local fallback started |
| Cancellation attempt against stalled test-only run | API 409: run has not been queued yet; GET still reports queued | GitHub scheduling inconsistency; no repo settings changed |
| Final CI: reviewed module + `node scripts/check-replay-before.mjs` | **UNVERIFIED / pending execution** | Must observe the three exact wrong-success statuses and two compatibility passes; restore-source assertion must pass |
| Final CI: `npm run check` | **UNVERIFIED / pending execution** | Requires all 13 foundation/policy tests, 13 PostgreSQL/HTTP tests and 3 browser scenarios, typecheck/build/compiled smoke; no PG skips allowed |
| Final Windows compatibility and production dependency audit | **UNVERIFIED / pending execution** | Prior task-002 results are historical, not fresh correction evidence |

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

GitHub scheduling is the current acceptance blocker. Observe actual red proof and
complete green Linux/Windows checks before approving task 002a or declaring task 002
accepted. If a test fails, inspect its actual output and correct the source; do not
weaken the assertions or count queued runs as passes. The final run IDs/commit are
in the output receipt and PR checks. No user credentials or production access needed.

## Delivery state

- Implemented: source correction and five real HTTP/PostgreSQL regressions.
- Tested: source/diff inspection only for the correction; runtime acceptance **UNVERIFIED**.
- Committed/pushed: existing task-002 branch and PR; exact delivered head in receipt.
- Merged: no. Deployed: no. Production systems or real patient data affected: none.
- Task 003: not started; original voice/Telegram and subsequent task scope retained.

## Next step

Finish the queued before/after remote proof and final aggregate, then return actual
results for planner review. Only after correction acceptance should the planner
assign task 003. This handoff supersedes earlier broad replay-authorization claims.
