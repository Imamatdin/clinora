# Clinora implementation handoff

Date and time including timezone: 13 November 2026, Asia/Tashkent
Task and increment: Task 026, visual redesign, Stage A only (tokens, font, CEO dashboard, cashier, registration). Waiting for Iko's approval before Stage B.
Repository and branch: Imamatdin/clinora, `claude/inspiring-cerf-85uolr` (the session's assigned branch, used instead of `task-026-redesign`), based on `main` at 91c6418 (task 025 merged).

## Delivered behavior

- Design tokens on `:root` (`src/web/style.css`): ink, muted ink, hairline, teal accent, status colors (owed, error, warning, done), four type sizes. Shared layer: outlined buttons, one solid primary, filled fields with a dark underline, text tabs with a teal underline, status as text or a dot, day state as a dot and text, ledger rows.
- Onest self-hosted from `@fontsource/onest` 5.3.1 (`src/web/fonts.css`): cyrillic, cyrillic-ext, latin, latin-ext in 400/500/700, woff2 only (117 KB), fixed file names, precached by `sw.js` (cache v2), served as `font/woff2`.
- CEO dashboard: KPI figures with labels above (a row on desktop, stacked on phones), methods and facts as ledger rows, doctors in a wide column beside departments and sources. Cashier: bill ledger with the amount due set large (owed color only when it is above 0), payment column beside the bill from 1000 px. Registration: results, points and services as rows, the patient as a heading, total and print in a side column from 1000 px.
- No behavior changes: same fields, text, roles and accessible names. Markup only gained wrappers and class names.

## Decisions and changes

- One thousands separator (a plain space, as `formatUzs`): CEO `money` no longer uses `toLocaleString('ru-RU')`; the doctor screen no longer uses U+202F. Server PDFs untouched.
- The font test found two characters Onest's text subsets lack: `→` in the three `catalog.err.NOT_A_DT` strings became `›`, and the U+202F above.
- Other screens pick up the tokens and shell but keep their cards until Stage B (payroll, rules, staff, doctor, lab, inpatient, pharmacy, catalog).

## Verification evidence

| Command | Result | Establishes / does not |
| --- | --- | --- |
| `npm run typecheck` | pass | |
| `npm run test:unit` (adds `font-coverage`, `css-rules`, a `pwa` font precache test) | 95 pass | every i18n character is in the subset that serves it, at all weights; `box-shadow` only on modals and menus; no gradients or purple |
| `npm run test:integration` (local PostgreSQL 16; CI runs 17.9) | 153 pass | |
| `npm run build && npm run test:built` | pass | font served same-origin as `font/woff2` |
| `npx playwright test` (all 32) | first run: 28 pass, 4 fail (a CSS `::before` became part of a button's accessible name; a Telegram header override); fixed, and those 4 specs (10 tests) rerun green | not a full green rerun of all 32; CI will run it |
| `tests/browser/redesign.spec.ts` | pass | every role at 390 and 1366, color and greyscale, renders in Onest, no sideways scroll; images in `docs/design/026-stage-a/` and the CI artifact |

## Remaining issues

- Stage B not started (by instruction). Decorative glyphs in markup (↗ ▾ ☰ ⌫) are outside Onest's text subsets and draw in the system font.
- Not checked on a real Android phone or Windows Chrome; screenshots are headless Chromium.

## Delivery state

- Implemented, tested locally, committed and pushed to `claude/inspiring-cerf-85uolr`; PR open for review. Not deployed. No production data or external systems touched.

## Next proposed task

Stage B after Iko approves (or with Iko's corrections): every remaining screen, sign-in, modals, phone menu; extend the screenshot spec to each role's main task.
