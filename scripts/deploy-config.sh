#!/bin/bash
# scripts/deploy-config.sh — env-aware deploy configuration loader.
#
# Sourced by the deploy.sh scripts (root + packages/server + packages/ui)
# to populate per-environment variables. Driven by `ENV` (defaults to `int`).
#
# Per-environment VALUES are NOT stored here — they live in gitignored files
# alongside this script: scripts/deploy.int.env, scripts/deploy.prod.env, ...
# Copy scripts/deploy.env.example to scripts/deploy.<env>.env and fill in your
# deployment's coordinates. This keeps instance-specific config (project ids,
# hosts, buckets, client ids) out of the repo — same model as .env/.env.example.
#
# PAM-gated access — deployers hold no standing roles on the GCP projects.
# Request the relevant PAM entitlement before running any deploy script that
# sources this file:
#   - make deploy-ui     → memex-{env}-deploy-admin (entitlement name is a
#     GCP-side resource that predates the packages/admin → packages/ui rename)
#   - make deploy-server → memex-{env}-deploy-server
# Eligibility: domain:mindset.ai. Max duration: 2h. See README.md for the
# `gcloud pam grants create` command.
#
# Adding a new dependency, secret, or runtime role MAY require updating one
# or more PAM entitlements. Contact support@memex.ai before merging changes
# that affect the deploy surface — deploys will break until the entitlement
# is updated.
#
# Usage from a deploy script:
#   set -euo pipefail
#   REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
#   source "${REPO_ROOT}/scripts/deploy-config.sh"
#   # Then use $GCP_PROJECT, $PUBLIC_HOST, $APP_BASE_URL, etc.
#
# Adding a new env: create scripts/deploy.<env>.env from the example and add
# the env name to the case below. Do NOT hardcode env-specific values in the
# per-package deploy.sh files — keep them in the per-env file.

ENV="${ENV:-int}"

case "$ENV" in
  int|prod) ;;
  *)
    echo "ERROR: Unknown ENV=$ENV. Must be 'int' or 'prod'." >&2
    return 1 2>/dev/null || exit 1
    ;;
esac

CONFIG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${CONFIG_DIR}/deploy.${ENV}.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found." >&2
  echo "       Copy scripts/deploy.env.example to scripts/deploy.${ENV}.env and fill it in." >&2
  return 1 2>/dev/null || exit 1
fi

# shellcheck source=/dev/null
source "$ENV_FILE"

# Derived values — composed from the per-env settings above.
CLOUD_SQL_INSTANCE_CONN="${GCP_PROJECT}:${REGION}:${CLOUD_SQL_INSTANCE_NAME}"
IMAGE="${REGION}-docker.pkg.dev/${GCP_PROJECT}/memex/${SERVICE}"
APP_BASE_URL="https://${PUBLIC_HOST}"
API_BASE_URL="https://${API_PUBLIC_HOST}"

export ENV GCP_PROJECT REGION
export CLOUD_SQL_INSTANCE_NAME CLOUD_SQL_INSTANCE_CONN
export DB_NAME DB_USER DB_PASS
export SERVICE IMAGE STATIC_BUCKET URL_MAP_NAME
export PUBLIC_HOST API_PUBLIC_HOST APP_BASE_URL API_BASE_URL
export GOOGLE_CLIENT_ID EMAIL_FROM SLACK_CLIENT_ID
# MEMEX_OWN_NAMESPACE — the server's own namespace identity, used by
# POST /api/test-events to reject events for refs in other namespaces
# (the cross-namespace safety net per b-90 dec-4 + dec-5). The route
# fail-closes when this env var is unset; see README's deploy section.
export MEMEX_OWN_NAMESPACE
# HIDDEN_FEATURES — comma-separated feature slugs to hide on this environment
# (e.g. 'scaffold,spec-pause,pulse'). Read at runtime by the server's
# getHiddenFeatures() (packages/server/src/services/auth.ts). Hiding is
# per-environment, all-or-nothing, and FAIL-OPEN: unset or empty => nothing
# hidden. To hide features on an environment, set HIDDEN_FEATURES in that
# env's deploy.<env>.env file and redeploy the server (make deploy-server).
# See docs/feature-hiding.md for the hide/unhide runbook.
#
# Set-vs-unset is load-bearing (spec-168 dec-4). Export HIDDEN_FEATURES ONLY
# when the per-env config actually set it — an explicit value, INCLUDING an
# explicit empty string (a deliberate un-hide), counts as set. When the config
# is silent, leave it UNSET so packages/server/deploy.sh OMITS it from the
# Cloud Run --update-env-vars MERGE and the live value is preserved rather than
# blanked. This stops a deploy from a checkout that never set the value from
# silently un-hiding features. deploy.sh guards its expansion with
# ${HIDDEN_FEATURES+...}, so leaving it unset is safe under `set -u`.
if [ -n "${HIDDEN_FEATURES+set}" ]; then
  export HIDDEN_FEATURES
fi

echo "[deploy-config] ENV=$ENV  project=$GCP_PROJECT  host=$PUBLIC_HOST  api=$API_PUBLIC_HOST"
