# Clinora builder handoff

Updated 11 November 2026, Asia/Tashkent.

This pack gives the implementation agents a shared product definition and their first bounded assignment. It contains instructions and assessment evidence, not a new application or completed fixes.

## Responsibilities

- Imamatdin coordinates with the founders, chooses business priorities, supplies access, and operates the builder agents.
- The planning assistant owns the shared product brief, architecture decisions, increment sequencing, builder task briefs, acceptance criteria, and review of returned evidence. It does not independently build the application unless Imamatdin asks it to.
- Builder agents implement their assigned work, test real behavior, and return reproducible evidence and a dated handoff. They do not independently redefine the product or distribute work into overlapping scopes.
- Founders and participating clinicians supply forms, validate clinical workflows, choose prices, and approve the intended use of clinic data.

## Start here

Give a builder this entire folder and the original source archives. Have it read `AGENTS.md`, `docs/PRODUCT.md`, `docs/STATE-2026-11-11.md`, and then execute `tasks/001-baseline-and-foundation.md`.

The existing assessment paths in the state file belong to the planning assistant's workspace. They are not assumed to exist on another agent's computer. Provide the archives or let the builder obtain the specified public repository itself. Do not send secrets in prompts.

Return the builder's handoff to the planning assistant before assigning the next increment. The planner will review the evidence, identify fixes, and issue the next task. This is an engineering review boundary, not a request for repeated permission to perform routine work within an assignment.

## Working method

Every increment must complete a useful task and leave the application runnable. Passing an isolated unit test does not establish that a deployed workflow works. Keep local implementation, tests, commits, pushes, staging, and production deployment separate in every report.

The full ambition includes live documentation, workflow actions, authorized integrations, a longitudinal patient record, Telegram, desktop, and specialty-specific forms. Sequence those capabilities; do not silently reduce the product to a static demonstration.
