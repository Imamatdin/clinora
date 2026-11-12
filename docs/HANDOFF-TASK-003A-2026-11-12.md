# Clinora implementation handoff

Date and time including timezone: 2026-11-12, Asia/Tashkent (UTC+05:00)
Task and increment: 003A, roles, staff sign-in, business day (C1)
Repository and branch: Imamatdin/clinora, `claude/modest-volta-dhqe95` (the session-assigned branch, not the brief's `task-003a-roles`). PR: https://github.com/Imamatdin/clinora/pull/3
Source commit or archive hashes: base `4bfa9d9` (main, after PR #1); implementation `5800542`

## Delivered behavior

- Staff sign in with a login, phone (`+998 90 123-45-67`, `901234567`) or email, plus a password. Session, CSRF and rate-limit behavior are unchanged.
- CEO and administrators manage staff: create (temporary password shown once), change roles, block or unblock, reset password. A temporary password unlocks only the password-change endpoint, and the server enforces that. Every change writes an `audit_events` row; role changes record before and after.
- CEO and administrators open and close the business day. The date is the clinic's local date (`clinics.timezone`, default Asia/Tashkent). `close_snapshot` is `{}` until C8 fills it.
- Uzbek Cyrillic shell (`src/web/i18n/uz-Cyrl.ts`, `t()`): a home screen per role with placeholder modules (labelled "Тез орада"), and a header showing clinic, day state and the signed-in person. The notebook is now the doctor section, with all its strings translated. Tested at 360 px and on desktop.
- `npm run db:demo`: one synthetic clinic with logins `demo.ceo`, `demo.admin`, `demo.registrar`, `demo.doctor`, `demo.lab`, `demo.cashier` and `demo.inpatient`.
- Server actions live in `src/modules/staff/actions.ts` and `src/modules/business-days/actions.ts` as typed functions taking `(ClinicContext, zod input)`, so the assistant can reuse them later.

## Decisions and changes

- `requireRole` (`src/server/roles.ts`) runs on all 8 new routes (`src/server/clinic-routes.ts`) before the request body is parsed. Non-member or inactive membership gets 404; a member without the role gets 403.
- Only a CEO may grant or remove `ceo` or change a CEO. Nobody can change their own access, which prevents both self-escalation and lockout. Password resets and account-wide blocks apply only to accounts this clinic created (`accounts.managed_by_clinic_id`). Accounts the clinic did not create can only be blocked per membership, which stops cross-clinic takeover.
- The notebook's clinical gate is still `memberships.clinical_access`. Changing roles keeps it in step with the `doctor` role in the same transaction. Moving the gate onto roles is reversible and planned for C6. `memberships.role` is legacy and no longer read by new routes.
- Staff creation is not idempotency-cached, because the response holds the temporary password. A retry gets 409 `ALREADY_EXISTS`; the administrator then uses reset.
- New error codes: `PASSWORD_CHANGE_REQUIRED` (403) and `ALREADY_EXISTS` (409).
- CI: the Windows job runs on PRs only; the task-002a before-proof step and `scripts/check-replay-before.mjs` are removed. `playwright.config.ts` has an opt-in `PW_CHROMIUM_PATH`; CI does not set it.
- `notebook.test.ts` asserted exactly one applied migration. It now counts the files in `db/migrations`.

## Verification evidence

| Exact command or manual scenario | Result | What the result establishes and does not establish |
| --- | --- | --- |
| `npm run check` (local container, PostgreSQL 16, preinstalled Chromium) | Pass: 15 unit, 19 integration, built smoke, 5 browser | All acceptance flows on Linux. Not PostgreSQL 17.9 and not Windows; CI covers those |
| `tests/integration/clinic.test.ts` route matrix | 8 routes × (no session 401, wrong role 403, other clinic 404, unknown clinic 404) | Server-side enforcement per route |
| Role removal, same session | Next request 403; remaining role 200; notebook access follows the `doctor` role | Revocation without sign-out |
| Two concurrent `open` requests; direct SQL second open | 201 + 409; SQL raises 23505; closed-day UPDATE/DELETE rejected by trigger | One open day enforced by the database |
| Sign-in by login, upper-case login, three phone formats; blocked by login and by phone | 200 ×5; 401 ×2; existing session ends on block | Identifier resolution and blocking |
| Escalation probes (admin grants `ceo`, changes self or a CEO, resets an account the clinic did not create) | 403 each | Privilege boundaries |
| `tests/i18n.test.ts` (TypeScript AST scan) | Pass; a probe file with 3 hardcoded strings failed as expected | No hardcoded JSX text, attributes or literals |
| `tests/browser/roles.spec.ts` at 1280 and 360 px | Pass | Admin signs in, opens the day, creates a cashier; the cashier sets a password and lands on the cashier home; staff API returns 403 to the cashier; no horizontal scroll |
| `node --import tsx scripts/check-provision.mjs`; `npm audit --omit=dev` | Pass; 0 vulnerabilities | Demo creates one login per role |
| CI on PR (Linux on push and PR, Windows on PR only): https://github.com/Imamatdin/clinora/pull/3/checks | See PR checks | Gate on GitHub-hosted runners, including the Windows PR job |

## Remaining issues

- Login rate limit is still 40 attempts per IP per 15 minutes. A whole clinic behind one NAT could be locked out at shift start. This needs per-account keying (C9) before go-live.
- An open day from a previous date blocks opening today until someone closes it. The UI shows a warning. There is no automatic close by design.
- Only uz-Cyrl ships so far. uz-Latn and Russian need the same keys (typed by `UiKey`) and a per-clinic and per-user locale setting.
- The Uzbek wording should be checked by clinic staff (Mashxura) before go-live.

## Delivery state

- Implemented locally: yes. Tested: yes (local, see above; CI pending at writing).
- Committed and commit IDs: `5800542` plus this handoff commit. Pushed: `origin/claude/modest-volta-dhqe95`, PR #3.
- Deployed: no. Production data or external systems affected: none.

## Next proposed task

C1b (task 004, Telegram access and PIN switching), which builds on `membership_roles`, `requireRole` and managed accounts. Alternatively, C4 registration and queue once C3 lands.
