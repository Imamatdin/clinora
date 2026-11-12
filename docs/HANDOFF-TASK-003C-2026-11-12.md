# Clinora implementation handoff

Date and time including timezone: 12 November 2026, ~14:45 Asia/Tashkent
Task and increment: 003C, doctor assistant first slice (A1)
Repository and branch: Imamatdin/clinora, `claude/youthful-hypatia-pmnarw` (session branch; the brief named `task-003c-assistant`). Base `b9cee96`.
Source commit or archive hashes: 89f2d2c, 66728bf, 58caf17, plus the commit adding this handoff. No PR opened yet (not requested).

## Delivered behavior

- Doctor opens a visit → assistant panel: consent box, in-app recording (MediaRecorder, 5 s chunks, SHA-256 per chunk, ordered upload with retry), visible recording/uploading/transcribing/drafting states, retry/discard.
- Telegram: doctor gets a single-use, 15-minute link code in the app → `/start <code>` makes a *pending* link → doctor confirms the Telegram name in the app → voice messages become captures waiting in that doctor's inbox → attached to the open visit only after the doctor confirms. Bot replies are fixed notices plus a button; no patient data.
- Transcript stored with segment ids per encounter. Extraction returns typed proposals; the server rejects unknown fields, bad values, unknown lab codes, missing or foreign segment citations (another encounter or patient), "normal" not said in the cited words, and diagnoses/plans/exam backed only by patient speech. Every proposal is kept with its disposition.
- GP (терапевт) form: complaints, HPI, past history and allergies, examination (observed / measured / not examined), diagnosis (ICD-10 + text), plan, lab orders (10 synthetic labs), follow-up date. Accept / Edit / Clear per field, source words on tap. Later runs never overwrite a doctor-touched field; the new proposal is shown as "held".
- Approve: requires every proposal resolved, the current draft revision and the exact field revisions; writes one `document_versions` row (template `gp-assistant-v1`) through `requireApprovableVersion`, plus an immutable `assistant_approvals` row naming the field versions and the doctor. Retried approval returns the same result. Server-rendered A4 PDF from the approved version (DejaVu Sans; Uzbek Cyrillic, Latin ʻ and Russian checked visually).
- Panel UI in uz-Cyrl, uz-Latn and ru. Provider failure: clear message, manual entry of every field, approval still works.
- Adapters: `SpeechToText` (Aisha), `NoteExtractor` (Gemini on Vertex, via API key or service account), labelled simulated adapters, and an "unavailable" adapter when nothing is configured. Setup: `docs/demo/A1-SETUP.md`.
- Demo kit: `npm run db:demo` now also seeds "Каримова Дилноза" (prior visit, visit dated today); `docs/demo/A1-DEMO-SCRIPT.md`; `npm run assistant:eval` with the 10-case set in `src/modules/assistant/eval-set.ts`.

## Decisions and changes

- Owned: `db/migrations/003_assistant.sql`, `src/modules/assistant/**`, `src/server/assistant.ts`, `src/web/assistant/**`, `tests/assistant-form.test.ts`, `tests/integration/assistant.test.ts`, `tests/browser/assistant.spec.ts`, `docs/demo/**`, `assets/fonts/` (DejaVu, licence included), `scripts/assistant-eval.mjs`.
- Minimal shared edits: `app.ts` (route hook, audio purge timer), `notebook.ts` (`actorFor` exported), `notebook.tsx` (`visitExtra` slot), `main.tsx` (passes the panel), `scripts/demo.mjs` (one seed call), `package.json` (`pdfkit@0.17.2`, `@types/pdfkit`, eval script). `npm audit --omit=dev`: 0 vulnerabilities.
- Telegram linking uses tables this task owns, because 004 is not merged. Webhook path is `/api/assistant/telegram/webhook`, so it can't collide with 004's. Merge both onto 004's link table once 004 lands.
- Transcription runs only after a capture is attached to an encounter, so no unattached clinical text exists. Jobs run in-process with a durable lease (180 s, 5 attempts) and resume through lease expiry. They recheck the doctor's role and scope before publishing, and a discard defeats a late result.
- Raw audio is purged 24 h after capture, or immediately on discard. That is an engineering default, not a legal retention claim.

## Verification evidence

| Command | Result | Establishes / does not |
| --- | --- | --- |
| `npm run check` locally (PostgreSQL 16, Chromium 1243) | exit 0: 39 unit, 26 integration, 8 browser | Approval and stale rejection, foreign citations, chunk retries/gaps/conflicts, Telegram dedupe and forged webhook, A/B isolation, revocation and discard mid-run, manual path, 401/403/404/CSRF. Browser: fake-mic recording through real upload at 1280 and 390 px, language switch, PDF |
| GitHub Actions "Clinora checks" on this branch | runs 43191142004 and 43191473500 success; final run linked in the builder reply | The run for the handoff commit supersedes 43193096412 (cancel-in-progress) |
| Real Aisha / Gemini / Telegram | **Not run**: no keys in this session; aisha.group docs were unreachable from the sandbox | Aisha request and response shape follow public docs and are unverified against a live key; the Gemini express endpoint follows Google's reference |
| Measured accuracy (10 cases, phone mic) | **Not measured** | No word-error, missed-field or latency numbers exist. Do not quote any |

## Remaining issues

- Needs Imamatdin: Aisha key, Vertex credentials, bot token and webhook secret on staging; recordings of the 10 cases by real readers; Mashxura's fallback recording.
- The notebook timeline and editor still say "unapproved, revision 0" for a visit approved through the assistant. A manual notebook save after approval adds a newer unapproved version (the approval still points at its exact version). Fix this in the C6 doctor workspace by reading `assistant_approvals`.
- No amendment flow after approval yet. Speaker labels from Aisha are `unknown`, so clinician-only fields need a doctor-or-unknown segment (patient-only evidence is rejected).
- The shell's i18n is still uz-Cyrl only; the panel carries its own three dictionaries.

## Delivery state

- Implemented locally: yes. Tested: yes (above). Committed: yes. Pushed: `origin/claude/youthful-hypatia-pmnarw`.
- Deployed: no. Production data or external systems affected: none (synthetic data only, no provider calls).

## Next proposed task

Plug in the keys on staging and run `assistant:eval` with real recordings, then put the table in this handoff (before 19 Nov). After C3/C6: replace synthetic labs with catalog services (charge lines, source `assistant`) and add the doctor-queue entry point.
