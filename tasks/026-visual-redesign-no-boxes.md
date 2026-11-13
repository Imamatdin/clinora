# Task 026: visual redesign, structure without boxes

Assigned to: Claude Code (builder). Review: Codex. Planner: 13 November 2026. Source: Iko's design review: "no boxes, it isn't 2020; everything must change."
Base: `main` after task 025 merges (same files; do not start before). Branch: `task-026-redesign`. No migration. No behavior changes.

Today every screen is white bordered cards on a grey page, pills on every label, nested borders, system font. The redesign keeps every flow, field and accessible name, and changes how structure is shown.

## Rules

1. **No containers as structure.** No bordered, shadowed or white-on-grey cards for sections, list items, KPIs or forms. Structure comes from type size and weight, spacing, alignment and 1 px hairline rules between rows (a ledger, not a card stack). One page background everywhere. Modals and the phone menu are the only raised surfaces.
2. **Lists are ledger rows.** Name left, amount right in tabular figures, a hairline between rows, the whole row the tap target (at least 44 px). Applies to queues, staff, doctors, payments, lab orders, beds list views.
3. **Numbers as type, not tiles.** KPIs are large figures with a small label above, set in a row on desktop and stacked on phones. Money always uses tabular figures and the same thousands separator.
4. **Type.** Onest, self-hosted from `@fontsource/onest` (weights 400, 500, 700; no CDN; precached by the service worker for offline). It is the only candidate checked that covers every character in uz-Cyrl, uz-Latn and ru, including ў қ ғ ҳ and ʻ. Add a test that fails if any character in the i18n files is missing from the bundled font. Clear scale: page title, section label, row text, fine print; no more than 4 sizes per screen.
5. **Color.** Ink, one muted ink, one hairline color, the brand teal as the only accent (primary button, current tab, focus ring, links). Status colors (owed, error, warning, done) only where they mark a state, as text color or a small dot, never a filled badge. No purple, no gradients.
6. **Controls.** One solid primary button per screen area; everything else is a text button or an outlined button with no fill. Inputs keep a clearly visible field (filled background or underline; low-tech users must still see where to type). Chips only for filters (the department chips), not for labels; role and status labels become plain small text.
7. **Left-aligned.** No centered body text or centered empty states. Layout follows one column on phones and a wide left-aligned column with an optional side column on desktop; no symmetric card grids.
8. **The test:** remove all color and the structure still reads. Screenshots in greyscale must show sections and rows clearly.

## Sequence (quality gate in the middle)

- **Stage A:** design tokens (CSS variables), the font, and three screens: CEO dashboard, cashier, registration. Push the branch and post full-page screenshots at 390 and 1366 wide (CI artifact). Stop and wait for Iko's approval in the PR before Stage B.
- **Stage B:** every other screen, sign-in, modals, phone menu, printed queue ticket kept as is (paper format), server PDFs untouched.

Acceptance: existing browser tests pass unchanged except for selectors that relied on removed class names; the font-coverage test; a CSS check that fails on `box-shadow` outside modals and the menu; CI screenshot artifact of every role at 390 and 1366, in color and greyscale. Handoff at most 40 lines.
