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
