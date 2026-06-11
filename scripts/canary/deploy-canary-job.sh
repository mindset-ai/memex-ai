#!/usr/bin/env bash
# spec-243 dec-1: provision + deploy the canary as a Cloud Run Job + Cloud
# Scheduler in the Memex GCP project. Idempotent — safe to re-run; it creates
# what's missing and updates the Job image otherwise.
#
# One execution probes BOTH memex.ai and int.memex.ai (the probes are public
# HTTPS, so a single Job in one project monitors both). Cloud Scheduler fires
# it every 10 minutes — a dependable cron, unlike the GitHub Actions schedule
# this replaces.
#
# Prereqts: gcloud auth with rights in the target project; an active PAM grant
# if the project requires it. Secret VALUES are seeded separately (see the
# SECRETS section near the end) — this script creates the secret containers and
# wires them, but never hardcodes a secret.
#
# Usage: PROJECT=memex-ai-prod ./scripts/canary/deploy-canary-job.sh
set -euo pipefail

PROJECT="${PROJECT:-memex-ai-prod}"
REGION="${REGION:-us-east4}"
REPO="${PROJECT}"                                   # Artifact Registry repo name 'memex'
AR="us-east4-docker.pkg.dev/${PROJECT}/memex"
IMAGE="${AR}/memex-canary:latest"
JOB="memex-canary"
SCHED="memex-canary-10min"
SA="canary-job@${PROJECT}.iam.gserviceaccount.com"
SCHED_SA="canary-scheduler@${PROJECT}.iam.gserviceaccount.com"
BUCKET="${PROJECT}-canary-state"
# AC the hidden emission targets, and the canary Memex (same slug both envs).
AC_PROD="memex-ops/canary-tests/specs/spec-1/acs/ac-1"
AC_INT="memex-ops/canary-tests/specs/spec-1/acs/ac-1"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "▸ project=${PROJECT} region=${REGION}"

# ── Service accounts ────────────────────────────────────────────────────────
gcloud iam service-accounts describe "$SA" --project "$PROJECT" >/dev/null 2>&1 || \
  gcloud iam service-accounts create canary-job --project "$PROJECT" \
    --display-name "spec-243 canary Cloud Run Job"
gcloud iam service-accounts describe "$SCHED_SA" --project "$PROJECT" >/dev/null 2>&1 || \
  gcloud iam service-accounts create canary-scheduler --project "$PROJECT" \
    --display-name "spec-243 canary Cloud Scheduler invoker"

# ── State bucket (consecutive-failure status) ───────────────────────────────
gcloud storage buckets describe "gs://${BUCKET}" --project "$PROJECT" >/dev/null 2>&1 || \
  gcloud storage buckets create "gs://${BUCKET}" --project "$PROJECT" \
    --location "$REGION" --uniform-bucket-level-access
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" --project "$PROJECT" \
  --member "serviceAccount:${SA}" --role roles/storage.objectAdmin >/dev/null

# ── Secret containers (VALUES seeded separately — see SECRETS section) ───────
for S in canary-emit-key-prod canary-emit-key-int \
         canary-mcp-token-prod canary-mcp-token-int \
         slack-webhook-prod slack-webhook-int; do
  gcloud secrets describe "$S" --project "$PROJECT" >/dev/null 2>&1 || \
    gcloud secrets create "$S" --project "$PROJECT" --replication-policy automatic
  gcloud secrets add-iam-policy-binding "$S" --project "$PROJECT" \
    --member "serviceAccount:${SA}" --role roles/secretmanager.secretAccessor >/dev/null
done

# ── Build + push the image ──────────────────────────────────────────────────
echo "▸ building image ${IMAGE}"
gcloud builds submit "$REPO_ROOT" --project "$PROJECT" \
  --config /dev/stdin <<YAML
steps:
  - name: gcr.io/cloud-builders/docker
    args: ['build','-f','scripts/canary/Dockerfile.canary','-t','${IMAGE}','.']
images: ['${IMAGE}']
YAML

# ── Cloud Run Job ───────────────────────────────────────────────────────────
SECRETS="CANARY_EMIT_KEY_PROD=canary-emit-key-prod:latest"
SECRETS+=",CANARY_EMIT_KEY_INT=canary-emit-key-int:latest"
SECRETS+=",CANARY_MCP_TOKEN_PROD=canary-mcp-token-prod:latest"
SECRETS+=",CANARY_MCP_TOKEN_INT=canary-mcp-token-int:latest"
SECRETS+=",SLACK_WEBHOOK_PROD=slack-webhook-prod:latest"
SECRETS+=",SLACK_WEBHOOK_INT=slack-webhook-int:latest"
ENVVARS="CANARY_AC_UID_PROD=${AC_PROD},CANARY_AC_UID_INT=${AC_INT}"
ENVVARS+=",CANARY_STATE_BUCKET=${BUCKET},CANARY_VERBOSE=${CANARY_VERBOSE:-true}"

JOB_ACTION=update
gcloud run jobs describe "$JOB" --project "$PROJECT" --region "$REGION" >/dev/null 2>&1 || JOB_ACTION=create
echo "▸ ${JOB_ACTION} Cloud Run Job ${JOB}"
gcloud run jobs "$JOB_ACTION" "$JOB" --project "$PROJECT" --region "$REGION" \
  --image "$IMAGE" \
  --service-account "$SA" \
  --max-retries 1 --task-timeout 120s \
  --set-env-vars "$ENVVARS" \
  --set-secrets "$SECRETS"

# ── Cloud Scheduler → Job (every 10 min, off-round minutes to dodge load) ────
gcloud run jobs add-iam-policy-binding "$JOB" --project "$PROJECT" --region "$REGION" \
  --member "serviceAccount:${SCHED_SA}" --role roles/run.invoker >/dev/null
RUN_URI="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT}/jobs/${JOB}:run"
SCHED_ACTION=update
gcloud scheduler jobs describe "$SCHED" --project "$PROJECT" --location "$REGION" >/dev/null 2>&1 || SCHED_ACTION=create
echo "▸ ${SCHED_ACTION} Cloud Scheduler ${SCHED}"
gcloud scheduler jobs "$SCHED_ACTION" http "$SCHED" --project "$PROJECT" --location "$REGION" \
  --schedule "2,12,22,32,42,52 * * * *" \
  --uri "$RUN_URI" --http-method POST \
  --oauth-service-account-email "$SCHED_SA"

cat <<NOTE

✅ Infra applied. SECRETS — seed values once (raw secrets never go in this repo):
   printf '%s' "<value>" | gcloud secrets versions add canary-emit-key-prod  --project ${PROJECT} --data-file=-
   printf '%s' "<value>" | gcloud secrets versions add canary-emit-key-int   --project ${PROJECT} --data-file=-
   printf '%s' "<value>" | gcloud secrets versions add canary-mcp-token-prod --project ${PROJECT} --data-file=-
   printf '%s' "<value>" | gcloud secrets versions add canary-mcp-token-int  --project ${PROJECT} --data-file=-
   printf '%s' "<value>" | gcloud secrets versions add slack-webhook-prod    --project ${PROJECT} --data-file=-
   printf '%s' "<value>" | gcloud secrets versions add slack-webhook-int     --project ${PROJECT} --data-file=-

Then fire a manual run:
   gcloud run jobs execute ${JOB} --project ${PROJECT} --region ${REGION}
NOTE
