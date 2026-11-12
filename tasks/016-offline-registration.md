# Task 016: offline-tolerant registration and queue (part of C9)

Assigned to: Claude Code (builder). Review: Codex. Planner: 12 November 2026.
Base: `main` after 007 is merged. Branch: `task-016-offline`.
Read first: `docs/PRODUCT.md` ease-of-use rule 7, task 007 code, task 004 service worker.

## Goal
When the clinic's internet drops, the registrar keeps registering patients and issuing queue tickets; everything syncs exactly once when the connection returns.

## Build
1. Registrar screen detects offline (failed requests plus `navigator.onLine`) and shows a clear banner.
2. Offline actions (register patient, create visit with routing) are stored in IndexedDB on that enrolled device only, each with a client-generated idempotency key, and replayed in order when online. No other module works offline.
3. Offline tickets show a provisional code (device prefix plus local counter, for example `R1-07`) printed on the ticket; on sync the server assigns real queue numbers and the screen shows both so staff can call the patient. Document this clearly in the UI and cheat sheet text.
4. Conflicts (patient created twice, closed business day, deactivated service) surface in a "needs attention" list with a plain explanation and a one-tap resolution; nothing is silently dropped.
5. Stored offline data is limited to what registration needs, cleared after successful sync, and removed when the device is revoked or the user switches.

## Acceptance
Browser test with network offline: register two patients and route them, go online, both sync once with real ticket numbers; repeating the sync creates nothing; a conflict appears in the attention list; a different user on the same device cannot see the queued items after switching. Handoff at most 60 lines with PR and CI links.
