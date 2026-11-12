# A1 doctor assistant: provider and bot setup (staging, synthetic data)

All values come from the environment of the server process. Never commit them; never paste them into chat or tickets.

| Variable | Purpose | Without it |
| --- | --- | --- |
| `AISHA_API_KEY` | Aisha speech-to-text (Uzbek/Russian). Optional `AISHA_STT_URL` (default `https://back.aisha.group/api/v1/stt/post/`), `AISHA_LANGUAGE` (`uz` default, `ru`). | Speech unavailable (or simulated, see below). |
| `VERTEX_API_KEY` | Gemini through Vertex AI express mode (header `x-goog-api-key`). | — |
| `VERTEX_SERVICE_ACCOUNT_JSON` (base64 of the key file), `VERTEX_PROJECT`, `VERTEX_LOCATION` | Gemini through a service account on the founders' Google Cloud project (uses the credits). Alternative to the API key. | Drafting unavailable (or simulated). |
| `GEMINI_MODEL` | Model id, default `gemini-2.5-flash`. Check the current Vertex model list before the demo. | Default used. |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_BOT_USERNAME` | The clinic bot from task 004 (see `docs/DEPLOY.md`, Telegram). Since task 015 it also receives doctors' voice notes on its single webhook `/api/telegram/webhook`; the same token downloads the audio. The old `ASSISTANT_TELEGRAM_*` variables are ignored (startup logs a warning); remove them. | Telegram voice capture hidden; in-app recording still works. |
| `ASSISTANT_SIMULATION=true` | Use the labelled simulated adapters where no key is set. Demo fallback and tests only. | Missing providers fail visibly; manual note still works. |

Webhook registration is `npm run telegram:setup` from `docs/DEPLOY.md`; there is no separate assistant webhook. A doctor links Telegram once through the staff invite (administrator: "Invite to Telegram"; or the doctor: "PIN and Telegram"). Voice notes from unlinked, blocked or removed staff get the standard "ask your administrator" notice and are not stored.

Raw audio is deleted 24 hours after capture (or immediately on "discard"). Deleting Clinora's copy does not delete Telegram's or the provider's copies; their retention terms apply separately. Real patient audio stays out until the founders define the data-handling arrangement.

Measured evaluation, once keys exist: record the 10 cases in `src/modules/assistant/eval-set.ts` (two readers, phone microphone, exam-room noise) as `E01.ogg` … `E10.ogg` in a folder outside the repository, then run `EVAL_DIR=<folder> npm run assistant:eval` and paste the table into the handoff.
