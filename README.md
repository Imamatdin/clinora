# Clinora

Project workspace prepared on 11 November 2026 (Asia/Tashkent).

Clinora is a doctor-facing clinical assistant centered on a persistent patient record. See docs/PRODUCT.md for the supplied planning baseline.

## Current status

Task 001 / increment 0: a runnable React/Vite and Node foundation, shared runtime
contracts and tested policy primitives. The status screen connects to the real
health API and clearly labels clinical features as unimplemented. Authentication,
clinical persistence, recording, approvals, Telegram and integrations are not active.
This is not a clinical demo or clinically validated product. No upstream app code,
patient data, secrets or production configuration is included in this core.

## Run locally

Use Node 22.17.1 and npm 11.12.1 (the locally tested versions). No account, environment
file, database or provider credential is required for increment 0.

```powershell
npm ci
npm run check
npm start
```

Open http://127.0.0.1:3001. `check` runs strict typechecking, 12 policy/contract/HTTP
tests, both application builds and a separate built-process smoke check. The server
binds only to loopback and blocks all clinical API paths. Set `PORT` to change its
port. A future PostgreSQL setting is documented, not consumed, in `.env.example`.

For development, run `npm run dev:server` in one terminal and `npm run dev` in another,
then open http://127.0.0.1:5173. The default dev proxy expects API port 3001. The Node
development process serves the API only; the Vite process serves client files.

## Engineering records

- docs/ARCHITECTURE-001.md — runtime, authorization and storage boundaries
- docs/REUSE-MANIFEST.md — verified sources, exact hashes and reuse decisions
- docs/THREAT-MODEL.md — controls, remaining threats and implementation gaps
- docs/NEXT-INCREMENT.md — proposed patient/timeline increment for planner review
- docs/HANDOFF-2026-11-11.md — exact outcomes and delivery status

One npm lockfile is authoritative. CI is configured for Windows and Linux without
production secrets; hosted CI has not run. `src/contracts` is shared, `src/modules`
is server domain policy/ports, `src/server` is HTTP and `src/web` is the browser.
`db/migrations/` reserves one future PostgreSQL migration history; there is no
clinical store or migration runner in this increment.

## Planning pack

- docs/BUILDER_README.md — original handoff README
- AGENTS.md — implementation rules
- docs/PRODUCT.md — product definition
- docs/INCREMENTS.md — delivery sequence
- docs/STATE-2026-11-11.md — supplied assessment and source references
- tasks/001-baseline-and-foundation.md — pending foundation assignment
- HANDOFF_TEMPLATE.md — implementation handoff format
- START_HERE.txt — original builder entry instructions

## Next step

When implementation is requested, begin task 001 by inspecting available sources and the specified upstream commit. Record missing archives and current verification results separately from the supplied assessment. Stop at the increment 0 boundary.
