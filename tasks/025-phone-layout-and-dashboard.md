# Task 025: phone layout and a calmer CEO dashboard

Assigned to: Claude Code (builder). Review: Codex. Planner: 13 November 2026. Source: Iko's phone review of `main` at `0fbb94c`.
Base: `main`. Branch: `task-025-phone`. No migration expected. Frontend and i18n only, plus a server field only if item 2 needs one.

Measured at 390×844 with the synthetic demo (`scripts/demo.mjs`): no horizontal overflow, but the CEO dashboard is 6,600 px tall (about 8 screens), mostly because each doctor gets 5 rows; the header takes about a quarter of the first screen on every role; tab rows are cut off at the right edge with no sign that more tabs exist.

1. **Header on phones.** One row: logo, clinic day badge, and a menu button holding the user name, language, "PIN and Telegram" and sign out. The full header stays as it is from 900 px wide.
2. **CEO breakdowns: doctors, departments, patient sources.** One row per item: name and amount, sorted by amount. Show the top 3, then an "All N doctors" (or departments, sources) button that opens the full list. Above the doctor list, department chips (#Терапия, #Жарроҳлик…) filter the list; "All" is the default. Tapping a row expands its details (patients, services value, discounts, owed) in place, and the existing drill-down arrow keeps working. The "—" row reads "No doctor (ordered at registration)". On a phone the whole dashboard fits in about 3 screens with the default view.
3. **Tab rows.** On phones, tabs that don't fit go into a "More" menu, or the row clearly signals it scrolls. Pick one pattern and use it in every role.
4. **Patient source labels.** `referral`, `social`, `returning`, `walk_in`, `advertisement` are shown translated in uz-Cyrl, uz-Latn and ru. An unknown code shows a translated "Other", never the raw code.
5. **Lab order card.** The label says who ordered it and their role. When a non-doctor ordered at registration, show "Ordered at registration", not "Ordering doctor: <registrar>".
6. **One look.** The CEO screens use the same palette as the rest of the app (the teal theme). No other visual redesign in this task.

Rules: every new string goes through i18n in all three languages; keep the touch targets at least 44 px; don't remove any information from the dashboard, only collapse it.

Acceptance:
- Browser tests at 390×844 for every role, asserting no horizontal overflow and that the header fits in one row.
- A test that the CEO dashboard shows 3 doctors by default and all of them after "All N doctors", and that a department chip filters the list.
- CI uploads full-page screenshots of every role's first screen at 390 and 1366 wide as a workflow artifact (no images committed to the repo).
- Handoff at most 40 lines, with the CEO dashboard height on a phone before and after.
