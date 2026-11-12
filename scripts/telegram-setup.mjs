// One-time bot setup on the real host: webhook with secret token, "Open Clinora" menu button, /start command.
// Reads TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, TELEGRAM_BOT_USERNAME and APP_ORIGIN (https) from the environment.
// Prints only pass/fail; never the token, secret or Telegram responses.
import { telegramConfigFromEnv } from '../src/modules/telegram/api.ts';
import { setupBot } from '../src/modules/telegram/webhook.ts';

const telegram = telegramConfigFromEnv(process.env);
if (!telegram) throw new Error('TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and TELEGRAM_BOT_USERNAME are required');
const origin = process.env.APP_ORIGIN ?? '';
const ok = await setupBot(telegram, origin);
console.log(ok ? 'Telegram webhook, menu button and commands set: PASS' : 'Telegram setup FAILED (check token, origin and network)');
process.exitCode = ok ? 0 : 1;
