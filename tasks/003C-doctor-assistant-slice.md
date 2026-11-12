# Task 003C: doctor assistant, first slice (A1)

Assigned to: Claude Code (builder). Review: Codex. Planner: 12 November 2026.
Base: `main`. Branch: `task-003c-assistant`. Runs in parallel with 003A and 003B.
Read first: `docs/PRODUCT.md` (Agent layer, Access, Decisions 12 Nov), `AGENTS.md` clinical automation rules, `docs/backlog/ai-documentation/003-voice-and-devices.md` and `004-documentation-automation.md` for detail (their scope is larger than this slice; take only what is listed here).

## Goal

The President's Tech Award demo on 19 November, built as real product: a doctor records a consultation (in the app, or as a Telegram voice message to the clinic bot), Clinora transcribes it, drafts a visit note in one specialty form with every field linked to its source words, proposes lab orders, and the doctor approves field by field. The approved note is an immutable version in the patient's history (reuse task-002 encounters, documents and document_versions).

Owned files: `src/modules/assistant/**`, `src/server/assistant*.ts`, `src/web/assistant/**`, `tests/**/assistant*`, migration `db/migrations/003_assistant.sql`. Do not edit 003A's or 003B's files; if you need a shared route or UI shell change, keep it minimal and note it in the handoff.

## Build

1. Provider adapters behind interfaces: `SpeechToText` and `NoteExtractor`. Configure by environment variables. Ship a clearly labelled simulated adapter for tests and for running without keys. Real adapters: Aisha (Uzbek/Russian STT; see `docs/REUSE-MANIFEST.md` speech-capture notes) and a Gemini extractor through Vertex AI (the founders' Google Cloud credits cover Gemini). Activate each real adapter only when Imamatdin supplies its key; never commit keys.
2. Capture: in-app recording (browser microphone, chunked upload, visible recording, uploading, transcribing, drafting states) and Telegram voice messages (bot webhook with secret token, download via getFile, attach to the doctor's currently open encounter only after the doctor confirms in the app). Linking a Telegram user to a doctor reuses the invite-link rule in PRODUCT.md; if 003A's linking is not merged yet, use a minimal invite table you own and note it.
3. Transcript stored with segment ids. Extraction returns typed field proposals, each with source segment ids. Server validation rejects proposals that cite missing or foreign segments, and keeps "reported by patient", "observed by doctor" and "not examined" distinct; an unknown value stays empty, never "normal".
4. One specialty form: general practitioner (терапевт): complaints, history of present illness, past history and allergies, examination, preliminary diagnosis (ICD-10 code plus text), plan, lab orders, follow-up date. Lab orders are proposed from a small synthetic lab list until the catalog (C3) lands.
5. Review screen: each field shows the proposal, its source words on tap, and Accept / Edit / Clear. Manual edits survive later extraction runs. Approve creates an immutable document version referencing the exact field versions and the approving doctor. Prescription PDF generated on the server.
6. Works in Uzbek Cyrillic, Uzbek Latin and Russian UI; transcription handles mixed Uzbek/Russian speech as well as the provider allows.
7. Demo kit: `npm run db:demo` adds a synthetic patient with history; a written 2-minute demo script for Mashxura; a fallback recording and a fallback path that works with the simulated adapter, clearly labelled as such when used.

## Acceptance

- Approval writes one immutable version; unapproved proposals change nothing in the record; approving a stale version is rejected.
- A proposal citing a segment from another encounter or patient is rejected.
- Repeated Telegram updates or upload retries create one transcript and one attachment.
- Provider failure leaves a usable manual note and a clear message.
- Telegram bot messages contain no patient data, only a notice and a button into the app.
- Doctor A cannot attach audio to, or read, doctor B's patient.
- Measured, not claimed: run a fixed set of at least 10 short synthetic consultations (Uzbek, Russian, mixed; read by real people on a phone) through the real adapters once keys exist; report word errors on medical terms, missed fields and latency in the handoff.

Return a handoff of at most 60 lines with the PR link and CI run link.
