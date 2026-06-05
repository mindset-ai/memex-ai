#!/bin/bash
set -euo pipefail

# One-time Workload Identity Federation setup for GitHub Actions CD
# (.github/workflows/deploy.yml). Run once per environment:
#
#   ENV=int  bash scripts/setup-github-deployer.sh
#   ENV=prod bash scripts/setup-github-deployer.sh
#
# Requires owner/IAM-admin on the target project (request the PAM grant or run
# as a project owner). Idempotent: every create is guarded by a describe.
#
# What it creates, and why:
#   - A workload identity pool + OIDC provider trusting GitHub's token issuer,
#     restricted to THIS repository (assertion.repository).
#   - A `github-deployer` service account holding the standing roles the deploy
#     scripts exercise. NOTE: this is a deliberate, recorded exception to the
#     humans-hold-no-standing-roles PAM posture (scripts/deploy-config.sh) —
#     a CI robot cannot interactively request a 2h PAM grant. Scope is bounded
#     by the branch condition below.
#   - An IAM binding allowing ONLY workflow runs from the env's deploy branch
#     (develop → int, main → prod) to impersonate that service account: the
#     provider maps attribute.repo_ref = repository + '@' + ref, and the
#     binding names the exact repo@branch principal.
#
# On success it prints the two values to store as GitHub *environment
# variables* (Settings → Environments → <env>):
#   GCP_WORKLOAD_IDENTITY_PROVIDER
#   GCP_DEPLOYER_SERVICE_ACCOUNT

REPO="mindset-ai/memex-ai"
POOL_ID="github"
PROVIDER_ID="memex-ai"
SA_NAME="github-deployer"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${REPO_ROOT}/scripts/deploy-config.sh" # validates ENV, loads GCP_PROJECT

case "$ENV" in
  int) DEPLOY_BRANCH="develop" ;;
  prod) DEPLOY_BRANCH="main" ;;
esac

SA_EMAIL="${SA_NAME}@${GCP_PROJECT}.iam.gserviceaccount.com"
PROJECT_NUMBER="$(gcloud projects describe "${GCP_PROJECT}" --format='value(projectNumber)')"
POOL_FULL="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}"

echo "── WIF setup: ENV=${ENV} project=${GCP_PROJECT} branch=${DEPLOY_BRANCH} ──"

# ── 1. Workload identity pool ─────────────────────────────────
if ! gcloud iam workload-identity-pools describe "${POOL_ID}" \
  --project "${GCP_PROJECT}" --location global >/dev/null 2>&1; then
  gcloud iam workload-identity-pools create "${POOL_ID}" \
    --project "${GCP_PROJECT}" --location global \
    --display-name "GitHub Actions"
fi

# ── 2. OIDC provider, locked to this repository ───────────────
# attribute.repo_ref concatenates repository and ref so a single IAM principal
# can pin BOTH (e.g. mindset-ai/memex-ai@refs/heads/main).
if ! gcloud iam workload-identity-pools providers describe "${PROVIDER_ID}" \
  --project "${GCP_PROJECT}" --location global \
  --workload-identity-pool "${POOL_ID}" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools providers create-oidc "${PROVIDER_ID}" \
    --project "${GCP_PROJECT}" --location global \
    --workload-identity-pool "${POOL_ID}" \
    --display-name "memex-ai repo" \
    --issuer-uri "https://token.actions.githubusercontent.com" \
    --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repo_ref=assertion.repository+'@'+assertion.ref" \
    --attribute-condition "assertion.repository=='${REPO}'"
fi

# ── 3. Deployer service account ───────────────────────────────
if ! gcloud iam service-accounts describe "${SA_EMAIL}" \
  --project "${GCP_PROJECT}" >/dev/null 2>&1; then
  gcloud iam service-accounts create "${SA_NAME}" \
    --project "${GCP_PROJECT}" \
    --display-name "GitHub Actions deployer (CD from ${DEPLOY_BRANCH})"
fi

# ── 4. Standing deploy roles ──────────────────────────────────
# Mirrors what the deploy scripts actually touch:
#   run.admin                  gcloud run deploy (new revision + traffic)
#   iam.serviceAccountUser     attach the runtime SA to the revision
#   cloudbuild.builds.editor   gcloud builds submit (server image)
#   storage.admin              build staging bucket + admin GCS rsync
#   artifactregistry.writer    push the built image
#   cloudsql.client            cloud-sql-proxy for migrations
#   secretmanager.secretAccessor  DB_PASS fetch in deploy.<env>.env
#   secretmanager.viewer       the pre-flight `gcloud secrets describe` loop
#   compute.loadBalancerAdmin  admin CDN cache invalidation
for ROLE in \
  roles/run.admin \
  roles/iam.serviceAccountUser \
  roles/cloudbuild.builds.editor \
  roles/storage.admin \
  roles/artifactregistry.writer \
  roles/cloudsql.client \
  roles/secretmanager.secretAccessor \
  roles/secretmanager.viewer \
  roles/compute.loadBalancerAdmin; do
  gcloud projects add-iam-policy-binding "${GCP_PROJECT}" \
    --member "serviceAccount:${SA_EMAIL}" --role "${ROLE}" \
    --condition None --quiet >/dev/null
  echo "  ✓ ${ROLE}"
done

# ── 5. Allow ONLY this repo@branch to impersonate the SA ──────
gcloud iam service-accounts add-iam-policy-binding "${SA_EMAIL}" \
  --project "${GCP_PROJECT}" \
  --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/${POOL_FULL}/attribute.repo_ref/${REPO}@refs/heads/${DEPLOY_BRANCH}" \
  --quiet >/dev/null
echo "  ✓ workloadIdentityUser for ${REPO}@refs/heads/${DEPLOY_BRANCH}"

echo ""
echo "── Done. Store these as GitHub ENVIRONMENT variables on '${ENV}': ──"
echo "GCP_WORKLOAD_IDENTITY_PROVIDER=${POOL_FULL}/providers/${PROVIDER_ID}"
echo "GCP_DEPLOYER_SERVICE_ACCOUNT=${SA_EMAIL}"
