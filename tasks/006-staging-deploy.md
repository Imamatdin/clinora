# Task 006: staging deployment at next.clinoraa.uz

Assigned to: Claude Code (builder). Review: Codex. Planner: 12 November 2026.
Base: `main`. Branch: `task-006-deploy`. Can start now; it deploys whatever is merged.
Read first: `docs/PRODUCT.md`, `docs/THREAT-MODEL.md`, `docs/INCREMENTS.md` (C9 gate).

## Goal

Every merge to `main` deploys automatically to `https://next.clinoraa.uz`, a staging environment with synthetic data only, so the founders test the real product as it grows and the Telegram Mini App has a stable HTTPS URL. The same setup later becomes production with a separate project, database and secrets.

## Build

1. Container: multi-stage `Dockerfile` (build web and server, run as non-root, only `dist/` and production dependencies in the final image), `/healthz` (process up) and `/readyz` (database reachable, migrations current).
2. Target: Google Cloud Run plus Cloud SQL for PostgreSQL in the founders' Google Cloud project (their startup credits). Region: the lowest-latency region from Tashkent among those offering both services; measure and record the choice. If the credits or project are not ready when you reach this step, deliver the full deploy package with the exact blocker named and keep it host-agnostic (the image runs on any container host with `DATABASE_URL`).
3. CI/CD: GitHub Actions deploys on push to `main` after the Linux checks pass, authenticating with Workload Identity Federation (no long-lived JSON keys in GitHub). The deploy identity has only Cloud Run deploy, Cloud SQL client and Secret Manager accessor roles. Iko gets a deploy-scoped account, the founders keep project ownership.
4. Migrations run as a separate step before traffic shifts; a failed migration stops the deploy and leaves the previous revision serving.
5. Secrets (database password, session secret, Telegram bot token and webhook secret, AI provider keys) in Secret Manager, injected at runtime. Nothing secret in the repo, image or logs.
6. Domain: map `next.clinoraa.uz` to the service with a managed TLS certificate. Write the exact DNS record(s) the founders must add at their registrar in `docs/DEPLOY.md`.
7. Security on the host: secure, httpOnly, SameSite cookies scoped to `next.clinoraa.uz` only (no `Domain` attribute, so nothing leaks to other `clinoraa.uz` apps); HSTS; trusted-proxy setting so client IPs come from Cloud Run's header and cannot be spoofed; request body and upload size limits; structured logs without patient fields.
8. Staging data: synthetic only. `db:demo` seeding is allowed in staging and refuses to run when `APP_ENV=production`. Daily automated database backup enabled; one restore into a scratch database performed and recorded.
9. `docs/DEPLOY.md`: architecture, how to deploy, roll back to the previous revision, rotate a secret, restore a backup, and the checklist for creating production later (separate project or at least separate database, secrets and service; real-data handling decided by founders first).

## Acceptance

- A merge to `main` is live at `https://next.clinoraa.uz` without manual steps; a failing check or migration blocks it.
- `/readyz` fails when the database is unreachable; Cloud Run keeps the old revision.
- Seeding refuses in production mode (test).
- No secret appears in the repo, image layers or logs (scan in CI).
- Rollback to the previous revision tested once and timed.
- Restore from backup tested once into a scratch database.

Return a handoff of at most 60 lines with the live URL, PR link and CI run link.
