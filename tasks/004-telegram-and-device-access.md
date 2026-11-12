# Task 004: Telegram and device access (increment C1b)

Assigned to: Claude Code (builder). Review: Codex. Planner: 12 November 2026.
Base: `main` after 003A is merged (needs roles, staff accounts, login/phone sign-in). Branch: `task-004-access`.
Read first: `docs/PRODUCT.md` (Access and Telegram, Ease-of-use rules), `AGENTS.md`.

## Goal

Staff get into Clinora without remembering passwords: on phones through the clinic's Telegram bot (Mini App) or the installed app, on shared clinic PCs through a device that stays signed in with per-person PIN switching. One backend, same screens everywhere.

## Build

1. Telegram bot integration (`src/modules/telegram/**`, migration `004_device_access.sql`):
   - Webhook endpoint protected by Telegram's secret-token header; reject anything else. Bot token and secret from environment only.
   - Bot menu button "Open Clinora" launching the Mini App URL. `/start <invite>` deep links handled.
   - Mini App sign-in: validate `initData` server-side (HMAC-SHA256 with the bot-token-derived key, `auth_date` freshness window of 1 hour, constant-time compare), then look up the linked staff account and issue the normal server session. Unlinked or blocked users get a plain "ask your administrator" screen.
2. Invite linking: administrator presses "Invite to Telegram" on a staff member; Clinora creates a single-use invite (random token, stored hashed, expires in 72 hours) shown as a link and QR. Opening it in Telegram binds that Telegram user id to the staff account after the person confirms their name. Relinking requires a new invite. Unlinking is one button. A Telegram id never grants access on its own; current roles are checked on every request.
3. Shared PCs: a device enrollment flow (administrator enrolls a PC once; device token stored as httpOnly cookie, hashed server-side, revocable). On an enrolled device, staff pick their name and enter a 4-6 digit PIN to become the active user; auto-lock after 10 minutes idle and on "Switch user". PIN attempts limited per account (lock after 5 wrong tries until an administrator resets), never per IP. PINs hashed like passwords.
4. Installed app: web app manifest, icons from the Clinora logo, service worker that caches the app shell only (no patient data in caches). "Install" hint on Android Chrome and desktop Edge/Chrome; iOS "Add to Home Screen" instructions.
5. Headers: adjust CSP so the Mini App works in Telegram (allow `https://telegram.org` script or self-host `telegram-web-app.js`; `frame-ancestors` must allow Telegram Web clients `https://web.telegram.org`). Keep everything else as strict as today.
6. Notifications service: a single function to send a bot message to a staff member by role or id, with templates that contain no patient name, diagnosis or result, only a notice and a button into the app. Unit-test the templates for forbidden fields.
7. UI: Telegram theme colors respected, back button wired, large buttons, all strings through i18n in the three languages.

## Acceptance (CI)

- Forged, expired, replayed or wrong-bot `initData` rejected; valid data for an unlinked or blocked user rejected.
- Invite reused, expired or revoked rejected; linking twice requires a new invite.
- Blocking a staff member ends their Mini App and PC access on the next request.
- PIN lockout is per account; a clinic of 20 people behind one IP is never locked out by one person.
- Revoked device token cannot sign in; service worker cache contains no API responses.
- Webhook without the secret header returns 401 and does nothing.
- Browser test: enrolled PC, two users switch by PIN, each action attributed to the right person.

Return a handoff of at most 60 lines with the PR link and CI run link.
