import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/*
 * Telegram Mini App init data validation (server side only).
 * Algorithm (core.telegram.org/bots/webapps, "Validating data received via the Mini App"):
 *   data_check_string = every received field except `hash`, URL-decoded, sorted by key, "key=value" joined by "\n"
 *   secret_key        = HMAC_SHA256(key = "WebAppData", message = bot_token)
 *   expected hash     = hex(HMAC_SHA256(key = secret_key, message = data_check_string))
 * Cross-checked against aiogram 3.15 `check_webapp_signature`. Duplicate keys are rejected outright.
 */

export const INIT_DATA_MAX_AGE_SECONDS = 3600;
/** Allowed clock skew for an auth_date slightly in the future. */
const FUTURE_SKEW_SECONDS = 60;

const TelegramUser = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  first_name: z.string().max(256).optional(),
  language_code: z.string().max(16).optional()
}).passthrough();

export type VerifiedInitData = {
  telegramUserId: number;
  languageCode: string | null;
  authDate: number;
  /** SHA-256 of the full raw string, used to refuse a second use of the same init data. */
  fingerprint: string;
};
export type InitDataFailure = 'malformed' | 'bad_hash' | 'expired' | 'future' | 'no_user';

export function secretKey(botToken: string): Buffer {
  return createHmac('sha256', 'WebAppData').update(botToken).digest();
}

/** Builds the data-check string from a raw init data query string; null when malformed or duplicated. */
export function dataCheckString(raw: string): { check: string; hash: string; fields: Map<string, string> } | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 8192) return null;
  const fields = new Map<string, string>();
  for (const [key, value] of new URLSearchParams(raw)) {
    if (fields.has(key)) return null;
    fields.set(key, value);
  }
  const hash = fields.get('hash');
  if (!hash || !/^[a-f0-9]{64}$/.test(hash)) return null;
  const check = [...fields.entries()].filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, value]) => `${key}=${value}`).join('\n');
  return { check, hash, fields };
}

export function verifyInitData(raw: string, botToken: string, nowSeconds: number, maxAge = INIT_DATA_MAX_AGE_SECONDS):
  { ok: true; value: VerifiedInitData } | { ok: false; reason: InitDataFailure } {
  const parsed = dataCheckString(raw);
  if (!parsed || !botToken) return { ok: false, reason: 'malformed' };
  const expected = createHmac('sha256', secretKey(botToken)).update(parsed.check).digest();
  const given = Buffer.from(parsed.hash, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'bad_hash' };
  // Only signed fields are read from here on.
  const authDate = Number(parsed.fields.get('auth_date'));
  if (!Number.isInteger(authDate) || authDate <= 0) return { ok: false, reason: 'malformed' };
  if (nowSeconds - authDate > maxAge) return { ok: false, reason: 'expired' };
  if (authDate - nowSeconds > FUTURE_SKEW_SECONDS) return { ok: false, reason: 'future' };
  let user: z.infer<typeof TelegramUser>;
  try { user = TelegramUser.parse(JSON.parse(parsed.fields.get('user') ?? 'null')); } catch { return { ok: false, reason: 'no_user' }; }
  return { ok: true, value: { telegramUserId: user.id, languageCode: user.language_code ?? null, authDate,
    fingerprint: createHash('sha256').update(raw).digest('hex') } };
}

/** Test and tooling helper: signs init data exactly as Telegram does. Never used to accept requests. */
export function signInitData(fields: Record<string, string>, botToken: string): string {
  const check = Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  const hash = createHmac('sha256', secretKey(botToken)).update(check).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}
