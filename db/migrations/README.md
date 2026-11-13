# Migration history

Task 002 adds `001_notebook.sql`, the first migration of this single PostgreSQL
history. Apply with `npm run db:migrate` and an explicit DATABASE_URL. The runner
uses a transaction and migration lock, stores SHA-256 checksums, safely skips
already applied unchanged migrations and rejects modified applied files. Do not
apply upstream migration histories to this database.

Implemented: clinic-qualified patient/encounter/document foreign keys, immutable
document versions, current-version composite reference, unique medical-record
numbers within a clinic, scoped idempotency results and audit events. Clinical
approval, audio/AI and integration persistence are reserved for later tasks.
New migrations run only against explicitly selected local/test databases until a
separate production rollout is authorized.

Task 008 adds `010_core_schema.sql`: every core table from `docs/DATA-MODEL.md` with
clinic-qualified foreign keys, append-only and status-transition triggers, and the minimum
indexes. Existing patients get `patient_no` in creation order per clinic; inserts that omit
`patient_no`/`full_name` (notebook, demo) are filled by trigger from the same counter. Feature
tasks add their own `0NN_<task>_<what>.sql`; never edit an applied migration.

Task 005 adds `016_catalog_import.sql`: is_active on districts/mahallas/room_types, 1C-code unique indexes for re-import,
`catalog_doctors` (1C doctors, linked to staff by an administrator) and staged import batches (catalog rows only).

Task 015 adds `019_assistant_telegram_unify.sql`: confirmed 003C assistant Telegram links move into task 004's
`telegram_links` (an existing 004 link for the same account or Telegram user wins; blocked accounts and pending
links are not carried over), then the 003C link, link-code and update tables are dropped.

Task 017 adds `023_lab_late_confirmation.sql`: `charge_lines.completed_business_day_id` (the day a completion was
posted to) and `lab_pending_confirmations` (late lab confirmations made while no business day was open; they post
when the next day opens). Closed-day snapshots and line values are never rewritten.
