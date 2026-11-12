# Task 017: end-to-end clinic day and UX consistency pass

Assigned to: Claude Code (builder). Review: Codex. Planner: 12 November 2026.
Base: `main` after 015, 019, 020 and 021 are merged. Branch: `task-017-e2e`.
Read first: `docs/PRODUCT.md` ease-of-use rules, the Claude Doc "Clinora: what we're building" role table (mirrored in PRODUCT.md), every merged handoff.

## Goal
One synthetic clinic day works end to end across all roles, every screen follows the same ease-of-use rules, and the founders can test without a guide.

## Build
1. Browser test of a full day: administrator opens the day; registrar registers and routes two patients (one outpatient, one admitted); doctor calls, writes and approves a note with prescription and lab order (assistant fallback mode); lab enters a result; pharmacy dispenses; surgery recorded; inpatient daily charges run; cashier takes partial and full payments with an approved discount and a refund; inpatient discharged; cashier closes shift; administrator closes the day; CEO sees totals that match; doctor sees own earnings.
2. Fix every break this exposes, in whichever module (small, targeted changes; note each in the handoff).
3. Consistency pass over all role screens: one main action per screen, large buttons, number pads for money and phone, confirmations in words for money, plain error messages, 360 px layouts, no icon-only buttons, the same header and navigation everywhere.
4. Translation completeness: every key present in uz-Cyrl, uz-Latn and ru (test fails on a missing key); Uzbek Latin text uses the official alphabet (oʻ, gʻ, sh, ch).
5. Role home screens: each role lands on its main job; navigation shows only that role's modules.
6. Demo data for the founders' presentation: `db:demo` produces a believable clinic day (patients in queues, a few admissions, some payments) so dashboards are not empty.
7. Open items from task 010: (a) decide whether the old notebook form below the doctor's visit screen stays; preferred: fold its remaining functions into the visit screen and remove it. (c) Lab results confirmed after their business day is closed: allow confirmation, post the charge to the current open business day with a reference to the original visit date; if no day is open, keep it pending until one opens.
8. Cheat sheets: one printable page per role in Uzbek Cyrillic generated from the app (`/help/<role>`), with the main steps and screenshots from the browser tests.

## Acceptance
Full-day browser test passes at 360 px and 1280 px; translation test passes; screenshots of every role home in all three languages attached as CI artifacts; handoff at most 60 lines listing every cross-module fix.
