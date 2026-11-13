# Task 027: demo deploy on Railway

Assigned to: Claude Code (builder). Review: Codex. Planner: 13 November 2026. Decision by Iko: a throwaway demo on Railway for the founders now; Google Cloud stays the production target (`docs/DEPLOY.md`) once their credits arrive.
Base: `main`. Branch: `task-027-railway`. No migration. Synthetic data only; this environment never receives real patients.

Iko owns the Railway account and does every step that needs it. You write the configuration and a click list he can follow on his phone or laptop, and make the image start cleanly on Railway.

1. **Config as code:** `railway.json` building the existing `Dockerfile`. Pre-deploy runs the migrator (`dist/server/server/migrate-cli.js`); note the image is distroless (no shell, node at `/nodejs/bin/node`), so confirm the exact command form Railway accepts from its current docs. Health check on `/readyz`. Auto-deploy on every push to `main`.
2. **Database:** Railway Postgres in the same project and region (EU West, the closest Railway region to Tashkent; confirm the region list). The demo guard only seeds a database named `clinora_staging` with `APP_ENV=staging`: create that database rather than loosening the guard. Keep task 024's role split: migrations as the owner role, the app on `APP_DATABASE_URL` as `clinora_app`. Write down the exact variable references (`${{Postgres.…}}`) to paste.
3. **Environment:** `NODE_ENV=production`, `APP_ENV=staging`, `APP_ORIGIN` = the Railway HTTPS domain, `COOKIE_SECURE=true`, `TRUST_PROXY_HOPS` set for Railway's proxy (verify the hop count), `ALLOW_SYNTHETIC_DEMO=true`, `DEMO_PASSWORD` chosen by Iko (never committed or logged), assistant providers in simulation so the doctor assistant demo works with its "simulated" banner. Telegram off. List every variable the server reads at startup and fail fast with a clear message if one is missing.
4. **Synthetic clinic:** one way to seed the demo clinic (`demo-seed.js`) once, and to reset it to a fresh demo day later. It must refuse to run twice by accident or against any other database.
5. **Click list:** `docs/DEPLOY-RAILWAY.md`, one screen, numbered: create project from the GitHub repo, add Postgres, create `clinora_staging`, paste variables, generate the domain, seed, sign in as `demo.ceo`. Plus: how to point `next.clinoraa.uz` at it later (the CNAME record the founders add), and how to tear it all down.
6. **Smoke check:** a script that takes the public URL and checks `/readyz`, the security headers, and that each demo role can sign in and reach its home screen. Iko runs it after the first deploy.

Acceptance: `railway.json` and the image start locally in production mode against a `clinora_staging` database with the same variables; CI green; the smoke script passes locally. Handoff at most 40 lines, ending with the exact list of things Iko must click and paste.
