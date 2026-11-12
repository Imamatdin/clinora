# Task 006 — Operable release, clinician evaluation and presentation

Issued 12 November 2026. Integrates tasks 003–005; it does not replace their acceptance checks. Read `../REMAINING-TASKS.md` and all current handoffs. Keep presentation readiness and readiness for real patient use as separate conclusions.

## Outcome

A founder can open a stable deployed synthetic workspace, complete the agreed consultation on the actual presentation devices, show the resulting record and approved output, and explain accurately what works. The team has a reproducible release, measured limitations, operational controls and a clear route to the first authorized clinic rollout.

## 1. Close actual product gaps

- Reconcile implemented behavior against PRODUCT, all task briefs, reported bugs and founder feedback. Track every missing item as a defect, external blocker or explicitly deferred feature with its owner. No cosmetic “complete” status based on mocked services. Preserve multi-specialty, voice, Telegram, patient history, workflow and integration scope in this reconciliation.
- Confirm the presentation date/time, duration, devices, connection conditions and languages. Prepare a usable provisional script immediately, then adapt it to confirmed details. Confirm the first real clinic workflow/forms and who will review it. No invented deadline or claim that a template has clinician approval.
- Review the entire UI on desktop and phone: onboarding persistence per account, empty/error/loading states, capture/recovery, source review, approval, history, workflow delivery and patient access. Fix overflow, focus/keyboard behavior, misleading state labels and needless repeated data entry. Replace raw template IDs and technical error jargon in normal clinician flows with useful labels.
- Put user-visible strings in a maintainable localization layer. Ship the confirmed presentation languages consistently; remove partially translated clinical navigation. Have a competent speaker check terminology. Locale controls formatting, never changes stored time precision or clinical meaning.
- Use one plan/entitlement catalogue for every pricing surface. Until the founders select a canonical price, display an honest unavailable/contact state; do not choose between 99k and 250k by guesswork. Subscription billing remains unactivated unless its commercial terms and payment setup are explicitly supplied.

## 2. Release security and operations

- Review actual routes/jobs/subscriptions/media/export/portal paths against the threat model, including cached responses. Check clinic/patient authority, professional-status presentation, invitation/link lifecycle, account enumeration, session expiry/recovery, CSRF, logout/revocation and permitted admin actions. Implement credential recovery and verified email delivery or an explicitly controlled operational recovery process before real users depend on it; do not ship a public unauthenticated password-reset shortcut.
- Check real deployment behavior: TLS, secure cookies, trusted proxy configuration, origin/CORS/CSP, upload/body/time limits, rate limiting and safe error/log handling. Verify proxy address handling does not collapse all clinicians behind one global login lockout or trust arbitrary forwarded IPs. Scan repository/build artifacts for secrets and remove/rotate any exposed credentials through an authorized process.
- Separate staging/demo from real clinic data, secrets and storage. Use least-privilege application database/storage credentials. Keep demo seeding disabled in production. Configure bounded provider spend/usage and failure alerts; no unlimited retries or silent paid-provider failover.
- Package repeatable server/worker deployment, health/readiness checks, migrations and rollback procedure. Validate a fresh provision and an upgrade from the task-002 database with fictional records; do not merely test empty-schema setup. Use additive/compatible migration rollout where a destructive rollback would lose records.
- Configure encrypted transport/storage appropriate to the chosen services, backup scheduling and retention jobs. Perform a backup restore into an isolated environment and verify charts, approved versions, identity relationships and queued actions. Reconcile outbox state before restored workers dispatch anything. Record measured recovery time and recoverable point; do not invent an SLA.
- Implement auditable access/authority events and operational metrics without dumping clinical content. Monitor queue age, processing failures, provider latency/cost, failed logins, storage usage and integration uncertainty. Give operators safe recovery steps for each likely demo/clinic failure.
- Confirm actual hosting, provider, Telegram and patient-data handling arrangements before real clinical use. Describe verified controls and remaining requirements without claiming legal compliance or certification from tests. Synthetic demonstration can proceed independently of real-data approval.

## 3. Clinician and reliability evaluation

- Maintain a fixed, consented synthetic consultation set with expected facts/forms and reviewer corrections. Include the selected specialties/languages, negation, corrections, absent exams, names/numbers, background noise, interrupted speech and changed instructions. Real clinicians review the intended clinical content; builder assertions alone do not establish medical accuracy.
- Measure transcription and field-level errors, unsupported findings, missing required information, correction effort, end-to-end latency, successful completion and cost per consultation. Record provider/model/template versions and sample size. Establish release thresholds with the reviewing clinician before scoring the final set; no invented “99% accurate” or time-saved claim.
- Exercise longer consultations and concurrent clinicians at a documented load. Check patient isolation, bounded resource use, queue behavior and graceful degradation. Provider failure must leave a usable manual notebook. Test reconnects, device switching, expired sessions, stale writes, lost acknowledgements and workers restarting mid-job.
- Run current full CI on the release candidate and real browser/device tests on its staging deployment. Use intended desktop/phone clients; distinguish simulated viewports from physical Android/iOS and Telegram client behavior. Confirm actual microphone permissions and HTTPS behavior. Investigate failures; do not broaden testing indefinitely after required checks pass without a specific concern.

## 4. Deploy, rehearse and hand over

- Deploy an isolated synthetic staging/demo environment using the configured project and agreed budget. If credentials/project choice are missing, complete the deployable package and name the exact blocker; CI is not hosting. Do not provision unapproved paid infrastructure or migrate real patient data to make a demo work.
- Prepare stable fictional patients, permitted clinician/patient accounts and a reset procedure that cannot target production. Rehearse browser speech and native Telegram dictation, live form updates, a clinician correction, second-device continuation, approval/export and reopened history. Include workflow/patient access where time permits; disclose any simulated destination.
- Make a short backup recording from the exact release candidate and prepare a manual/pre-recorded-audio fallback. Clearly identify prerecorded or simulated elements during use. Never disguise fixture playback as a live provider call. Provide founders with concise demo steps and recovery actions, not developer commands in the presentation flow.
- Produce a capability/evidence matrix and first-clinic onboarding runbook: clinic owner setup, professional/clinical access process, assignments, consent, retention, provider/destination setup, training, support, feedback capture and rollback. Record critical versus noncritical known issues and the responsible owner.

## Acceptance and handoff

Provide the release commit and deployed version/URL, passing CI links, migration/restore proof, physical-device results, clinician-reviewed evaluation and measured costs/latencies, completed rehearsal, fallback recording, runbook and defect/blocker list. State separately: synthetic demo ready; pilot-ready under specified conditions; or blocked for real clinical use. Evidence must support each label.

No task promises investment, clinical outcomes, compliance certification or universal specialty reliability. The final handoff must make the implemented capability and the next clinic feedback cycle concrete, without silently removing incomplete agreed work.
