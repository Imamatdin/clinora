# Six builder assignments

Planning update dated 11 November 2026. Six main assignments are planned, including completed task 001. Related increments from the original pack are grouped into larger implementation assignments; the scope remains intact. Targeted correction passes may be required when checks reveal defects. This is not a guarantee of six successful runs or a calendar estimate.

| Task | Main result | Scope |
| --- | --- | --- |
| 001 | Reproducible foundation | Source assessment, contracts, policy primitives, build/test/CI setup. Handoff received; source not independently reviewed. |
| 002 | Working clinical notebook | Approved clinician access, clinic-scoped patients, dated encounters/history, versioned drafts, PostgreSQL, usable responsive workspace. |
| 003 | Voice and connected devices | Browser consultation capture plus native Telegram/mobile dictation, secure doctor account linking, transcription, patient/encounter attachment, cross-device updates and recovery. |
| 004 | Documentation automation | Specialty templates, evidence-backed extraction, corrections and missing information, clinician review, exact-version approval, amendments, document generation/export. |
| 005 | Workflow and integration | Explicit clinician instructions become permitted referrals/follow-ups/tasks; selected authorized external adapters; truthful status/reconciliation; patient account access to permitted records. |
| 006 | Release and presentation | Integrated security/reliability review, clinician evaluation, language/device and UI fixes, staging setup, measured demo, backup recording and release handoff. |

The planner will issue detailed briefs after reviewing the previous task. Tasks 003 through 006 are directions, not authorization to start overlapping implementations now. Adjust the task contents when actual forms or supported external interfaces arrive; do not silently drop capabilities.

## New explicit Telegram requirement

Aziza wrote: 'Actually I want to have telegram bot ai assistant for doctors also' and 'So they can do their voice to text from mobile.' Imamatdin agreed.

Working interpretation: support voice messages sent to a bot, in addition to live browser/Mini App recording. This exact interaction has not yet been demonstrated to the founders. Securely link Telegram to an authorized clinician, transcribe a submitted voice message, allow correction, and explicitly choose the patient/encounter before attachment. Preserve the distinction between raw dictation, extracted clinical facts, and an approved document.

The prior specification's aggregate-only bot scope is therefore insufficient for the planned voice input. The channels for returning potentially sensitive transcripts, audio retention, processing consent, and patient identifiers need an explicit design in task 003. Use synthetic audio until that design and access controls are in place. A protected review page is a candidate output; do not silently assume unrestricted medical text belongs in ordinary bot messages.

Native Telegram voice-message processing is not a continuous stream of an in-progress conversation. Keep the asynchronous dictation path separate from live consultation capture. Do not claim real-time processing before the bot receives a recording.
