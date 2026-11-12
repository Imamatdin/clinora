# Task 015: fold the assistant's Telegram linking into task 004's access

Assigned to: Claude Code. Planner: 12 November 2026. Base: `main` after 003C and 004 are both merged. Branch: `task-015-telegram-consolidation`.

## Why
003C shipped its own Telegram link tables and webhook (`/api/assistant/telegram/webhook`) because 004 had not merged. There must be one link between a Telegram user and a staff account, one webhook and one place where blocking a person cuts access.

## Change
- Use 004's Telegram links for the assistant; migrate existing 003C links (if any) into 004's table and drop the 003C link table through a new migration.
- One webhook endpoint (004's). Route voice messages to the assistant inbox from there; keep idempotency per Telegram update id.
- Voice notes from an unlinked or blocked user are rejected with the standard notice.
- Remove the duplicate linking UI from the assistant panel; point it to the staff Telegram invite.

## Acceptance
Existing 003C integration tests still pass against the unified path; a blocked staff member's voice message is rejected; one link table and one webhook remain. Handoff at most 30 lines.
