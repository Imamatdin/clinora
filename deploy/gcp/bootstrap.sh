#!/usr/bin/env bash
# One-time setup of the Clinora STAGING environment in Google Cloud. Run by a project owner
# (a founder) from Cloud Shell or a machine with gcloud signed in. Safe to re-run: existing
# resources are left as they are. Prints no secret values.
#
# Required variables (no defaults on purpose):
#   PROJECT_ID      Google Cloud project id (founders' startup-credits project)
#   REGION          Measured lowest-latency region from Tashkent (docs/DEPLOY.md, "Region")
#   GITHUB_REPO     owner/name of the repository, e.g. Imamatdin/clinora
#   GITHUB_REPO_ID  numeric repository id (GitHub: Settings is not needed; see docs/DEPLOY.md)
# Optional:
#   DEPLOYER_HUMAN  Google account of a teammate who may deploy and read logs (e.g. Iko), user:x@y
set -euo pipefail
: "${PROJECT_ID:?}" "${REGION:?}" "${GITHUB_REPO:?}" "${GITHUB_REPO_ID:?}"
[[ "$GITHUB_REPO_ID" =~ ^[0-9]+$ ]] || { echo "GITHUB_REPO_ID must be numeric" >&2; exit 1; }

SQL_INSTANCE=clinora-staging
DB_NAME=clinora_staging
DB_USER=clinora_app
DB_SECRET=clinora-staging-database-url
AR_REPO=clinora
RUNTIME_SA="clinora-staging-run@${PROJECT_ID}.iam.gserviceaccount.com"
DEPLOY_SA="clinora-deployer@${PROJECT_ID}.iam.gserviceaccount.com"
POOL=github
PROVIDER=clinora-repo
g() { gcloud --project "$PROJECT_ID" --quiet "$@"; }
exists() { "$@" >/dev/null 2>&1; }

echo "1/8 APIs"
g services enable run.googleapis.com sqladmin.googleapis.com secretmanager.googleapis.com \
  artifactregistry.googleapis.com iamcredentials.googleapis.com sts.googleapis.com

echo "2/8 Artifact Registry"
exists g artifacts repositories describe "$AR_REPO" --location "$REGION" ||
  g artifacts repositories create "$AR_REPO" --location "$REGION" --repository-format docker
# Keep the 20 most recent images; older untagged layers are cleaned automatically.
cat > /tmp/clinora-ar-cleanup.json <<'JSON'
[{"name":"keep-recent","action":{"type":"Keep"},"mostRecentVersions":{"keepCount":20}},
 {"name":"delete-old","action":{"type":"Delete"},"condition":{"olderThan":"2592000s"}}]
JSON
g artifacts repositories set-cleanup-policies "$AR_REPO" --location "$REGION" --policy /tmp/clinora-ar-cleanup.json --no-dry-run

echo "3/8 Cloud SQL (PostgreSQL 17, daily backups + point-in-time recovery, encrypted connections only)"
if ! exists g sql instances describe "$SQL_INSTANCE"; then
  # Backup window 21:00 UTC = 02:00 Tashkent. Enterprise edition allows the small shared-core tier.
  g sql instances create "$SQL_INSTANCE" --database-version POSTGRES_17 --edition enterprise \
    --tier db-g1-small --region "$REGION" --availability-type zonal --storage-auto-increase \
    --backup-start-time 21:00 --enable-point-in-time-recovery --retained-backups-count 14 \
    --ssl-mode ENCRYPTED_ONLY --deletion-protection
fi
exists g sql databases describe "$DB_NAME" --instance "$SQL_INSTANCE" || g sql databases create "$DB_NAME" --instance "$SQL_INSTANCE"
SQL_CONNECTION="$(g sql instances describe "$SQL_INSTANCE" --format 'value(connectionName)')"

echo "4/8 Database user and DATABASE_URL secret (generated here, never printed)"
if ! exists g secrets describe "$DB_SECRET"; then
  DB_PASSWORD="$(openssl rand -hex 32)"   # hex: URL-safe without escaping
  if exists g sql users describe "$DB_USER" --instance "$SQL_INSTANCE"; then
    g sql users set-password "$DB_USER" --instance "$SQL_INSTANCE" --password "$DB_PASSWORD" >/dev/null
  else
    g sql users create "$DB_USER" --instance "$SQL_INSTANCE" --password "$DB_PASSWORD" >/dev/null
  fi
  g secrets create "$DB_SECRET" --replication-policy automatic
  printf 'postgresql://%s:%s@/%s?host=/cloudsql/%s' "$DB_USER" "$DB_PASSWORD" "$DB_NAME" "$SQL_CONNECTION" |
    g secrets versions add "$DB_SECRET" --data-file=- >/dev/null
  unset DB_PASSWORD
fi

echo "5/8 Runtime identity: Cloud SQL client + read of its own secret only"
exists g iam service-accounts describe "$RUNTIME_SA" ||
  g iam service-accounts create clinora-staging-run --display-name "Clinora staging runtime"
g projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:$RUNTIME_SA" --role roles/cloudsql.client --condition None >/dev/null
g secrets add-iam-policy-binding "$DB_SECRET" --member "serviceAccount:$RUNTIME_SA" --role roles/secretmanager.secretAccessor >/dev/null

echo "6/8 Deploy identity for GitHub Actions (no JSON key is ever created)"
exists g iam service-accounts describe "$DEPLOY_SA" ||
  g iam service-accounts create clinora-deployer --display-name "Clinora GitHub deployer"
g projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:$DEPLOY_SA" --role roles/run.developer --condition None >/dev/null
g iam service-accounts add-iam-policy-binding "$RUNTIME_SA" --member "serviceAccount:$DEPLOY_SA" --role roles/iam.serviceAccountUser >/dev/null
g artifacts repositories add-iam-policy-binding "$AR_REPO" --location "$REGION" --member "serviceAccount:$DEPLOY_SA" --role roles/artifactregistry.writer >/dev/null

echo "7/8 Workload Identity Federation: only main of this repository may impersonate the deployer"
exists g iam workload-identity-pools describe "$POOL" --location global ||
  g iam workload-identity-pools create "$POOL" --location global --display-name "GitHub Actions"
exists g iam workload-identity-pools providers describe "$PROVIDER" --location global --workload-identity-pool "$POOL" ||
  g iam workload-identity-pools providers create-oidc "$PROVIDER" --location global --workload-identity-pool "$POOL" \
    --issuer-uri https://token.actions.githubusercontent.com \
    --attribute-mapping "google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.ref=assertion.ref" \
    --attribute-condition "assertion.repository_id=='${GITHUB_REPO_ID}' && assertion.ref=='refs/heads/main'"
PROJECT_NUMBER="$(g projects describe "$PROJECT_ID" --format 'value(projectNumber)')"
g iam service-accounts add-iam-policy-binding "$DEPLOY_SA" --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/attribute.repository_id/${GITHUB_REPO_ID}" >/dev/null

echo "8/8 Optional teammate deploy access (founders keep project ownership)"
if [[ -n "${DEPLOYER_HUMAN:-}" ]]; then
  g projects add-iam-policy-binding "$PROJECT_ID" --member "$DEPLOYER_HUMAN" --role roles/run.developer --condition None >/dev/null
  g projects add-iam-policy-binding "$PROJECT_ID" --member "$DEPLOYER_HUMAN" --role roles/logging.viewer --condition None >/dev/null
  g iam service-accounts add-iam-policy-binding "$RUNTIME_SA" --member "$DEPLOYER_HUMAN" --role roles/iam.serviceAccountUser >/dev/null
fi

cat <<EOF

Done. Set these GitHub repository VARIABLES (Settings > Secrets and variables > Actions > Variables).
None of them is secret; the deploy workflow stays skipped until GCP_PROJECT_ID is set.
  GCP_PROJECT_ID   = ${PROJECT_ID}
  GCP_REGION       = ${REGION}
  GCP_WIF_PROVIDER = projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/providers/${PROVIDER}
  GCP_DEPLOY_SA    = ${DEPLOY_SA}
  GCP_RUNTIME_SA   = ${RUNTIME_SA}
  GCP_SQL_CONNECTION = ${SQL_CONNECTION}
Next: docs/DEPLOY.md "Domain" (verify clinoraa.uz, map next.clinoraa.uz, add the DNS record).
EOF
