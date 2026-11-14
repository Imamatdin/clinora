# Clinora design language: Abr

Written 14 November 2026 for task 028. Chosen by Imamatdin from two phone stills; phase 1 applies it to the shell,
sign-in and four role screens. This file is the rule; `src/web/style.css` holds the tokens.

**Abr** is the Uzbek name for ikat, "cloud": the dye bleeds along the warp, so colour ends in a feathered edge instead of
a line. That is the idea of the whole interface. Nothing is fenced in a box; the one thing that matters on a screen sits
on a field of colour with a feathered edge, and everything else is plain rows.

## The test for every screen

Who is using it, what is in front of them, and what do they do next?

| Person | Situation | The screen is |
| --- | --- | --- |
| Doctor | Phone, patient sitting opposite | The next patient's name and one button |
| Registrar | PC, people standing at the counter | A search field; results as she types |
| Cashier | Patient hands over a ticket | The sum owed, pre-filled; the change to give back |
| CEO | Phone, evening | How much today, who owes, is anything wrong |

Then two checks. Turn colour off: structure must still read. Swap the logo: if it could be any clinic SaaS, redo it.

## Rules

1. **One thing per screen.** The focal thing sits in the hero, on the abr field (`<AbrField>`). One primary button.
2. **No boxes.** No outlined or shadowed cards, no tiles, no pills on labels. Structure is type size, alignment,
   whitespace and one hairline between rows. The only raised surfaces are sheets and dialogs. The ward's bed map is
   the exception: a bed is a tile because the map is a picture of the ward.
3. **Three dyes, one job each.** Indigo acts (the primary button, the current place). Pomegranate (`--attn`) means
   "needs you": debt, an open shift, an error. Glaze (`--ok`) means done: paid, seen. Saffron appears in the pattern
   only. Text is deep indigo, never black; the ground is unbleached cotton, never pure white. No gradients, no purple.
4. **People in serif, everything else in Onest.** Names and the greeting are set in Source Serif 4 600. Sums, labels
   and buttons are Onest. Both are bundled and checked letter by letter (`tests/font-coverage.test.ts`): Literata, the
   first choice, had no Ҳ and would have drawn "Ҳамидов" in a fallback font without anyone noticing.
5. **The ticket.** A queue number is drawn as a ticket (`<Ticket>`): solid indigo for the person being called, pale
   for those waiting, glaze for those seen. It is the same object at registration, in the doctor's queue and on paper.
6. **Set once, then out of the way.** Language, PIN, Telegram and installing the app live in Settings. The language is
   saved to the account and follows the person to every device; a new account starts in the clinic's language. The
   header holds the clinic, the business day and, on shared PCs, "switch user". Nothing else.
7. **Navigation is one flat list.** A person sees every screen their roles allow, once. Desktop: a left rail. Phone: a
   bottom bar of at most five places; with more, the fifth is "More" and opens the rest as a sheet.
8. **Rare actions go one tap deeper, into a sheet.** Discount, refund, cash-out, closing the shift, closing the day.
   A sheet closes itself when its action is recorded. Money actions still confirm in words first.
9. **Words.** No sentence under a title. Labels of one or two words. A number beats a sentence. Dates as 14.11.2026.
   The app greets by name and patronymic ("Ассалому алайкум, Азиз Рустамович") and says "Ҳорманг!" when the queue is
   done. Every phrase is checked by a native speaker before go-live.
10. **Icons.** One line set, 24 px grid, 1.5 px stroke, always beside a label. Four universal controls may be an icon
    alone, each with a spoken name: show password (eye), close, back, search.
11. **Motion.** One moment: when the head of the doctor's queue changes, that person's row moves into the hero. Sheets
    slide in. Nothing else moves, and nothing moves under `prefers-reduced-motion`.
12. **Touch and reading.** Targets of at least 48 px, body text 17 px, WCAG AA contrast. The on-screen number pad shows
    only on touch PCs; phones bring their own and a keyboard needs none.
13. **Inside Telegram** the same tokens take the person's Telegram theme colours, so the app matches light or dark.

## The pattern

`src/web/abr.tsx` draws ikat the way it is woven: rows of thin vertical threads with stepped, slightly uneven ends.
`AbrBand` (sign-in only) is the one loud, full-colour moment. `AbrField` is tone-on-tone and sits behind the hero. It
is decoration: `aria-hidden`, never under text that must be read, and absent from print. One field per screen.

## Still open

- Phase 2: the visit note, laboratory, pharmacy, ward, surgery, reports, payroll, export, staff and catalog screens
  carry the tokens but keep their old structure. The cheat-sheet pictures under `/help` still show the old interface.
- An adras-literate eye should judge the pattern; Mashxura should check every Uzbek phrase.
