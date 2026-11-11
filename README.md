# Clinora

Project workspace prepared on 11 November 2026 (Asia/Tashkent).

Clinora is a doctor-facing clinical assistant centered on a persistent patient record. See docs/PRODUCT.md for the supplied planning baseline.

## Current status

Task 002 adds an authenticated, clinic-scoped notebook: permitted-patient search
and creation, dated encounter history, structured unapproved drafts, PostgreSQL
persistence, scoped invitations, revision conflicts and safe retries. The original
foundation and approval policy tests are retained. Clinical approval/export,
Telegram, audio, AI and patient login remain disabled until their assigned tasks.
Use synthetic patients only; this is not a clinically validated or deployed product.

## Run and verify

See **docs/RUN-NOTEBOOK.md** for PostgreSQL 17.9 setup, explicit owner provisioning,
optional synthetic demo, invitations and a walkthrough. Credentials are chosen by
the operator; no privileged defaults or role-switch shortcuts exist. Node 22.17.1
and npm 11.12.1 are retained. The agent uses GitHub-hosted runners for task 002's
heavy installation/build/PostgreSQL/browser checks to respect the user's RAM limit.

```powershell
npm ci
# Configure a dedicated TEST_DATABASE_URL ending in /clinora_test first.
npx playwright install --with-deps chromium
npm run check
```

`check` fails when PostgreSQL test configuration is missing; it does not quietly
skip database acceptance. It runs typechecking, pure policies, real PostgreSQL/HTTP,
both builds, compiled smoke and Chromium flows. CI has its own isolated test DB.
No provider or production credentials are required. `npm run test:unit` alone is
not complete task-002 verification.

The compiled server binds to loopback port 3001 by default. Set DATABASE_URL and
APP_ORIGIN explicitly before starting it. With no database configured, only the
foundation health/static interface is available and clinical routes remain closed.
Development proxy and HTTPS cookie settings are documented in the run guide.

## Engineering records

- docs/ARCHITECTURE-001.md — runtime, authorization and storage boundaries
- docs/ARCHITECTURE-002.md — concrete notebook transactions, access and limitations
- docs/RUN-NOTEBOOK.md — setup, credentials, remote verification and demo
- docs/REUSE-MANIFEST.md — verified sources, exact hashes and reuse decisions
- docs/THREAT-MODEL.md — controls, remaining threats and implementation gaps
- docs/NEXT-INCREMENT.md — proposed patient/timeline increment for planner review
- docs/HANDOFF-2026-11-11.md — exact outcomes and delivery status
- docs/HANDOFF-TASK-002-2026-11-11.md — notebook source, remote acceptance results and boundaries

One npm lockfile is authoritative. CI runs Linux PostgreSQL/Chromium acceptance
and separate Windows compatibility checks without production secrets. `src/contracts` is shared, `src/modules`
is server domain policy/ports, `src/server` is HTTP and `src/web` is the browser.
`db/migrations/001_notebook.sql` is the single clinical migration history. No
upstream clinical code, databases or migration chains were copied into the core.

## Planning pack

- docs/BUILDER_README.md — original handoff README
- AGENTS.md — implementation rules
- docs/PRODUCT.md — product definition
- docs/INCREMENTS.md — delivery sequence
- docs/STATE-2026-11-11.md — supplied assessment and source references
- tasks/001-baseline-and-foundation.md — completed foundation assignment
- tasks/002-patient-notebook.md — current notebook assignment
- docs/DELIVERY-PLAN-002.md — updated six-task scope, including native Telegram dictation later
- HANDOFF_TEMPLATE.md — implementation handoff format
- START_HERE.txt — original builder entry instructions

## Next step

Task 002 acceptance passed remotely. Review its dated handoff and committed source
before assigning task 003. Telegram/audio work has not started.
