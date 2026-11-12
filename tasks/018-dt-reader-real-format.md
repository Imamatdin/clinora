# Task 018: 1C .dt reader for the real format

Assigned to: Claude Code (builder). Review: Codex. Planner: 12 November 2026.
Base: `main` (includes task 005). Branch: `task-018-dt-reader`.
Read first: `docs/1C-BASELINE.md` (especially "Inner format (observed)"), `src/modules/import1c/README.md`.

## Goal
The catalog import reads Gʻofurov klinikasi's real `.dt` dumps. Task 005's preview, validation, commit and Excel/CSV path stay as they are; only the reader changes.

## Build
1. Port `scripts/reference/dt_reference.py` (verified on both real files) into `src/modules/import1c/dt.ts`, replacing the assumed layout. Keep it streaming-friendly enough for the browser (the real files inflate to 4-5 MB); unknown tags stop with offset and tag.
2. Resolve objects by name through `Params/DBNames` and the `Config` files exactly as the reference does; never decode values of БЕМОРЛАР or Каровчи (skip their data lists) and never emit ВРАЧЛАР ПАРОЛ or Телефон.
3. Map to `ImportRow` per the table in `docs/1C-BASELINE.md` "Catalog mapping": services from МУОЛАЖА (price Fld54, department Fld55, MXIK Fld86), lab tests from Анализ items (price Fld317, reference range Fld316; groups become service groups), departments, doctors (name and role flags only), room types with daily bed price, districts, mahallas, medicines, goods, expense types. Store the MXIK code on services through a new migration (`services.mxik_code text`), shown in the catalog screen.
4. Synthetic fixture generator writing this exact binary format (schema, DBNames, Config names and attributes, data rows), including a patient table with marker text that must never appear in output.
5. Keep task 005's Excel/CSV path, preview, validation and commit unchanged.

## Process
The planner reruns the reader on the real files for every candidate commit and reports counts. Expected counts (12.07 file): 56 services, 77 lab tests, 9 departments, 15 doctors, 3 room types, 31 districts, 5 mahallas, 5 medicines, 1 expense type.

## Acceptance
Planner's real-file run matches the expected counts with prices; synthetic tests pass in CI; patient marker never appears; existing 005 tests pass. Handoff at most 60 lines.
