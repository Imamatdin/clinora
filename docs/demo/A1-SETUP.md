# A1 doctor assistant: provider and bot setup (staging, synthetic data)

All values come from the environment of the server process. Never commit them; never paste them into chat or tickets.

| Variable | Purpose | Without it |
| --- | --- | --- |
| `AISHA_API_KEY` | Aisha speech-to-text (Uzbek/Russian). Optional `AISHA_STT_URL` (default `https://back.aisha.group/api/v1/stt/post/`), `AISHA_LANGUAGE` (`uz` default, `ru`). | Speech unavailable (or simulated, see below). |
| `VERTEX_API_KEY` | Gemini through Vertex AI express mode (header `x-goog-api-key`). | — |
| `VERTEX_SERVICE_ACCOUNT_JSON` (base64 of the key file), `VERTEX_PROJECT`, `VERTEX_LOCATION` | Gemini through a service account on the founders' Google Cloud project (uses the credits). Alternative to the API key. | Drafting unavailable (or simulated). |
| `GEMINI_MODEL` | Model id, default `gemini-2.5-flash`. Check the current Vertex model list before the demo. | Default used. |
| `ASSISTANT_TELEGRAM_BOT_TOKEN`, `ASSISTANT_TELEGRAM_BOT_USERNAME` | A **separate** assistant bot (from BotFather) until task 015 moves voice capture onto task 004's clinic bot. Telegram allows one webhook per bot, so startup refuses the same token as `TELEGRAM_BOT_TOKEN`. | Telegram capture and linking hidden. |
| `ASSISTANT_TELEGRAM_WEBHOOK_SECRET` | 32-256 characters of A-Z a-z 0-9 _ -; Telegram sends it back in `X-Telegram-Bot-Api-Secret-Token`. | Webhook returns 404. |
| `ASSISTANT_SIMULATION=true` | Use the labelled simulated adapters where no key is set. Demo fallback and tests only. | Missing providers fail visibly; manual note still works. |

Register the webhook once (run on a trusted machine; the token stays in your shell):

```bash
curl -sS "https://api.telegram.org/bot$ASSISTANT_TELEGRAM_BOT_TOKEN/setWebhook" -d "url=https://next.clinoraa.uz/api/assistant/telegram/webhook" -d "secret_token=$ASSISTANT_TELEGRAM_WEBHOOK_SECRET" -d 'allowed_updates=["message"]'
```

Raw audio is deleted 24 hours after capture (or immediately on "discard"). Deleting Clinora's copy does not delete Telegram's or the provider's copies; their retention terms apply separately. Real patient audio stays out until the founders define the data-handling arrangement.

Measured evaluation, once keys exist: record the 10 cases in `src/modules/assistant/eval-set.ts` (two readers, phone microphone, exam-room noise) as `E01.ogg` … `E10.ogg` in a folder outside the repository, then run `EVAL_DIR=<folder> npm run assistant:eval` and paste the table into the handoff.
