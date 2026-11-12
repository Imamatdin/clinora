# Task 018: 1C .dt reader for the real format

Assigned to: Claude Code (builder). Review: Codex. Planner: 12 November 2026.
Base: `main` (includes task 005). Branch: `task-018-dt-reader`.
Read first: `docs/1C-BASELINE.md` (especially "Inner format (observed)"), `src/modules/import1c/README.md`.

## Goal
The catalog import reads Gʻofurov klinikasi's real `.dt` dumps. Task 005's preview, validation, commit and Excel/CSV path stay as they are; only the reader changes.

## Build
1. Replace the assumed layout with a decoder for the observed binary tagged serialization: table definitions (field names, type letters, sizes) and rows (tags `0x82`, `0x9a`, `0x97`, `0xe2`, `0x8b`, `0x8f`, flags). Unknown tags stop the reader with a precise diagnostic (offset, tag, preceding table name), never a guess.
2. Resolve configuration object names to physical tables through the dump's `DBNames` mapping (metadata UUID to `ReferenceNN`), so the reader finds МУОЛАЖА, БУЛИМ, ВРАЧЛАР, МИХИЛАР, Анализ, ЛАБАРАТОРИЯ, ХоналарТипи, Туман, МФЙ, Дорилар, Товары, Расходлар by name.
3. Map fields: `Code`, `Description` and the configuration fields holding the three names; find where prices live (numeric `FldNN` on the catalog or an information register) and document the evidence.
4. Allowlist only: rows of any table not on the list are skipped without decoding their values (patients, documents, registers other than a price register).
5. Keep a synthetic fixture generator that writes this real binary format, and test the decoder against it, including unknown-tag and truncated-file cases.
6. Diagnostics mode for the planner's real-file runs: counts per object, field list per object, 5 sample rows per catalog object, price evidence. Never prints rows of non-allowlisted tables.

## Process
Push candidate readers early. Ask Imamatdin to tell the planner the commit; the planner runs `scripts/inspect-1c-dump.ts` on the real files and returns the diagnostics. Iterate until both real files read.

## Acceptance
Both real files produce non-zero counts for at least departments, doctors, services and lab tests, with prices for services, verified by the planner's run; synthetic-format tests pass in CI; the existing 005 tests still pass. Handoff at most 60 lines.
