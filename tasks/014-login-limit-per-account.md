# Task 014: login rate limiting per account

Assigned to: Claude Code or Codex (small). Planner: 12 November 2026. Base: `main` after 006 merges. Branch: `task-014-login-limit`.

## Why
Login attempts are limited per IP (40 per 15 minutes, successes included). With real client IPs (task 006), a whole clinic behind one public IP shares that budget and can be locked out at shift start. The C9 gate requires per-account limiting.

## Change
- Count failed attempts per account identifier (login, phone or email after normalization), not per IP; successful sign-ins never count and reset the account's counter.
- Lock an account for 15 minutes after 10 consecutive failures; show a plain message with the unlock time; administrators can unlock early (audited).
- Keep a generous per-IP ceiling only as abuse protection (for example 300 failed attempts per 15 minutes), never counting successes.
- Unknown identifiers are throttled the same way without revealing whether the account exists.
- PIN lockout from task 004 stays as is (per account, 5 tries).

## Acceptance
20 staff signing in from one IP within a minute all succeed; one person's 10 wrong passwords lock only that person; responses for unknown vs known accounts are indistinguishable; administrator unlock works and is audited. Handoff at most 30 lines.
