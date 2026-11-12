# Remaining builder briefs: 003–006

Issued 12 November 2026, Asia/Tashkent. The original six-task outline is in `DELIVERY-PLAN-002.md`. Detailed task 001/002/002a briefs remain under root `tasks/`. The user requested the remaining four briefs in `docs/`; their canonical paths are below.

| Task | Brief | Depends on |
| --- | --- | --- |
| 003 | [Voice and connected devices](tasks/003-voice-and-devices.md) | Corrected task 002/002a |
| 004 | [Documentation automation](tasks/004-documentation-automation.md) | Persistent, revisioned capture/transcript contracts from 003 |
| 005 | [Workflows, integrations and patient access](tasks/005-workflows-integrations-and-patient-access.md) | 004 approval/export and 003 linked channels |
| 006 | [Release and presentation](tasks/006-release-and-presentation.md) | Integrated behavior and evidence from 003–005 |

## Starting point and planner review

Planning base: `788272762ecb62d655875e006d679fb04ea81828` on `task-002-patient-notebook`, not the older foundation-only `main`.

On 12 November the planner inspected the 002a replay-authorization code, its five PostgreSQL/HTTP regressions and the committed before-fix proof. GitHub's API confirmed both referenced runs succeeded at application commit `6ab065f5864a1a0a31c9c9c232c516b827c35a13`:

- https://github.com/Imamatdin/clinora/actions/runs/43099855143
- https://github.com/Imamatdin/clinora/actions/runs/43099847851

The source now requires resource-specific authorization on cached responses and retains authorized stale-version replay. The proof records the reviewed module's three disclosure failures; the handoff records all five regressions passing on the correction. The planner accepts the bounded 002a correction for continuing to task 003 on this evidence. PostgreSQL/browser tests were not independently rerun by the planner; this is not a full security or production-readiness approval.

## How to use these briefs

All four detailed briefs are now supplied. This supersedes the old outline's statement that their detailed assignments will be issued later. It does not claim they are implemented or authorize conflicting parallel edits. Continue sequentially from the corrected code. A successor planner may revise later details as founder inputs arrive, while retaining the agreed scope and documenting changes.

At each task, inspect current HEAD/instructions, implement a working increment, run relevant tests and produce the dated repository handoff. The planner reviews evidence before accepting the increment; producing these four briefs does not pre-accept their outputs. Independent work can continue around a missing external input, but live-provider, device, clinician or destination checks must stay explicitly incomplete until performed.

Keep heavy builds, PostgreSQL and browser verification off Imamatdin's limited-RAM computer. Use the established remote CI arrangement and an explicitly configured staging environment for live checks. Preserve existing manual documentation, data and replay-authorization regression coverage. Add migrations rather than editing applied history; avoid introducing a second framework/auth system or separate clinical datastore.

Open inputs remain in PRODUCT/current handoffs. These briefs contain labelled working choices where needed, not new founder commitments: protected Telegram transcript review, synthetic audio retention, initial template selection and patient release workflow. Confirm actual demo languages/devices, clinic forms, provider budget/credentials and destination access as they become relevant. Do not wait for every answer to finish independent implementation, and do not label substitutes as completed live integrations.
