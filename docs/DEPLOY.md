# Deployment: staging at next.clinoraa.uz

Written 12 November 2026 (task 006). Status: deploy package complete and verified locally;
**not yet live**. The Google Cloud project and the founders' credits were not available to the
builder, so steps marked **[founder]** below have not been run against a real project.

## Architecture

```
GitHub push to main
  └─ "Clinora checks" (typecheck, unit, PostgreSQL integration, build, smoke, browser)  ── fail → nothing deploys
       └─ "Deploy staging" (.github/workflows/deploy.yml), keyless auth via Workload Identity Federation
            1. gitleaks over repository history          ── leak → stop
            2. docker build (Dockerfile)
            3. trivy secret scan of every image layer     ── leak → stop
            4. push to Artifact Registry  <region>-docker.pkg.dev/<project>/clinora/clinora:<commit>
            5. Cloud Run job clinora-staging-migrate (schema owner)  ── failure → stop, previous revision keeps serving
                 one transaction per file, lock_timeout 5 s with retries, per-file statement timeout
            6. gcloud run services replace deploy/gcp/service.yaml
                 new revision starts → startup probe GET /readyz (DB reachable + all shipped migrations applied)
                 probe fails → revision never gets traffic, previous revision keeps serving
            7. smoke test https://next.clinoraa.uz (readyz, healthz, HSTS, CSP, /.env = 404)
                 failure → traffic returned to the previous revision automatically

Cloud Run service clinora-staging  (distroless Node 22, uid nonroot, 1 vCPU / 512 MiB, 1–2 instances,
  CPU always allocated, request timeout 300 s for the streamed full export)
  └─ Cloud SQL PostgreSQL 17 clinora-staging (db-g1-small, zonal, daily backup 02:00 Tashkent,
     point-in-time recovery, 14 backups kept, encrypted connections only, deletion protection)
     connected through the built-in Cloud SQL socket /cloudsql/<connection-name>
Secret Manager: clinora-staging-database-url (app login, DML only), read by the runtime and migrate identities
                clinora-staging-migrator-database-url (schema owner), read only by the migrate identity
```

The image is host-agnostic: any container host works with `DATABASE_URL`, `APP_ENV`, `APP_ORIGIN`
(https), `COOKIE_SECURE=true` and, behind exactly one appending proxy, `TRUST_PROXY_HOPS=1`.

| Path | Meaning |
| --- | --- |
| `/healthz` | Process is up. No database call (liveness; a database outage does not cause restart loops). |
| `/readyz` | 200 only if the database answers and every migration in this image is applied with the same checksum. Extra newer migrations are allowed so the previous revision keeps serving after a newer deploy migrated. 503 reasons: `no_database`, `database_unreachable`, `migrations_pending`. |

Identities (least privilege; no JSON keys anywhere):

| Identity | Roles | Why |
| --- | --- | --- |
| `clinora-staging-run` (runtime) | Cloud SQL Client (project); Secret Accessor on `clinora-staging-database-url` only | Connect as the DML-only app role. It cannot read the owner credential |
| `clinora-staging-migrate` (migrate job, task 024) | Cloud SQL Client (project); Secret Accessor on both database secrets | Run DDL as `clinora_migrator`; create or update the `clinora_app` role and its password from the app secret |
| `clinora-deployer` (GitHub Actions via WIF) | Cloud Run Developer; Service Account User on the runtime and migrate identities only; Artifact Registry Writer on the `clinora` repository only | Deploy revisions/jobs, run them as the runtime identity, push images. It never connects to the database or reads secrets, so it does not get Cloud SQL Client or Secret Accessor (narrower than the brief; the two extra roles are required to push and to deploy as the runtime identity) |
| WIF provider `github/clinora-repo` | Accepts only tokens whose `repository_id` is this repository and `ref` is `refs/heads/main` | A fork, another repository or another branch cannot impersonate the deployer |
| Teammate (e.g. Iko), optional | Cloud Run Developer, Logs Viewer, Service Account User on runtime identity | Can deploy and read logs; founders keep project Owner |

## Database roles and migrations (task 024)

| Role | Created by | Can | Cannot |
| --- | --- | --- | --- |
| `clinora_migrator` | `bootstrap.sh` (`gcloud sql users create`) | Own and change the schema; run migrations | Is never given to the running app |
| `clinora_app` | the migrate job, in SQL (`src/server/database.ts` `grantApplication`) | `SELECT, INSERT, UPDATE, DELETE` on tables, sequences | Own anything; `CREATE` in the schema; `TRUNCATE`; `ALTER`/`DROP` tables; drop or disable triggers (append-only, closed day); write `schema_migrations`; `CREATEROLE`/`CREATEDB` |

`clinora_app` is deliberately **not** created with `gcloud sql users create`: Cloud SQL makes such users members
of `cloudsqlsuperuser` (CREATEROLE, CREATEDB). The migrate job creates it with `NOCREATEROLE NOCREATEDB`, sets
its password as a SCRAM verifier (the plain password never appears in SQL text or server logs), revokes any role
membership and re-applies the grants on every run. Tested in `tests/integration/migrations.test.ts`.

Migration runner (`migrate()`): a session advisory lock (one runner at a time); each file in its own transaction;
`lock_timeout` 5 s, so an `ALTER` waiting behind a long read gives up instead of queueing every request behind it,
then retries with doubling back-off (6 attempts); statement timeout 15 min by default, or per file with a first-lines
comment `-- clinora:statement_timeout=30min` (never the app's 10 s cap); the job's task timeout is 30 min. A failed
file rolls back alone; files before it stay applied and the job exits non-zero, so the deploy stops and the previous
revision keeps serving. Rules for authors: expand, then contract (add columns/tables; drop in a later release), build
large indexes with a separate `CREATE INDEX CONCURRENTLY` file only after testing (it cannot run in a transaction,
so it needs a runner change first), and backfill in batches.

### Role split on an existing database [founder, once]

Only if `bootstrap.sh` printed the NOTE (an earlier bootstrap created `clinora_app` as the table owner). Before the
next deploy, from Cloud Shell, as the `postgres` user:
```sql
REASSIGN OWNED BY clinora_app TO clinora_migrator;   -- tables, functions, triggers move to the owner
REVOKE cloudsqlsuperuser FROM clinora_app;
```
Then merge to `main`; the migrate job applies the DML-only grants. Check: `\du clinora_app` shows no attributes
and no memberships.

## Background work and instance settings (task 024)

Assistant transcription and drafting run inside the web process after the HTTP response. With request-based
billing Cloud Run throttles CPU outside requests and those jobs stall, so the service runs with **CPU always
allocated** (`run.googleapis.com/cpu-throttling: 'false'`, instance-based billing) and **one minimum instance**,
which also removes the cold start at opening time. Cost at Tier 1 list price (Nov 2026, us-central1; check
<https://cloud.google.com/run/pricing> for the chosen region): 1 vCPU x 2.63 M s x USD 0.000018 + 0.5 GiB x 2.63 M s
x USD 0.000002, minus the instance free tier (240,000 vCPU-s, 450,000 GiB-s), is **about USD 45 per month** for the
always-on instance; the second instance costs the same rate while it runs. Cloud Tasks was the alternative: cheaper
at idle, but it needs a queue, an authenticated task endpoint and retry/idempotency work for every job type. Revisit
it when jobs need to survive instance restarts or more than two instances. Jobs that are running while an instance
is replaced (deploy, scale-in) are lost and must be resumable from their stored state; that is the existing lease
design of the assistant captures, not a new guarantee.

The request timeout is 300 s because the full clinic export is streamed: two synthetic years (370k charge lines)
produced 57 MB in about 22 s locally. Other routes keep the app's own limits.

## Host security settings (verified locally in the container; re-verify on the real host)

- Cookies: `clinora_session=…; HttpOnly; Path=/; SameSite=Strict; Max-Age=28800; Secure`, no `Domain`
  attribute, so the cookie belongs to `next.clinoraa.uz` only and never reaches other `clinoraa.uz` hosts.
- HSTS `max-age=31536000` when cookies are secure. Deliberately no `includeSubDomains` (other
  `clinoraa.uz` hosts are not ours to force) and no `preload`.
- Client IP: `TRUST_PROXY_HOPS=1` reads only the **last** `X-Forwarded-For` entry, which Google's front
  end appends. Entries a caller supplies to its left are never read. **Verify on the real host**: send
  `curl -H 'X-Forwarded-For: 6.6.6.6' https://next.clinoraa.uz/api/auth/login …` 41 times with wrong
  passwords; the 41st must return 429 and a request from a different network must still get 401. If
  Cloud Run appends more than one address, set `TRUST_PROXY_HOPS` accordingly.
- Limits: JSON bodies 100 kB (app), request timeout 15 s (app), 30 s (Cloud Run). No upload endpoints exist yet.
- Logs: one JSON line per request with `requestId, method, route, status, durationMs` only. Route
  identifiers (UUIDs, numbers) are replaced by `:id`/`:n`; no query strings, bodies, cookies, IPs or
  headers. Migration errors log only the PostgreSQL error code.
- Session secret: not needed. Sessions are random 256-bit tokens stored as SHA-256 digests.
- Telegram (task 004): bot token and webhook secret live in Secret Manager and are injected only when
  the repository variable `GCP_TELEGRAM_BOT_USERNAME` is set (all three or none, as the app requires).
  See "Telegram" below. AI provider keys will follow the same pattern when that task lands.

## Region

**Not yet measured.** The builder runs in a US data centre and gcping.com is blocked there, so a
measurement from here would be meaningless. **[founder]** From a normal Tashkent connection open
<https://gcping.com>, wait for three rounds, and record the top five regions and medians below.

Decision rule: prefer the lowest-latency region where Cloud Run **domain mapping** is available
(per Google's locations page at time of writing: asia-east1, asia-northeast1, asia-southeast1,
europe-north1, europe-west1, europe-west4, us-central1, us-east1, us-east4, us-west1; check the live page).
If a region without domain mapping (for example europe-west3, europe-central2, me-central1) is more
than ~20 ms faster, use it with a global external Application Load Balancer and a serverless NEG
instead (about USD 18+/month extra, A/AAAA records instead of a CNAME). Do not use Firebase Hosting in
front: it forwards only a cookie named `__session`, which would break sign-in.

| Region | Median from Tashkent | Domain mapping |
| --- | --- | --- |
| (to fill) | | |

## First-time setup [founder]

1. Project with credits and billing linked; you are Owner. Open Cloud Shell.
2. Repository id: `curl -s https://api.github.com/repos/<owner>/clinora | grep '"id"' | head -1`
   (needs a token for a private repository; or ask the builder).
3. Run, from a checkout of the repository:
   ```bash
   PROJECT_ID=<id> REGION=<measured> GITHUB_REPO=<owner>/clinora GITHUB_REPO_ID=<number> DEPLOYER_HUMAN=user:<iko@…> bash deploy/gcp/bootstrap.sh
   ```
4. Add the six repository **variables** it prints (plus `GCP_TELEGRAM_BOT_USERNAME` later, see Telegram) (GitHub → Settings → Secrets and variables →
   Actions → Variables). Create the GitHub environment `staging` (Settings → Environments); optionally
   restrict it to the `main` branch.
5. Merge anything to `main` (or re-run the latest "Clinora checks" run on main). The first deploy
   creates the service.
6. Make the service publicly reachable (the app does its own authentication). The deployer cannot
   change IAM, so a founder runs once:
   ```bash
   gcloud run services add-iam-policy-binding clinora-staging --region <REGION> --member allUsers --role roles/run.invoker
   ```
   If an organization policy (domain-restricted sharing) refuses `allUsers`, allow it for this project.
7. Seed synthetic data (staging only; the seed refuses `APP_ENV=production`):
   ```bash
   gcloud secrets create clinora-staging-demo-password --replication-policy automatic
   openssl rand -base64 18 | gcloud secrets versions add clinora-staging-demo-password --data-file=-
   gcloud secrets add-iam-policy-binding clinora-staging-demo-password --member serviceAccount:clinora-staging-run@<PROJECT_ID>.iam.gserviceaccount.com --role roles/secretmanager.secretAccessor
   gcloud run jobs deploy clinora-staging-seed --region <REGION> --image <latest image from Artifact Registry> --args dist/server/server/demo-seed.js --service-account clinora-staging-run@<PROJECT_ID>.iam.gserviceaccount.com --set-cloudsql-instances <SQL_CONNECTION> --set-secrets DATABASE_URL=clinora-staging-database-url:latest,DEMO_PASSWORD=clinora-staging-demo-password:latest --set-env-vars APP_ENV=staging,ALLOW_SYNTHETIC_DEMO=true --max-retries 0
   gcloud run jobs execute clinora-staging-seed --region <REGION> --wait
   ```
   Logins: `demo.ceo`, `demo.admin`, `demo.registrar`, `demo.doctor`, `demo.lab`, `demo.cashier`,
   `demo.inpatient`. Read the password with `gcloud secrets versions access latest --secret clinora-staging-demo-password`.
   Running the seed twice creates a second synthetic clinic and fails on duplicate logins; that is intended.

## Telegram [founder, optional]

1. Create the bot with @BotFather and keep the token private.
2. Store both secrets (values typed or generated in Cloud Shell, never pasted into chat or GitHub):
   ```bash
   read -rs TOKEN && printf '%s' "$TOKEN" | gcloud secrets create clinora-staging-telegram-bot-token --replication-policy automatic --data-file=- && unset TOKEN
   openssl rand -hex 32 | tr -d '\n' | gcloud secrets create clinora-staging-telegram-webhook-secret --replication-policy automatic --data-file=-
   for s in clinora-staging-telegram-bot-token clinora-staging-telegram-webhook-secret; do
     gcloud secrets add-iam-policy-binding "$s" --member serviceAccount:clinora-staging-run@<PROJECT_ID>.iam.gserviceaccount.com --role roles/secretmanager.secretAccessor
   done
   ```
3. Set the repository variable `GCP_TELEGRAM_BOT_USERNAME` (the bot's username, not secret). The next
   deploy injects all three settings.
4. Once `https://next.clinoraa.uz` answers, register the webhook and menu button from Cloud Shell in a checkout:
   ```bash
   npm ci
   TELEGRAM_BOT_TOKEN="$(gcloud secrets versions access latest --secret clinora-staging-telegram-bot-token)" \
   TELEGRAM_WEBHOOK_SECRET="$(gcloud secrets versions access latest --secret clinora-staging-telegram-webhook-secret)" \
   TELEGRAM_BOT_USERNAME=<username> APP_ORIGIN=https://next.clinoraa.uz npm run telegram:setup
   ```
   It prints only PASS/FAIL. Rotating the webhook secret means adding a new version, redeploying, then re-running this step.

## Domain

1. Verify ownership of `clinoraa.uz` for your Google account: `gcloud domains verify clinoraa.uz`
   (opens Search Console; add the TXT record it shows at the registrar).
2. `gcloud beta run domain-mappings create --service clinora-staging --domain next.clinoraa.uz --region <REGION>`
3. At the `clinoraa.uz` registrar add exactly:

   | Name | Type | Value | TTL |
   | --- | --- | --- | --- |
   | `next` | `CNAME` | `ghs.googlehosted.com.` | 3600 |

   Do not change any other `clinoraa.uz` record. The managed certificate is issued after the record
   resolves (usually 15–60 minutes). Check with
   `gcloud beta run domain-mappings describe --domain next.clinoraa.uz --region <REGION>`.
   With the load-balancer option instead, the record is an `A` (and `AAAA`) record to the reserved IP.

## Operations

**Deploy:** merge to `main`. Watch GitHub → Actions → "Deploy staging".

**Roll back** to the previous revision (takes effect in seconds; time it the first time and record below):
```bash
gcloud run revisions list --service clinora-staging --region <REGION> --limit 5
gcloud run services update-traffic clinora-staging --region <REGION> --to-revisions <previous-revision>=100
```
The next merge to `main` moves traffic to the new revision again. Rolling back code does not roll back
migrations; migrations must stay backward-compatible with the previous release (add, never rename or
drop in the same release).

**Rotate the application password** (the migrate job sets the role's password from the secret):
```bash
NEW=$(openssl rand -hex 32)
printf 'postgresql://clinora_app:%s@/clinora_staging?host=/cloudsql/<SQL_CONNECTION>' "$NEW" | gcloud secrets versions add clinora-staging-database-url --data-file=-
unset NEW
gcloud run jobs execute clinora-staging-migrate --region <REGION> --wait   # ALTER ROLE clinora_app PASSWORD <new verifier>
gcloud run services update clinora-staging --region <REGION> --update-labels rotated=$(date +%Y%m%d)   # new revision reads the new secret version
```
Between the job and the new revision, new connections from the old revision fail (the old password no longer
works); run the two commands back to back, outside clinic hours. Existing pooled connections keep working until
they close. **Rotate the migrator password** with `gcloud sql users set-password clinora_migrator …` and a new
version of `clinora-staging-migrator-database-url`; the app is unaffected. Then
`gcloud secrets versions disable <old-version> --secret clinora-staging-database-url`.
Other secrets: add a version, redeploy, disable the old version.

**Restore a backup into a scratch database** (never over the live instance during a test):
```bash
gcloud sql backups list --instance clinora-staging
gcloud sql instances clone clinora-staging clinora-restore-test --point-in-time "<UTC timestamp, e.g. 2026-11-20T08:00:00Z>"
gcloud sql connect clinora-restore-test --user postgres --database clinora_staging   # check: SELECT count(*) FROM accounts; SELECT name FROM schema_migrations;
gcloud sql instances delete clinora-restore-test
```
For a real recovery, restore into a new instance the same way, point the secret at it, redeploy.

**Updating base images:** bump the `node` and `distroless` digests in `Dockerfile` together, in their own pull request.

## Evidence still to record on the real host

| Check | Result |
| --- | --- |
| Merge to main is live without manual steps | not yet run |
| Failing migration blocks the deploy (push a deliberately broken migration on a throwaway branch merged to main, then revert) | not yet run |
| `/readyz` 503 with Cloud SQL stopped, old revision keeps serving | not yet run |
| Rollback timed | not yet run |
| Restore into scratch instance | not yet run |
| Role split: `\du clinora_app` shows no attributes or memberships; app cannot `DROP TRIGGER payments_append_only ON payments` | not yet run (tested in CI against PostgreSQL 17, not on Cloud SQL) |
| Minimum instance and CPU always allocated visible on the revision; first-month bill matches the estimate | not yet run |
| Spoofed `X-Forwarded-For` does not change the rate-limit key | not yet run |

## Production checklist (before the first real patient)

Nothing below is done. Each line needs a named owner and a recorded result (date, command, outcome) in this file.

1. **Real-data decision by the founders, in writing:** consent wording, where records may be stored (region, and
   whether a non-Uzbek region is acceptable under Uzbekistan's personal data law; get legal advice), retention and
   deletion, who may access production, breach notification. No real patient is entered before this exists.
2. **Separate environment:** its own Google Cloud project (preferred) or at least its own Cloud SQL instance,
   database, service, runtime and migrate identities. Staging data, demo seed jobs and staging secrets never touch it.
   `APP_ENV=production` (the demo seed refuses to run).
3. **Separate secrets:** production `*-database-url`, `*-migrator-database-url` and Telegram secrets generated in
   the production project; never copied from staging. Secret Accessor only for the identity that needs each one.
4. **Role split in place:** migrations as `clinora_migrator`, app as DML-only `clinora_app` (section above), verified
   on the real instance with `\du` and a failed `DROP TRIGGER` as the app user.
5. **Backups with a tested restore:** regional (high-availability) Cloud SQL, automated backups with point-in-time
   recovery, retention agreed with the founders (at least 30 days suggested). A restore into a scratch instance is
   performed and timed before go-live and then on a schedule (e.g. monthly), with row counts checked against the
   source. An untested backup does not count.
6. **Deploy path:** a separate WIF provider bound to a protected release branch or tag, a required reviewer on the
   `production` GitHub environment, same gates as staging (checks, secret scans, migrate, readiness, smoke, rollback).
7. **Operations:** alerting on 5xx rate, failed readiness probes, failed migrate job and Cloud SQL storage; minimum
   one instance (already in the template); the C9 gate (per-account login limiting, TLS, secure cookies, trusted
   proxy) re-verified on the real host.
8. **Load:** the task-024 load test (two synthetic years, 150 outpatients and 20 inpatient admissions a day) passes
   in CI; re-run it against a production-sized Cloud SQL tier before go-live, since CI uses a local container.
