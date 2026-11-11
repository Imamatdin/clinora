# Builder task 001 Baseline and foundation

Owner: implementation agent. Reviewer: planning assistant. Scope: increment 0. Read the other files in this pack first.

## Outcome

Prepare the new repository for incremental development using evidence from the supplied sources. Deliver a reproducible, tested foundation and a clear reuse decision. Do not rebuild the entire CRM, design a marketing site, or claim clinical automation is complete during this task.

## Inputs

The source archives and documentation-app repository listed in `docs/STATE-2026-11-11.md`. Use the assessed commit for reproducibility; inspect newer changes separately rather than silently changing the baseline. The old projects are reference inputs, not production environments to mutate.

## Work

1. Inspect the working directory, Git state, instructions, available runtime, and supplied files. If a new repo already exists, preserve its work. Otherwise initialize an isolated local `clinora` repository. Do not assume a remote URL, push destination, or credentials. A local repo is sufficient for this assignment.
2. Record source provenance and a keep/repair/replace decision for auth, clinic permissions, patient/encounter persistence, UI components, speech capture, document approval, Telegram linking, and integration adapters. Identify code that is genuinely reusable versus coupled to dentistry or a proprietary deployment.
3. Reproduce the important baseline checks without contacting live clinic systems. Inspect dependency scripts before running them. Resolve manifest/lockfile incompatibility by selecting compatible versions and testing the result, not force-installing. Document missing archive helpers rather than inventing a stub that pretends their checks passed.
4. Establish the TypeScript modular-monolith repository, build/typecheck/test scripts, sample environment documentation without secrets, and CI configuration that runs without production credentials. Prefer the working React/Vite and Node approach unless a demonstrated blocker warrants another choice. Pin chosen versions and record the reason.
5. Define shared contracts for clinic membership and verification state; patient identity; encounter occurrence time/location; draft/version/approval/amendment; transcript evidence; and integration status. Define API errors for forbidden access, stale version, unavailable integration, and invalid transition. These contracts prepare increment 1; do not fill the app with fake working controls.
6. Produce a short threat model and first-increment plan. Address self-granted roles, cross-clinic reads/writes, patient account linking, stale approvals, repeated requests, clinical content in logs, and secrets in client bundles. Explain which inherited components will enforce these controls.
7. Add only meaningful foundation tests. Verify fresh installation, build, typecheck, and the chosen test runner. Preserve the record of remaining upstream failures. Update the handoff and stop at the increment boundary for review.

## Acceptance

- A fresh checkout can run the documented commands without hidden local files.
- One consistent lockfile and a reproducible build exist.
- Source-copy provenance is explicit and no real records or secrets are added.
- Identity, clinic access, patient history, document versions, and approval contracts are consistent across modules.
- A patient Telegram identity is not treated as a doctor authorization.
- No production access, live billing, patient import, or external clinical write is necessary for this task.
- The handoff states precisely what is runnable, tested, still a contract, and not implemented.

## Return

Use `HANDOFF_TEMPLATE.md`. Include the repo path and remote only if one exists, commit IDs only if created, exact verification commands, reusable file paths, remaining failures, and the proposed first patient-timeline flow. The planning assistant will review and issue increment 1.
