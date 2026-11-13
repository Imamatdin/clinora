# Task 028: Clinora's design language, the whole app, and the landing page

Assigned to: Claude Code on **Claude Fable 5.2** (long-horizon design build). Review: Iko at each gate, then Codex. Planner: 14 November 2026.
Base: `main`. Branch: `task-028-design`. Supersedes task 026 (PR #28 is closed; reuse its Onest font setup, font-coverage test, box-shadow check and screenshot spec, discard its styling). Every merge to `main` redeploys the founders' demo on Railway.

## Why this task exists

Iko's verdict on the live app: too much text, cluttered, boxes everywhere, and it looks like the clinic's old system. Task 026 failed because it was a reskin: it kept every element and only changed colors. This task is a redesign. You may change layout, navigation, components, information hierarchy and wording. Ask "what does this person need to do next?" for every screen, then design that.

## Freedom and limits

Free to change: layouts, navigation model, components, which information is shown first and which sits one tap deeper, all UI copy (shorter, in uz-Cyrl, uz-Latn and ru), accessible names (update the tests to match).
Must keep: every capability reachable; server routes, data and permission checks unchanged (adding read-only fields for display is fine); offline registration; the Telegram Mini App theme; the printed queue ticket and server PDFs as they are; touch targets of at least 44 px; WCAG AA contrast; `prefers-reduced-motion`.

## The design language (write it to `docs/DESIGN.md` first, then follow it)

Concept: the clinic's day as one living ledger. Each role's home answers "what's next?", not "where is the menu?".

- **Paper and ink.** A warm off-white paper field (around `#F5F3EE`), graphite ink (around `#1F2321`), one muted ink, one hairline color. Primary actions in graphite (dark buttons), not colored.
- **One annotation color, with meaning.** A single vivid accent (Iko's vermillion, around `#E8553A`) marks only what needs attention: money owed, unpriced bed days, an open shift at day close, a locked PIN. If it isn't asking for action, it isn't vermillion. A calm teal may mark "done/healthy" sparingly. Nothing else is colored.
- **No boxes.** No bordered or shadowed cards, no tab-buttons in boxes, no pills on labels. Structure comes from type scale, alignment, whitespace and 1 px hairlines. Modals and menus are the only raised surfaces.
- **Type.** Onest for text (the only font verified to cover every character we ship). Numbers, times, ticket and patient numbers in a monospace with tabular figures; run the font-coverage test on any font before it renders text. At most 4 sizes per screen. Left-aligned, never centered body.
- **Copy diet.** No explanatory sentence under page titles. One- or two-word labels. A number beats a sentence. Empty states are one line. Help lives behind "Йўриқнома". Target: half the visible words of today on every role's first screen; measure and report before/after.
- **Navigation.** Desktop: a slim left rail with icon + short label, grouped (Today, Patients, Money, People, Reports). Phone: a bottom bar with the role's 4 most used destinations plus "More". Header: one line (clinic name, day status as a dot + date, account menu holding language, PIN/Telegram, sign out). Never show the same status twice on one screen.
- **Icons.** Thin line icons, one consistent set, 1.5 px stroke.
- **Motion.** One signature moment, not decoration everywhere: when a doctor calls the next patient, the patient moves from the queue into "now". Everything else changes state without flourish.
- **Banned:** card grids, KPI tiles, pills/badges as labels, gradients, glassmorphism, purple, drop shadows outside modals and menus, centered body text, hover animations on everything, stock illustrations, any screen that could belong to any other clinic SaaS with the logo swapped.
- **The test:** turn color off; structure must still read. Then ask whether this looks like any generic admin dashboard; if yes, redo it.

## Screens that matter most

- **CEO "Today":** three large figures (revenue, patients, owed) as type, not tiles; a 14-day revenue line with today marked; payment mix as one thin stacked bar; doctors and departments as rows with an inline bar proportional to their share; an "Attention" list in vermillion (owed visits, unpriced days, open shifts, pending approvals). Range as one segmented control (Today, 7 days, 30 days, custom). Every figure opens its records.
- **Doctor:** the next patient and one large "Call next"; today's list below; own inpatients one tap away.
- **Registration:** the search field is the screen; results as rows; new patient is one clear action.
- **Cashier:** find patient → bill as a ledger → amount due large → pay. One column on phones, bill and payment side by side on desktop.
- Then lab, pharmacy, ward (bed map stays a map, restyled), surgery, reports, payroll, export, staff, catalog, sign-in.

## Sequence and gates

1. **Phase 1:** `docs/DESIGN.md`, tokens, navigation shell, and the four screens above at 390 and 1440 wide. Before showing anything, critique your own screenshots against the banned list and the test, and iterate. Post screenshots (color and greyscale) in the PR and stop for Iko's approval.
2. **Phase 2:** every other screen in the same language. Screenshots of every role, then stop for Iko's approval.
3. **Phase 3: landing page** in `site/` (static Astro, zero JavaScript except the one scroll section; deploys to Vercel later at clinoraa.uz). Same DESIGN.md, font and tokens. Concept: one scroll-driven sequence following a patient through the clinic, built from real UI fragments and line drawing, no video, no stock photos: registration finds them by 4 phone digits → queue ticket → doctor speaks and the note writes itself with lab orders → lab result → payment → the CEO's day total ticks up. The rest is type-led: who it's for, the three languages, the first clinic going live, one call to action. Under 500 KB before fonts; works on 4G on a mid Android; reduced motion shows the steps as a still sequence. Copy that depends on the founders (call to action, pricing, proof) stays as clearly marked TODO lines in the source, never invented.

Acceptance: all existing tests pass (updated for new names and navigation); font-coverage and box-shadow checks pass; CI uploads screenshots of every role at 390 and 1440, in color and greyscale; word counts before/after for each role's first screen; Lighthouse performance 95+ on the landing page. Handoff at most 40 lines per phase.
