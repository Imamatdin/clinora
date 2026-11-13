# Task 022: audit fixes, security and access

Assigned to: Claude Code or Codex (builder). Review: the other model. Planner: 13 November 2026. Source: Fable whole-system audit of `main` at `06c963f`.
Base: `main`. Branch: `task-022-security`. Parallel with 023 and 024. Migration: `024_*.sql`. Every fix gets a regression test that fails before it.

1. **P1 Approval PIN brute force** (`cashier/actions.ts:292-348`, `inpatient/actions.ts:80-99`). One failure counter per approver across all devices and sessions, shared by cashier approvals and ward overrides. After 5 failures the approver's approval ability is locked until a CEO or another administrator clears it (audited); no time-based expiry. Validate the target (visit, payment) exists in the clinic before counting a guess. Approver PINs for CEO and administrator roles are at least 6 digits (existing shorter PINs must be changed at next sign-in). On lock, send the approver a Telegram notice with no amounts or patient data.
2. **P1 Doctor can read, overwrite and approve another doctor's note** (`assistant/service.ts:57,175`, `server/notebook.ts:279,299-302`). Apply the doctor workspace rule (only the encounter's clinician writes or approves; others read approved versions only when they have access) to the assistant routes. Remove the legacy notebook write and approve routes now that task 017 retired the old notebook UI; keep only what tests prove is still used, under the same rule.
3. **P3 Public self-registration is open.** Close it: accounts exist only through administrator-created staff or invites.
4. **P3 Administrator can act as a doctor after resetting their password or issuing a Telegram invite.** Notify the affected staff member by Telegram and on next sign-in ("Your password was reset by <name> at <time>"); doctors' and CEOs' credential resets by an administrator require CEO confirmation.
5. **P3 Patient assignments never expire.** Routing access lasts while the visit is open and for 30 days after it closes (clinic setting); admitted patients keep access during the stay. Re-routing grants it again. Approved notes stay readable by their author.
6. **P3 Telegram content.** Voice capture through Telegram is a clinic setting, off by default (in-app recording stays on). The day-close notice says only "Day closed" with a button; totals appear inside the app. Document both in PRODUCT.md.
7. **P3 Trigger rejections return 503.** Map database rule violations (closed day, discharged stay, append-only) to 409 with a plain message.

Acceptance: regression tests for each item; CI green. Handoff at most 40 lines.
