# Run and demonstrate the notebook

Task 002. The commands are for an explicitly chosen development/remote machine.
The agent must not start Docker, PostgreSQL, builds or browser tests on Imamatdin's
limited-RAM computer without a new instruction. The delivered CI runs them remotely.

## Reproducible development setup

Use Node 22.17.1, npm 11.12.1 and PostgreSQL 17.9. Copy `.env.example` to an ignored
`.env.local`, choose your own database password, set POSTGRES_PASSWORD and the same
URL-encoded password in DATABASE_URL. No actual credentials are included in source.

```sh
npm ci
docker compose --env-file .env.local up -d --wait
node --env-file=.env.local --import tsx scripts/database.mjs migrate
node --env-file=.env.local --import tsx scripts/database.mjs migrate
```

The named volume retains local PostgreSQL records across server/container restarts.
Do not use `down -v` against a database you need. Migrations never drop/reset a
database. Runtime does not automatically apply migrations during HTTP startup.

Provision an initial owner explicitly. Add BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD,
BOOTSTRAP_NAME and BOOTSTRAP_CLINIC to your private environment file, using a password
you choose (12–128 characters). Set BOOTSTRAP_CLINICAL=true only when deliberately
granting that owner clinical access. No credential is printed by provisioning.

```sh
node --env-file=.env.local --import tsx scripts/database.mjs bootstrap
npm run build
node --env-file=.env.local dist/server/server/main.js
```

Open http://127.0.0.1:3001 and sign in with the credentials you supplied. For Vite
development use API port 3001, APP_ORIGIN=http://127.0.0.1:5173, then run the Node
API and `npm run dev` separately; the proxy preserves the browser Origin. Cookies
and CSRF remain required. For HTTPS production, NODE_ENV=production requires a DB,
HTTPS APP_ORIGIN and COOKIE_SECURE=true; hosting/proxy configuration is not delivered.

## Optional synthetic demonstration

On an empty local/test database, supply DEMO_EMAIL and DEMO_PASSWORD privately and
set ALLOW_SYNTHETIC_DEMO=true. The demo script provisions an explicit clinical
owner, a fictional patient and two empty date-only encounters. It does not assert
professional verification and refuses production/non-local/non-demo database names.

```sh
node --env-file=.env.local --import tsx scripts/demo.mjs
```

No demo role switch or default password exists. Running setup again with the same
account fails rather than overwriting an existing account or patient data.

## Doctor invitation and walkthrough

1. Sign in as the explicitly provisioned owner. Expand **Invite a clinician**, enter
   the intended email and manually deliver the private 48-hour link. No message is sent.
2. The clinician creates an account with that email, signs in and accepts the token.
   Professional credentials remain unverified. With no invitation, the account is pending.
3. Select a clinic. Create a clearly fictional patient with optional birth date and
   clinic medical-record number. Repeated names are allowed; stable IDs remain distinct.
4. Create an encounter: actual visit date, date precision, timezone, location and
   specialty. Do not invent an exact time for a date-only or unknown visit.
5. Enter the structured note; leave unavailable examination fields empty. Save the
   draft and wait for the server's saved revision. It remains visibly unapproved.
6. Reload/restart the same app/database and reopen the patient and dated visit. In
   a second tab, edit the same base revision: one save succeeds; the other retains
   text and offers comparison/resolution. An unassigned doctor cannot open the chart.

## Verification

Create a separate PostgreSQL database named **clinora_test** on loopback, owned by
the dedicated test user, and explicitly set TEST_DATABASE_URL. Tests create only
validated random `clinora_test_<hex>` schemas, then remove only their own schema.
They reject other database names/hosts and do not skip missing DB checks.

```sh
npm ci
npx playwright install --with-deps chromium
npm run check
node --import tsx scripts/check-provision.mjs
```

`check` includes strict typecheck, existing pure tests, real PostgreSQL/HTTP tests,
both builds, compiled-process smoke and Chromium UI tests. Unit tests alone are
`npm run test:unit`; they are not complete task-002 verification. CI's Linux job
runs the full sequence with its own PostgreSQL service, while the separately named
Windows compatibility job checks type/unit/build/smoke without claiming DB coverage.
