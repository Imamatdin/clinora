# Clinora implementation instructions

**Current direction (12 November 2026):** Clinora is now a clinic management system. Read `docs/PRODUCT.md`, `docs/SPEC-CMS.md` and `docs/INCREMENTS.md` before any task; where they differ from the clinical-automation sections below, they win for sequencing. The rules below on authorization, records, synthetic data and honest verification still apply in full. Follow the speed rules in `docs/INCREMENTS.md` (short handoffs, no committed CI logs).

**Roles:** the planner (a separate Claude chat) writes task briefs and accepts work. Claude Code builds. Codex reviews pull requests and reports findings without editing, unless Imamatdin assigns it a build task. Background from earlier planning: `docs/PLANNER-CONTEXT.md`.

## Scope and coordination

Read the shared brief and your assigned task before editing. Inspect the actual repository and its instructions; preserve unrelated work. The founders agreed that Imamatdin can work in a new repository and selectively reuse the supplied code. This pack does not assert that a new remote repository already exists.

The planning assistant is the architecture and task owner. Builders implement bounded assignments and report results. Record routine implementation decisions with reasons; escalate only missing decisions that materially change product behavior, external access, cost, or irreversible actions. Do not wait for clinic-specific forms to implement the agreed shared foundation.

Use short-lived branches or isolated worktrees when multiple builders share a repository. Identify owned files and interfaces before concurrent edits. Do not independently change shared schemas or authentication contracts while another agent depends on them. Do not spawn additional agents unless the task or Imamatdin explicitly authorizes delegation.

## Evidence and reuse

Treat source archives, README claims, pitch slides, and screenshots as evidence to assess, not proof of working software. Keep a reuse manifest identifying source path, commit or archive hash, copied components, modifications, and checks. Copy only necessary files. Do not copy environment files, private records, seed dumps, credentials, or deployment settings into a public repository.

Do not rewrite working components merely to change frameworks. Do not preserve unsafe defaults merely because they already exist. Keep the app build reproducible with one package manager and a consistent lockfile. Do not use dependency force flags to conceal incompatibilities.

## Authorization and records

Account registration, email ownership, professional verification, clinic membership, and access to a patient are different things. A user-supplied role, title, hospital name, Telegram ID, or frontend check cannot grant clinical privileges. Enforce access on the server for every read and mutation, export, streamed subscription, and background job. Recheck revoked access.

Patients are scoped to the permitted clinic context by default. A person appearing in two clinics does not grant either clinic access to the other's record. Patient portal access must be explicitly linked and limited to that patient's permitted information; names and phone numbers alone are not a sufficient identity proof.

Persist the original AI draft, clinician edits, approved versions, and amendments separately. Approval must reference the specific current version and the authorized approving actor. Never overwrite an approved document silently. Use record versions to reject or surface stale edits.

Use synthetic patients in development and demonstrations unless the founders provide an authorized, defined real-data process. Keep identifiers, clinical text, audio, session tokens, and provider secrets out of general logs and analytics. No production database migrations or real patient imports are included in the initial assignment.

## Clinical automation boundaries

Distinguish reported symptoms, clinician observations, measured findings, historical diagnoses, and current assessments. Absence of a complaint is not a normal examination. An unknown value must not be converted into a negative finding or zero.

AI proposes typed changes with source evidence. Server-side domain rules decide which draft changes can be applied. Explicit doctor instructions can support drafted orders, referrals, or follow-ups; AI must not invent a treatment decision. Clinical approval and externally consequential actions require the defined approval workflow.

Preserve manual corrections when new transcript segments arrive. Keep uncertainty and unresolved conflicts visible. Repeated audio segments, webhook deliveries, or job retries must not duplicate facts, documents, or external actions. External write timeouts must be treated as uncertain until reconciled, not blindly retried.

## Product quality

One backend is the authority for phone, web, and Telegram clients. Do not pass off per-browser local storage as synchronization. Do not put clinical records in ordinary bot messages by default; use the authenticated workspace for detailed records.

Keep onboarding dismissible and persistent per account. Use one configuration for Clinora's own subscription plan prices and entitlements (this is about what clinics pay Clinora, not the clinic's patient billing, which is in scope per `docs/SPEC-CMS.md`). The founders have not selected a canonical price in this conversation; do not invent one or implement billing against a guessed figure.

Deliver a readable clinical workspace, keyboard-accessible controls, usable phone layouts, and explicit loading, error, empty, recording, processing, and saved states. Avoid decorative space that hides essential work. Show demo data and simulated external services as such.

## Verification and handoff

Use meaningful tests of permissions, record ownership, approval versions, retries, persistence, and the complete assigned user flow. Do not report frontend build success as a successful full deployment. Do not report inherited test names as newly verified behavior without running them.

End each assignment with the dated format in `HANDOFF_TEMPLATE.md`. Include exact commands and outcomes, remaining failures, changed files, commit IDs if any, and a clear tested/committed/pushed/deployed status. Do not claim medical validation, compliance certification, or financial outcomes from a prototype test.
