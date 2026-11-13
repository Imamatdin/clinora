# Task 024: audit fixes, scale and safe deploys

Assigned to: Claude Code or Codex (builder). Review: the other model. Planner: 13 November 2026. Source: Fable whole-system audit of `main` at `06c963f`.
Base: `main`. Branch: `task-024-scale`. Parallel with 022 and 023. Migration: `026_*.sql` if needed.

1. **P2 Reports scan the clinic's whole history** (`reports/records.ts:215-270`, full export). Query only the requested range plus open balances computed by an aggregate, not by loading every unpaid visit. Add a load test with synthetic data for two years at 150 outpatients and 20 inpatients a day: day close, dashboard (today and 30 days), doctor earnings and payroll each finish under 2 seconds on the CI database; record timings in the handoff. Stream the full export instead of building it in memory.
2. **P2 Migrations unsafe on a live database** (`server/database.ts:9,38-49`). Run each migration file in its own transaction with `lock_timeout` (5 s) and a migration-specific statement timeout (no 10 s cap); retry on lock timeout. Split database roles: a migration owner role runs DDL; the application role gets DML only and cannot alter or drop tables or triggers. Update `deploy/gcp/bootstrap.sh`, the migrate job and `docs/DEPLOY.md`, and add a test that the app role cannot drop an append-only trigger.
3. **P3 Assistant jobs stall when Cloud Run throttles CPU.** Set CPU always allocated and at least one minimum instance for the service in the deploy template (document the cost), or move transcription and drafting jobs to Cloud Tasks; choose and document.
4. Production checklist in `docs/DEPLOY.md`: separate project or database, separate secrets, backups with tested restore, the role split above, and the real-data decision by the founders before the first real patient.

Acceptance: load-test timings meet the target; migration tests pass; CI green. Handoff at most 40 lines.
