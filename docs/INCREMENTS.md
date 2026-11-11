# Delivery increments

These increments preserve the whole product scope. They are task boundaries, not promises that every dependency can be completed within a calendar day. The upcoming presentation is next week according to the user; its exact date is unknown.

| Increment | Delivered behavior | Evidence required |
| --- | --- | --- |
| 0 | Reproducible new-repository foundation, selective reuse decision, threat model, and clean project checks | Fresh install; consistent lockfile; build/typecheck/test commands; copied-source manifest; documented auth and storage contracts |
| 1 | Approved doctor can create a patient, start a dated encounter, save a draft, reopen it, and see the patient's timeline | Persistence across restart; clinic and patient access denials; no self-granted doctor privilege; correct occurrence dates; accessible empty/error states |
| 2 | The same doctor accesses the same record from web and Telegram/mobile | Verified account linking; doctor versus patient distinction; revocation; second-device updates; conflict handling; no public record URLs |
| 3 | Conversation updates a specialty template with evidence, corrections, and uncertainty | Real microphone/transcription test on intended devices; clinician-reviewed staged cases; duplicate/out-of-order handling; preserved manual edits |
| 4 | Doctor reviews a specific document version, approves it, exports it, and can amend it later | Server approval checks; stale-version rejection; immutable approved content; audited amendments; source-consistent export |
| 5 | Approved clinician instructions prepare or execute permitted workflow actions | Defined action/approval matrix; task status; failure/retry handling; no AI-invented treatment orders |
| 6 | Outputs reach the selected external system, or a clearly labeled interim export path | Authorized adapter contract; external ID and reconciliation; duplicate prevention; measured manual handoff if integration is pending |
| 7 | Patient accesses their own permitted record; founders demonstrate a coherent release | Identity linking and patient isolation tests; role-specific navigation; clinician feedback; presentation rehearsal and labeled backup recording |

The first visible demo should appear during increment 1. Do not defer all UI or integration testing until the end. Integrate the core consultation flow continuously; adapt sequencing when the chosen partner workflow makes an earlier dependency necessary.

## Security and usability acceptance

- Signup cannot make a user a clinic-authorized doctor. An invitation or authorized clinic approval establishes scoped privileges; describe separately whether professional credentials were checked.
- Unauthenticated, wrong-clinic, wrong-patient, and revoked users cannot access records through API, exports, event subscriptions, or background work.
- Approving or exporting stale or edited-after-approval content fails safely or requests renewed approval.
- Guidance does not reopen on ordinary navigation after dismissal. Settings persist per account across devices where appropriate.
- Pricing reads from a shared plan catalogue. An unavailable catalogue shows an unavailable state rather than an invented price. Billing is not activated until founders settle plans.
- No unexplained horizontal scrolling through essential workflow steps on target phone or desktop screens.
- Acknowledged saves survive reload and server restart. Recording, transcription, extraction, and persistence states are distinct and visible.

## Evaluation set

Prepare clinician-reviewed staged consultations that cover mixed Uzbek/Russian speech, correction of duration or dosage, negation, missing examination, patient-reported medication versus a clinician order, historical versus new diagnosis, similar patient names, interrupted audio, stale edits, and repeated requests. Separate transcription errors from extraction and template-mapping errors.

Report sample size, unsupported statements, missed facts, clinician correction time, time to an approved document, update latency, and provider cost per consultation where measured. Never claim savings without a comparable baseline. Synthetic cases and small samples do not establish clinical validation.

## Review loop

Planner issues one scoped task with contracts and acceptance checks. Builder implements and returns the handoff. Planner inspects evidence and issues targeted corrections or the next increment. Founders/clinicians review working behavior at useful milestones. Feedback may change form mappings or order of work without discarding the shared architecture.
