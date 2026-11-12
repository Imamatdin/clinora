-- Task 015: one Telegram link per staff account and one webhook.
-- The doctor assistant now uses task 004's telegram_links (single-use invite confirmed in Telegram)
-- and task 004's webhook /api/telegram/webhook (update ids deduplicated in telegram_updates).
--
-- Confirmed 003C links move into telegram_links unless they conflict with an existing 004 link for
-- the same account or the same Telegram user; the 004 link wins because it was confirmed by the
-- person in Telegram itself. Links of accounts that are not active are not carried over: they
-- would grant nothing today, and a fresh invite is the safer way back in.
-- Pending (unconfirmed) 003C links and link codes never granted anything and are dropped.
INSERT INTO telegram_links(account_id, telegram_user_id, clinic_id, linked_at)
SELECT DISTINCT ON (l.user_id) l.user_id, l.telegram_user_id, l.clinic_id, COALESCE(l.confirmed_at, l.created_at)
  FROM assistant_telegram_links l
  JOIN accounts a ON a.id = l.user_id AND a.status = 'active'
 WHERE l.status = 'active'
   AND NOT EXISTS (SELECT 1 FROM telegram_links t WHERE t.account_id = l.user_id OR t.telegram_user_id = l.telegram_user_id)
 ORDER BY l.user_id, l.confirmed_at DESC NULLS LAST
ON CONFLICT DO NOTHING;

-- Telegram captures already stored keep their chat and message ids (unique per message), so a
-- redelivered voice message still creates no second capture after the switch.
DROP TABLE assistant_telegram_links;
DROP TABLE assistant_telegram_link_codes;
DROP TABLE assistant_telegram_updates;
