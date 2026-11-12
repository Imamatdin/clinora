# Task 005: catalog and 1C import (increment C3)

Assigned to: Claude Code (builder). Review: Codex. Planner: 12 November 2026.
Base: `main` after 008 (core schema) is merged. Branch: `task-005-catalog`.
Read first: `docs/1C-BASELINE.md`, `docs/PRODUCT.md`, `docs/SPEC-CMS.md` section 9.

## Goal

The clinic's reference data lives in Clinora: departments, doctors, service groups, services and procedures with prices and price history, lab tests, room types, districts and mahallas, medicines and goods. An administrator builds it in one step by uploading the clinic's 1C `.dt` dump, previews it, and commits it. Manual editing covers everything after that.

## Build

1. Tables come from the core schema (`docs/DATA-MODEL.md`, task 008): departments, service_groups, services (kinds incl. medicine and good), service_prices, doctor_profiles, doctor_services, districts, mahallas, room_types, rooms, beds, expense_types. Add a migration of your own only for anything missing. Work in `src/modules/catalog/**`, `src/modules/import1c/**`, `src/server/routes/catalog.ts`, `src/web/catalog/**`, `src/web/i18n/catalog.*`.
2. `.dt` reader (`src/modules/import1c/**`): header `1CIBDmpF`, raw deflate from byte 9, parse 1C's tagged serialization. Extract only these catalog objects: БУЛИМ, ВРАЧЛАР, МИХИЛАР, МУОЛАЖА, Анализ, ЛАБАРАТОРИЯ, ХоналарТипи, Туман, МФЙ, Дорилар, Товары, plus prices wherever the configuration stores them (find out and document). Never read, log or store БЕМОРЛАР or any document data. Report what Мумкун and Каровчи contain (structure only, no personal names) in the handoff.
3. Test fixtures: real `.dt` files must never enter git or CI. Build a small synthetic `.dt`-format fixture generator for tests. Imamatdin runs the reader locally against the real files placed in `data/private/` (gitignored) and pastes the summary output (counts per object, sample service names and prices, no patient data) into the handoff.
4. Excel/CSV import path for clinics without a readable `.dt`: column mapping screen, same preview.
5. Import flow (administrator only): upload, server parses, preview counts and a sample per object with rejected rows and reasons, commit in one transaction. Re-importing the same file changes nothing; a changed price creates a new `service_prices` row instead of overwriting.
6. Catalog screens for administrators: list, search in any of the three languages, edit, deactivate, set price (new dated price row). Doctors linked to staff accounts by picking from the staff list.

## Acceptance (CI)

- Synthetic `.dt` fixture parses to the expected objects; corrupted file fails with a clear error and writes nothing.
- Parser never emits data from patient or document objects (test with a fixture that contains them).
- Idempotent re-import; price change creates history; charges later read the price in force at the service date (expose a `priceAt(serviceId, date)` function with tests).
- Non-administrators get 403 on import and catalog writes; other clinic gets 404.
- Search finds a service by its Cyrillic, Latin or Russian name.

Return a handoff of at most 60 lines with the PR link, CI run link and the local real-file summary.
