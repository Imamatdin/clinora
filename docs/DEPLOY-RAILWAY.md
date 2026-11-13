# Demo on Railway (task 027)

Throwaway **synthetic** demo for the founders. Never enter a real patient here. Production target stays Google Cloud
(`docs/DEPLOY.md`). Railway's `railway.json` is retired (new services cannot use it; existing files stop being read on
2026-12-01), so the settings below live on the service, not in the repository.

## Set up from nothing (one screen)

1. railway.com → **New project → Deploy from GitHub repo** → `Imamatdin/clinora`, branch `main`.
   Service → Settings → **Regions: EU West (Amsterdam)** (`europe-west4-drams3a`). Settings → Source:
   turn on **Wait for CI** so only commits with green checks deploy.
2. Canvas → **+ Create → Database → PostgreSQL**. Its Variables → set `POSTGRES_DB` = `clinora_staging` before the
   first start if offered; Settings → Region: **EU West**. (If it already started with `railway`, nothing to do: the
   pre-deploy step creates `clinora_staging` itself.)
3. App service → Settings → Deploy:
   - Start command: `/nodejs/bin/node dist/server/server/railway-start.js`
   - Pre-deploy command: `/nodejs/bin/node dist/server/server/railway-predeploy.js` (timeout 600 s)
   - Healthcheck path: `/readyz`, timeout 120 s. Restart policy: on failure, 5 retries.
   The image is distroless (no shell): commands must start with `/nodejs/bin/node`, no `&&`, no `$VAR`.
4. App service → Settings → Networking → **Generate domain**, port `8080`.
5. App service → Variables → **Raw editor**, paste exactly (the `${{…}}` parts are Railway references, not secrets):
   ```
   NODE_ENV=production
   APP_ENV=staging
   PORT=8080
   APP_ORIGIN=https://${{RAILWAY_PUBLIC_DOMAIN}}
   COOKIE_SECURE=true
   TRUST_PROXY_HOPS=1
   ASSISTANT_SIMULATION=true
   ALLOW_SYNTHETIC_DEMO=true
   DEMO_ACTION=seed
   CLINORA_APP_PASSWORD=${{secret(40, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")}}
   DATABASE_URL=postgresql://${{Postgres.PGUSER}}:${{Postgres.POSTGRES_PASSWORD}}@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/clinora_staging
   APP_DATABASE_URL=postgresql://clinora_app:${{CLINORA_APP_PASSWORD}}@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/clinora_staging
   ```
6. **+ New Variable** `DEMO_PASSWORD` = a password you choose (12+ characters, letters and digits) → ⋯ → **Seal**.
   Never commit, paste in chat or log it. Click **Deploy**.
7. Deploy logs show `Database created` (first time), `Migrations applied`, `Synthetic clinic seeded`, then `Clinora started`.
8. Open the domain, sign in as `demo.ceo` with `DEMO_PASSWORD`. Other logins: `demo.admin`, `demo.registrar`,
   `demo.doctor` (`demo.doctor2`…`demo.doctor10`), `demo.lab`, `demo.cashier`, `demo.inpatient`, `demo.pharmacy`.
9. From a laptop with the repository: `npm ci && npx playwright install chromium`, then
   `read -rs DEMO_PASSWORD && export DEMO_PASSWORD && npm run smoke:deploy -- https://<domain>`. All lines must say PASS.

Variables Telegram (`TELEGRAM_*`) and real assistant keys (`AISHA_API_KEY`, `VERTEX_*`) must stay unset: the start
step refuses them. The assistant runs labelled "simulated".

## What runs where

| Step | Connects as | Does |
| --- | --- | --- |
| Pre-deploy (`railway-predeploy.js`) | `DATABASE_URL`, Railway's Postgres admin (schema owner) | creates `clinora_staging` if missing; migrations (one transaction per file); creates/updates `clinora_app` with DML only and the password from `APP_DATABASE_URL`; seeds when asked. Fails = deploy abandoned, previous one keeps serving |
| Web (`railway-start.js`) | `APP_DATABASE_URL`, `clinora_app` | checks every variable and names each problem, then replaces itself with `main.js` **without** `DATABASE_URL` (owner), `DEMO_PASSWORD` or `CLINORA_APP_PASSWORD` in its environment |

Weaker than Google Cloud: Railway gives every process of a service the same variables, so the owner credential exists
in the pre-deploy container and in the start wrapper for a moment. The running app never has it.

## Fresh demo day / seed again

- Seed is idempotent: `DEMO_ACTION=seed` seeds only when the database has no clinic; leaving it set is harmless.
- Reset to a fresh synthetic day: set `DEMO_ACTION=reset-YYYY-MM-DD` with **today's date in Tashkent** and deploy. It
  wipes everything in `clinora_staging` and reseeds. A date other than today does nothing (logged); a second deploy the
  same day does not wipe again. Set it back to `seed` afterwards.
- Both refuse unless `APP_ENV=staging`, `ALLOW_SYNTHETIC_DEMO=true` and the database is `clinora_staging`.

## Later: `next.clinoraa.uz`

App service → Settings → Networking → **Custom domain** `next.clinoraa.uz`, port 8080. Railway shows the records; at
the `clinoraa.uz` registrar add exactly what it shows, normally:

| Name | Type | Value |
| --- | --- | --- |
| `next` | `CNAME` | `<something>.up.railway.app` (as shown by Railway) |
| `_railway-verify.next` | `TXT` | as shown by Railway, if asked |

Then set `APP_ORIGIN=https://next.clinoraa.uz` (sign-in checks the origin, so only that host works afterwards) and
re-run the smoke script against it. Change no other `clinoraa.uz` record. Google Cloud later uses the same name
(`docs/DEPLOY.md`); remove the Railway domain first.

## Tear down

Project → Settings → **Danger → Delete project**. This deletes the app, the database and its volume (all synthetic).
Then remove the `next` CNAME at the registrar if it was added, and revoke the Railway connector at claude.ai if used.
