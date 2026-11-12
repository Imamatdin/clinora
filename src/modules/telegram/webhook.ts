import { timingSafeEqual, createHash } from 'node:crypto';
import { z } from 'zod';
import type pg from 'pg';
import { transaction } from '../../server/database.js';
import type { TelegramConfig } from './api.js';
import { consumeInvite, InviteToken, openInvite } from './links.js';
import { botLocale, botText, type BotLocale } from './messages.js';

/*
 * Telegram webhook. Authenticity comes only from the secret-token header Telegram sends with
 * every delivery (set via setWebhook). Each update_id is processed once; replies are sent after
 * the database commit and are never retried.
 */

/** Constant-time comparison of the X-Telegram-Bot-Api-Secret-Token header. */
export function webhookSecretMatches(given: unknown, expected: string): boolean {
  if (typeof given !== 'string' || !given) return false;
  const a = createHash('sha256').update(given).digest(), b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

const From = z.object({ id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), language_code: z.string().max(16).optional() }).passthrough();
const Chat = z.object({ id: z.number().int(), type: z.string() }).passthrough();
export const Update = z.object({
  update_id: z.number().int().nonnegative(),
  message: z.object({ from: From, chat: Chat, text: z.string().max(4096).optional() }).passthrough().optional(),
  callback_query: z.object({ id: z.string().max(128), from: From, data: z.string().max(64).optional(),
    message: z.object({ chat: Chat }).passthrough().optional() }).passthrough().optional()
}).passthrough();
export type Update = z.infer<typeof Update>;

type Outbound = { method: 'sendMessage' | 'answerCallbackQuery'; payload: Record<string, unknown> };

const openButton = (locale: BotLocale, appUrl: string) => ({ inline_keyboard: [[{ text: botText(locale, 'open'), web_app: { url: appUrl } }]] });

/** Processes one authenticated update. Returns what was sent, for observability in tests. */
export async function handleUpdate(pool: pg.Pool, telegram: TelegramConfig, appUrl: string, raw: unknown): Promise<{ duplicate: boolean; sent: number }> {
  const parsed = Update.safeParse(raw);
  if (!parsed.success) return { duplicate: false, sent: 0 }; // Acknowledge and ignore: retries would not fix it.
  const update = parsed.data;
  const outbound = await transaction(pool, async tx => {
    const fresh = (await tx.query('INSERT INTO telegram_updates(update_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING update_id', [update.update_id])).rows[0];
    if (!fresh) return null;
    await tx.query("DELETE FROM telegram_updates WHERE received_at < now() - interval '7 days'");
    const out: Outbound[] = [];
    const message = update.message;
    if (message && message.chat.type === 'private' && message.text?.startsWith('/start')) {
      const locale = botLocale(message.from.language_code), chat = message.chat.id;
      const parameter = message.text.split(/\s+/)[1] ?? '';
      if (parameter) {
        const invite = InviteToken.test(parameter) ? await openInvite(tx, parameter, false) : null;
        if (!invite) out.push({ method: 'sendMessage', payload: { chat_id: chat, text: botText(locale, 'startInvalid') } });
        else out.push({ method: 'sendMessage', payload: { chat_id: chat, text: botText(locale, 'confirmQuestion', { name: invite.name, clinic: invite.clinicName }),
          reply_markup: { inline_keyboard: [[{ text: botText(locale, 'confirmYes'), callback_data: `link:${parameter}` }], [{ text: botText(locale, 'confirmNo'), callback_data: 'nolink' }]] } } });
      } else {
        const linked = (await tx.query('SELECT 1 FROM telegram_links l JOIN accounts a ON a.id=l.account_id AND a.status=\'active\' WHERE l.telegram_user_id=$1', [message.from.id])).rows[0];
        out.push({ method: 'sendMessage', payload: linked
          ? { chat_id: chat, text: botText(locale, 'welcomeBack'), reply_markup: openButton(locale, appUrl) }
          : { chat_id: chat, text: botText(locale, 'notLinked') } });
      }
    }
    const callback = update.callback_query;
    if (callback && callback.message?.chat.type === 'private') {
      const locale = botLocale(callback.from.language_code), chat = callback.message.chat.id;
      out.push({ method: 'answerCallbackQuery', payload: { callback_query_id: callback.id } });
      const data = callback.data ?? '';
      if (data === 'nolink') out.push({ method: 'sendMessage', payload: { chat_id: chat, text: botText(locale, 'declined') } });
      else if (data.startsWith('link:')) {
        // The Telegram user who pressed the button is the one bound, as Telegram reports them.
        const result = await consumeInvite(tx, data.slice(5), callback.from.id);
        out.push({ method: 'sendMessage', payload: result === 'linked'
          ? { chat_id: chat, text: botText(locale, 'linked'), reply_markup: openButton(locale, appUrl) }
          : { chat_id: chat, text: botText(locale, result === 'taken' ? 'telegramTaken' : 'startInvalid') } });
      }
    }
    return out;
  });
  if (outbound === null) return { duplicate: true, sent: 0 };
  let sent = 0;
  for (const call of outbound) if ((await telegram.api.call(call.method, call.payload)).ok) sent++;
  return { duplicate: false, sent };
}

/** One-time bot setup: webhook with secret token, "Open Clinora" menu button and the /start command. */
export async function setupBot(telegram: TelegramConfig, origin: string) {
  if (!origin.startsWith('https://')) throw new Error('Telegram requires an HTTPS origin');
  const results = [
    await telegram.api.call('setWebhook', { url: `${origin}/api/telegram/webhook`, secret_token: telegram.webhookSecret,
      allowed_updates: ['message', 'callback_query'], drop_pending_updates: true }),
    await telegram.api.call('setChatMenuButton', { menu_button: { type: 'web_app', text: botText('uz-Cyrl', 'open'), web_app: { url: `${origin}/` } } }),
    await telegram.api.call('setMyCommands', { commands: [{ command: 'start', description: botText('uz-Cyrl', 'open') }] })
  ];
  return results.every(r => r.ok);
}
