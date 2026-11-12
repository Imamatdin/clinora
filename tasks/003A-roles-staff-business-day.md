# Task 003A: roles, staff sign-in, business day (increment C1)

Assigned to: Claude Code. Planner: 12 November 2026.
Base: `main` after PR #1 (task 002) is merged. Branch: `task-003a-roles`.
Read first: `docs/PRODUCT.md`, `docs/SPEC-CMS.md` sections 2, 4 and 17, `docs/INCREMENTS.md`.

## Goal

Turn the notebook foundation into the clinic system's backbone: clinic staff with roles sign in, an administrator manages them, and the clinic works inside an open business day. The UI shell is in Uzbek Cyrillic with navigation per role.

## Build

1. Migration `db/migrations/002_clinic_roles.sql` (you own migration number 002):
   - `membership_roles(clinic_id, user_id, role)` with role in `ceo, administrator, registrar, doctor, laboratory, cashier, inpatient`; primary key on all three; foreign key to memberships. Migrate existing rows: `administrator` stays administrator, `clinician` becomes doctor, `is_owner` also gets ceo.
   - Accounts: add `login` (lowercase, unique) and `phone` (unique when present); make `email` nullable. Sign-in accepts login or phone plus password. Keep the existing session, rate-limit and CSRF behavior.
   - `business_days(id, clinic_id, business_date, status open|closed, opened_by, opened_at, closed_by, closed_at, close_snapshot jsonb)`; unique `(clinic_id, business_date)`; partial unique index allowing one `open` day per clinic.
2. Server: one `requireRole(...roles)` guard used by every new route, reading current roles from the database per request (revocation takes effect on the next request). CEO and administrator can manage staff; only they can open or close a day. Opening a day for a date that already has a closed day is rejected. Closing writes `close_snapshot` as an empty placeholder object for now (C8 fills it).
3. Staff management API and screen for administrator/CEO: create staff member (full name, login, phone, roles, temporary password shown once), change roles, block, reset password. Every change writes an audit event.
4. UI shell: `src/web/i18n/uz-Cyrl.ts` dictionary and a `t()` helper; every visible string goes through it. Role-based home screen per role with placeholders for the modules not built yet. Header shows clinic name, today's business day state (open or closed) and the signed-in person. Works at 360 px wide and on a desktop.
5. Synthetic bootstrap: `npm run db:demo` creates one clinic with one user per role.
6. CI: run the Windows job only on `pull_request`; keep Linux on every push. Remove the task-002a-only "before" proof step. Stop committing CI output under `docs/verification/`.

## Out of scope

Catalog, patients registration fields, queues, billing (other tasks own them). Do not edit `src/modules/billing/` (task 003B).

## Acceptance (CI)

- For every new route: unauthenticated 401, wrong role 403, other clinic 404.
- Removing a role takes effect on the next request without signing out.
- Database rejects a second open business day for the same clinic, including under two concurrent open requests.
- Sign-in by login and by phone works; blocked account cannot sign in.
- Existing task-002 tests still pass.
- Browser test: administrator signs in, opens the day, creates a cashier, the cashier signs in and sees the cashier home.

Return a handoff of at most 60 lines with the PR link and CI run link.
