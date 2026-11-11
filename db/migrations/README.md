# Migration boundary

No clinical database or migration exists in increment 0. Increment 1 must add a
single numbered PostgreSQL migration history here and a transactional repository
implementing `src/modules/patients/repository.ts`. Do not apply either upstream
project's migration chain to the new database.

Required constraints: clinic-qualified patient/encounter foreign keys, immutable
document-version rows, approval foreign keys to exact versions and actors,
unique scoped idempotency keys, and unique capture/sequence/revision coordinates.
Original AI output, human revisions, approvals and amendments remain separate.
New migrations run only against explicitly selected local/test databases until a
separate production rollout is authorized.
