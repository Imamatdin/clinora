/*
 * Outbound Telegram Bot API port. The real client calls api.telegram.org; tests use a recorder.
 * Delivery is at-most-once: a timeout is reported as `uncertain` and never retried blindly,
 * because Telegram may already have delivered the message.
 */

export type InlineButton = { text: string; callback_data: string } | { text: string; web_app: { url: string } } | { text: string; url: string };
export type ReplyMarkup = { inline_keyboard: InlineButton[][] };
export type SendResult = { ok: true } | { ok: false; uncertain: boolean };

export interface TelegramApi {
  call(method: 'sendMessage' | 'answerCallbackQuery' | 'setWebhook' | 'setChatMenuButton' | 'setMyCommands', payload: Record<string, unknown>): Promise<SendResult>;
}

export type TelegramConfig = {
  botToken: string;
  webhookSecret: string;
  /** Bot username without "@", used to build t.me invite links. */
  botUsername: string;
  api: TelegramApi;
};

/** Validates the environment once at startup. Returns undefined when Telegram is not configured at all. */
export function telegramConfigFromEnv(env: NodeJS.ProcessEnv, api?: TelegramApi): TelegramConfig | undefined {
  const botToken = env.TELEGRAM_BOT_TOKEN, webhookSecret = env.TELEGRAM_WEBHOOK_SECRET, botUsername = env.TELEGRAM_BOT_USERNAME;
  if (!botToken && !webhookSecret && !botUsername) return undefined;
  if (!botToken || !/^[0-9]{5,16}:[A-Za-z0-9_-]{30,64}$/.test(botToken)) throw new Error('TELEGRAM_BOT_TOKEN is missing or malformed');
  // Telegram allows 1-256 characters A-Z a-z 0-9 _ -. Require enough entropy to resist guessing.
  if (!webhookSecret || !/^[A-Za-z0-9_-]{32,256}$/.test(webhookSecret)) throw new Error('TELEGRAM_WEBHOOK_SECRET must be 32-256 characters of A-Z a-z 0-9 _ -');
  if (!botUsername || !/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(botUsername)) throw new Error('TELEGRAM_BOT_USERNAME is missing or malformed');
  return { botToken, webhookSecret, botUsername, api: api ?? httpTelegramApi(botToken) };
}

export function httpTelegramApi(botToken: string, timeoutMs = 8000): TelegramApi {
  return {
    async call(method, payload) {
      try {
        const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs)
        });
        const body = await response.json().catch(() => null) as { ok?: boolean } | null;
        return body?.ok === true ? { ok: true } : { ok: false, uncertain: false };
      } catch (error) {
        // Never log the URL (it contains the bot token) or the payload (it may contain names).
        const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
        return { ok: false, uncertain: timedOut };
      }
    }
  };
}

/** In-memory recorder used by tests and local development without a bot. */
export function recordingTelegramApi(): TelegramApi & { calls: { method: string; payload: Record<string, unknown> }[]; fail: boolean } {
  const recorder = {
    calls: [] as { method: string; payload: Record<string, unknown> }[],
    fail: false,
    async call(method: string, payload: Record<string, unknown>): Promise<SendResult> {
      recorder.calls.push({ method, payload: JSON.parse(JSON.stringify(payload)) });
      return recorder.fail ? { ok: false, uncertain: true } : { ok: true };
    }
  };
  return recorder;
}
