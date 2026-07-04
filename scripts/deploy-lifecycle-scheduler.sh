#!/usr/bin/env bash
# spec-453 t-6 (dec-11): provision the deterministic daily trigger for timer-driven
# lifecycle emails — a Cloud Scheduler HTTP job that POSTs the memex-ai service's
# /api/internal/lifecycle-tick once a day. That one invocation runs BOTH spec-427's
# activation drip AND spec-453's "Connect with people" Day-12 pass.
#
# This REPLACES the in-process setInterval (removed from packages/server/src/index.ts):
# a single scheduled invocation is deterministic on scale-to-zero Cloud Run — no cold-start
# counter reset, no multi-instance duplicate race (spec-427 issue-4). It also RESOLVES that
# issue at the shared layer for both specs.
#
# AUTH (dec-11): the memex-ai service is public (--allow-unauthenticated for the app + MCP),
# so Cloud Run can't IAM-gate a single path. The endpoint self-authenticates a shared bearer
# secret (LIFECYCLE_TICK_SECRET). The scheduler sends it as an Authorization header. The real
# backstop against a stray/duplicate trigger is idempotency (every send dedups on its stable
# comms_log key), so the secret is defense-in-depth. NOTE: a Cloud Scheduler header value is
# stored in the job config (readable with cloudscheduler.jobs.get — project-admin IAM). That
# is the accepted trade-off of the shared-secret transport; the OIDC alternative (an
# invoker SA + in-app token verification) avoids storing it but adds a dependency. Raw secret
# VALUES never live in this repo — seed them into Secret Manager separately (see below).
#
# Idempotent — safe to re-run; creates what's missing, updates otherwise.
#
# Prereqs: gcloud auth with rights in the target project (+ an active PAM grant if required).
# Usage:  ENV=prod ./scripts/deploy-lifecycle-scheduler.sh    (ENV ∈ {int, prod})
set -euo pipefail

ENV="${ENV:-${1:-int}}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Pulls GCP_PROJECT, REGION, SERVICE, API_BASE_URL for the env (std-9).
# shellcheck source=/dev/null
source "${REPO_ROOT}/scripts/deploy-config.sh" "$ENV"

SCHED="memex-lifecycle-daily"
SCHED_SA="lifecycle-scheduler@${GCP_PROJECT}.iam.gserviceaccount.com"
SECRET_NAME="lifecycle-tick-secret"
TICK_URL="${API_BASE_URL}/api/internal/lifecycle-tick"
# Daily at 09:17 UTC — an off-round minute (dodges top-of-hour load), once a day (the
# passes are day-cadence: dwell timers + a Day-12 offset). Retry-safe (both passes dedup).
CRON="${LIFECYCLE_CRON:-17 9 * * *}"

echo "▸ env=${ENV} project=${GCP_PROJECT} region=${REGION} url=${TICK_URL}"

# ── Scheduler invoker service account ───────────────────────────────────────
gcloud iam service-accounts describe "$SCHED_SA" --project "$GCP_PROJECT" >/dev/null 2>&1 || \
  gcloud iam service-accounts create lifecycle-scheduler --project "$GCP_PROJECT" \
    --display-name "spec-453 lifecycle Cloud Scheduler"

# ── Secret container for LIFECYCLE_TICK_SECRET (VALUE seeded separately) ─────
# Org policy forbids 'global' secrets → pin replication to the project region.
gcloud secrets describe "$SECRET_NAME" --project "$GCP_PROJECT" >/dev/null 2>&1 || \
  gcloud secrets create "$SECRET_NAME" --project "$GCP_PROJECT" \
    --replication-policy user-managed --locations "$REGION"

# ── Wire the secret into the Cloud Run service (env var LIFECYCLE_TICK_SECRET) ─
# --update-secrets is additive (leaves the service's other env/secrets intact). The service
# reads LIFECYCLE_TICK_SECRET to authenticate the tick (routes/internal-lifecycle.ts). This
# is idempotent; it no-ops if the mapping already exists.
gcloud run services update "$SERVICE" --project "$GCP_PROJECT" --region "$REGION" \
  --update-secrets "LIFECYCLE_TICK_SECRET=${SECRET_NAME}:latest"

# ── Cloud Scheduler → the tick endpoint (daily) ─────────────────────────────
# Skippable during first provisioning (SKIP_SCHEDULER=1) until the secret VALUE is seeded
# and ACTIVATION_CONNECT_GO_LIVE is set on the service — so the tick doesn't fire half-wired.
if [ "${SKIP_SCHEDULER:-0}" != "1" ]; then
  # Read the seeded secret so the scheduler can present it as a bearer header.
  SECRET_VAL="$(gcloud secrets versions access latest --secret="$SECRET_NAME" --project "$GCP_PROJECT")"
  SCHED_ACTION=update
  gcloud scheduler jobs describe "$SCHED" --project "$GCP_PROJECT" --location "$REGION" >/dev/null 2>&1 || SCHED_ACTION=create
  echo "▸ ${SCHED_ACTION} Cloud Scheduler ${SCHED} (${CRON})"
  gcloud scheduler jobs "$SCHED_ACTION" http "$SCHED" --project "$GCP_PROJECT" --location "$REGION" \
    --schedule "$CRON" \
    --time-zone "Etc/UTC" \
    --uri "$TICK_URL" --http-method POST \
    --headers "Authorization=Bearer ${SECRET_VAL}"
else
  echo "▸ SKIP_SCHEDULER=1 — scheduler not created (seed the secret + set ACTIVATION_CONNECT_GO_LIVE first)"
fi

cat <<NOTE

✅ Infra applied. Remaining operator steps (values never live in this repo):
  1. Seed the tick secret (once):
       printf '%s' "\$(openssl rand -base64 32)" | \\
         gcloud secrets versions add ${SECRET_NAME} --project ${GCP_PROJECT} --data-file=-
     Then re-run this script WITHOUT SKIP_SCHEDULER so the scheduler picks up the value.
  2. Set the Connect go-live instant on the service — the SAME moment t-1's migration
     backfilled users.first_ac_verified_at (deploy time), so both emails agree on go-live:
       gcloud run services update ${SERVICE} --project ${GCP_PROJECT} --region ${REGION} \\
         --update-env-vars ACTIVATION_CONNECT_GO_LIVE=<deploy-timestamp-ISO8601>
     (or set ACTIVATION_CONNECT_GO_LIVE in the per-env deploy config so deploy.sh carries it).
  3. Flip ACTIVATION_EMAILS_ENABLED=1 when ready to send (spec-427 master switch).

Nothing sends until ACTIVATION_EMAILS_ENABLED is on; the tick is a no-op before then.
NOTE
