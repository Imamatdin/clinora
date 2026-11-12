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
            5. Cloud Run job clinora-staging-migrate      ── failure → stop, previous revision keeps serving
            6. gcloud run services replace deploy/gcp/service.yaml
                 new revision starts → startup probe GET /readyz (DB reachable + all shipped migrations applied)
                 probe fails → revision never gets traffic, previous revision keeps serving
            7. smoke test https://next.clinoraa.uz (readyz, healthz, HSTS, CSP, /.env = 404)
                 failure → traffic returned to the previous revision automatically

Cloud Run service clinora-staging  (distroless Node 22, uid nonroot, 1 vCPU / 512 MiB, 0–2 instances)
  └─ Cloud SQL PostgreSQL 17 clinora-staging (db-g1-small, zonal, daily backup 02:00 Tashkent,
     point-in-time recovery, 14 backups kept, encrypted connections only, deletion protection)
     connected through the built-in Cloud SQL socket /cloudsql/<connection-name>
Secret Manager: clinora-staging-database-url (the whole DATABASE_URL), read only by the runtime identity
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
| `clinora-staging-run` (runtime, also runs migrations) | Cloud SQL Client (project); Secret Accessor on `clinora-staging-database-url` only | Connect to the database and read its own URL |
| `clinora-deployer` (GitHub Actions via WIF) | Cloud Run Developer; Service Account User on the runtime identity only; Artifact Registry Writer on the `clinora` repository only | Deploy revisions/jobs, run them as the runtime identity, push images. It never connects to the database or reads secrets, so it does not get Cloud SQL Client or Secret Accessor (narrower than the brief; the two extra roles are required to push and to deploy as the runtime identity) |
| WIF provider `github/clinora-repo` | Accepts only tokens whose `repository_id` is this repository and `ref` is `refs/heads/main` | A fork, another repository or another branch cannot impersonate the deployer |
| Teammate (e.g. Iko), optional | Cloud Run Developer, Logs Viewer, Service Account User on runtime identity | Can deploy and read logs; founders keep project Owner |

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

**Rotate the database password:**
```bash
NEW=$(openssl rand -hex 32)
gcloud sql users set-password clinora_app --instance clinora-staging --password "$NEW"
printf 'postgresql://clinora_app:%s@/clinora_staging?host=/cloudsql/<SQL_CONNECTION>' "$NEW" | gcloud secrets versions add clinora-staging-database-url --data-file=-
unset NEW
gcloud run services update clinora-staging --region <REGION> --update-labels rotated=$(date +%Y%m%d)   # new revision reads the new secret version
```
Existing connections keep working until they close; the new revision uses the new password. Then
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
| Spoofed `X-Forwarded-For` does not change the rate-limit key | not yet run |

## Creating production later

Founders decide real-data handling first (consent, where records may be stored, retention, who has
access). Then: a separate Google Cloud project (or at minimum a separate service, Cloud SQL instance,
secrets and runtime identity); `APP_ENV=production`; regional or high-availability Cloud SQL with
longer backup retention; a separate WIF provider bound to a protected release branch or tag with a
required reviewer on the `production` GitHub environment; no demo seed job; minimum one instance to
avoid cold starts at the clinic's opening hour; alerting on 5xx and failed probes; a restore test
before go-live and on a schedule; and a review of the C9 gate (per-account login limiting so a clinic
behind one public IP is never locked out).
