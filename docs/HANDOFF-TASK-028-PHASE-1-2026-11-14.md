# Clinora implementation handoff
Date and time including timezone: 14 November 2026, Asia/Tashkent
Task and increment: Task 028 phase 1 (design language, shell, four role screens). Stops at gate 1 for Imamatdin.
Repository and branch: Imamatdin/clinora, `claude/focused-brahmagupta-er7whk` (session branch, not `task-028-design`)
Source commit or archive hashes: based on `main` 9cbbbec; font setup and two checks reused from closed PR #28 (f597ace)
## Delivered behavior
- Design language "Abr" (`docs/DESIGN.md`), chosen by Imamatdin from two stills: indigo ink, a feathered ikat field
  behind the one focal thing, the queue number as a ticket, names in serif.
- Shell: left rail on desktop, bottom bar on phones, one-line header. A Settings screen holds language, PIN, Telegram,
  install and sign out. The language is saved to the account (`POST /api/auth/locale`) and falls back to the clinic's.
- Doctor: next patient with age and waiting time, one "call" button; queue, inpatients and seen patients as rows.
- Registration: search field with results as she types; routing as rows with the waiting count per doctor.
- Cashier: sum owed as one figure, amount pre-filled, change shown for cash; discount, refund, cash-out and shift
  close in sheets, each with its own fields (before, one "amount" and one "reason" were shared by every action).
- CEO Today: revenue, patients, debt, 14-day bars, an attention list, payment mix, doctors and departments.
- First-screen visible words on the demo day, 390 px (1440 px): CEO 228 to 103 (270 to 113), doctor 70 to 48
  (91 to 51), registrar 46 to 17 (59 to 20), cashier 52 to 19 (67 to 22). The doctor's count is mostly patient names.
## Decisions and changes
- Server: `/api/auth/me` returns `locale`; memberships return `defaultLocale`; the dashboard response carries a
  read-only `trend`; queue tickets carry `createdAt`. No permission check changed. No migration.
- Overrides of the brief, agreed in chat: no cream paper, no monospace, eye icon for show-password, Settings instead
  of an account menu, ikat pattern, Source Serif 4 for names (Literata has no Ҳ). Touch targets stay at 48 px.
## Verification evidence
| Exact command or manual scenario | Result | What the result establishes and does not establish |
| --- | --- | --- |
| `npm run typecheck` | pass | Types only |
| `npm run test:unit` | 96 pass, 0 fail | Includes font coverage for both fonts and the stylesheet rules |
| `npm run test:integration` (PostgreSQL 16 local; CI uses 17.9) | 153 pass, 0 fail | Server behaviour unchanged; no new test covers `/api/auth/locale` at this level |
| `npm run build && npm run test:built` | pass | Build and smoke, not a deployment |
| `npx playwright test` | 33 pass, 0 fail | Every role flow on the new shell at phone and desktop widths, incl. the full clinic day; `reports.spec` checks the language is stored on the account |
## Remaining issues
- Phase 2 screens keep their old structure (see DESIGN.md). Merging now would deploy a half-redesigned app to the demo.
- `/help` cheat-sheet pictures and steps describe the old interface. CI had not run when this was written.
- Uzbek and Russian wording is mine and unchecked by a native speaker; the pattern is unchecked by anyone who knows adras. `npm run test:load` not run locally.
## Delivery state
- Implemented locally: yes. Tested: as above. Committed and pushed: branch above. Deployed: no.
- Production data or external systems affected: none.
## Next proposed task
Phase 2 after Imamatdin's call on gate 1: the remaining screens, new `/help` pictures, then the landing page.

