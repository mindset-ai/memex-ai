#!/bin/bash
# scripts/deploy-config.sh — env-aware deploy configuration loader.
#
# Sourced by the deploy.sh scripts (root + packages/server + packages/ui)
# to populate per-environment variables. Driven by `ENV` (defaults to `int`).
#
# WHERE per-environment VALUES come from (spec-168 — single source of truth):
#   1. CANONICAL: a Secret Manager secret `memex-${ENV}-deploy-env` holding the
#      full deploy.<env>.env body, fetched at deploy time (the same model
#      DB_PASS already uses). Fetched on EVERY normal deploy, so there is no
#      per-machine file to drift. Bootstrap: the fetch needs to know which GCP
#      project holds the secret BEFORE it has the config, so set
#      DEPLOY_CONFIG_PROJECT to that project — the one pointer that cannot live
#      inside the secret (spec-168 dec-5). Fetch FAILS CLOSED: an unreadable
#      secret aborts the deploy loudly, never falling back to empty/stale config.
#   2. LOCAL OVERRIDE (opt-in, ad-hoc testing only): a present
#      scripts/deploy.<env>.env, or DEPLOY_CONFIG_SOURCE=local, takes precedence
#      and is sourced instead of the secret. Force the secret even when a local
#      file exists with DEPLOY_CONFIG_SOURCE=secret. The local file is NEVER
#      required and never silently authoritative — when used, the loader says so
#      on stderr.
# Either way the VALUES (project ids, hosts, buckets, client ids) stay OUT of
# this tracked, open-core file — same reason as .env / .env.example.
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
# Adding a new env: add the env name to the case below, create the canonical
# secret memex-<env>-deploy-env (seeded from scripts/deploy.env.example) in that
# env's GCP project, and extend the memex-<env>-deploy-server PAM entitlement's
# secretAccessor condition to cover it. Do NOT hardcode env-specific values in
# the per-package deploy.sh files or here — they belong in the canonical secret
# (a local scripts/deploy.<env>.env stays available as an opt-in override).

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
CONFIG_SECRET="memex-${ENV}-deploy-env"

# Decide the config source (spec-168 dec-2, hybrid). DEPLOY_CONFIG_SOURCE forces
# a source explicitly; otherwise a present local file is an opt-in override and
# everything else falls through to the canonical Secret Manager fetch.
_use_local=0
case "${DEPLOY_CONFIG_SOURCE:-}" in
  local)  _use_local=1 ;;
  secret) _use_local=0 ;;
  "")     [[ -f "$ENV_FILE" ]] && _use_local=1 ;;
  *)
    echo "ERROR: DEPLOY_CONFIG_SOURCE='${DEPLOY_CONFIG_SOURCE}' is invalid (use 'local' or 'secret')." >&2
    return 1 2>/dev/null || exit 1
    ;;
esac

if [[ "$_use_local" == "1" ]]; then
  # Explicit/opt-in LOCAL override — ad-hoc testing only. Announced loudly so it
  # is never silently authoritative (spec-168 dec-2 / ac-9).
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "ERROR: DEPLOY_CONFIG_SOURCE=local but $ENV_FILE not found." >&2
    echo "       Copy scripts/deploy.env.example to scripts/deploy.${ENV}.env and fill it in," >&2
    echo "       or unset DEPLOY_CONFIG_SOURCE to fetch the canonical config from Secret Manager." >&2
    return 1 2>/dev/null || exit 1
  fi
  echo "[deploy-config] source=LOCAL-OVERRIDE file=$ENV_FILE (canonical secret $CONFIG_SECRET bypassed)" >&2
  # shellcheck source=/dev/null
  source "$ENV_FILE"
else
  # CANONICAL source of truth: fetch memex-<env>-deploy-env every deploy
  # (spec-168 dec-1/dec-3 / ac-6, ac-8). No per-machine file => no drift path.
  if [[ -z "${DEPLOY_CONFIG_PROJECT:-}" ]]; then
    echo "ERROR: DEPLOY_CONFIG_PROJECT is not set — cannot locate the canonical deploy-config secret." >&2
    echo "       Set it to the GCP project holding '$CONFIG_SECRET' (the one pointer that can't live in the secret, spec-168 dec-5)," >&2
    echo "       or use a local override: set DEPLOY_CONFIG_SOURCE=local with scripts/deploy.${ENV}.env present." >&2
    return 1 2>/dev/null || exit 1
  fi
  echo "[deploy-config] source=SECRET-MANAGER secret=$CONFIG_SECRET project=$DEPLOY_CONFIG_PROJECT" >&2
  # Capture stdout only; let gcloud's own error stream to the terminal. Fetch
  # FAILS CLOSED — an unreadable secret aborts rather than shipping empty/stale
  # config (spec-168 dec-2 / ac-7, ac-8). The ${var:-} guards keep `set -u` happy.
  _fetch_failed=0
  _config_payload="$(gcloud secrets versions access latest --secret="$CONFIG_SECRET" --project="$DEPLOY_CONFIG_PROJECT")" || _fetch_failed=1
  if [[ "$_fetch_failed" == "1" || -z "${_config_payload:-}" ]]; then
    echo "ERROR: could not read canonical deploy config from Secret Manager (fail-closed, no fallback)." >&2
    echo "       secret=$CONFIG_SECRET project=$DEPLOY_CONFIG_PROJECT" >&2
    echo "       Confirm the secret exists and you hold the memex-${ENV}-deploy-server PAM grant (secretAccessor)." >&2
    return 1 2>/dev/null || exit 1
  fi
  # macOS /bin/bash is 3.2, which can't reliably `source <(...)` a process
  # substitution, so write the payload to a private temp file (mktemp => 0600)
  # and source that — mirroring the original `source "$ENV_FILE"` path.
  _config_tmp="$(mktemp "${TMPDIR:-/tmp}/deploy-config.XXXXXX")"
  printf '%s\n' "$_config_payload" > "$_config_tmp"
  # shellcheck source=/dev/null
  source "$_config_tmp"
  rm -f "$_config_tmp"
fi

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
# SIGNUP_DOMAIN_ALLOWLIST — comma-separated domains allowed for new account creation
# (spec-174). Set in int to restrict to mindset.ai,memex.ai. Unset in prod = no restriction.
# Same set-vs-unset semantics as HIDDEN_FEATURES: a deploy from a checkout that never
# set this value must not silently clear a live int restriction.
if [ -n "${SIGNUP_DOMAIN_ALLOWLIST+set}" ]; then
  export SIGNUP_DOMAIN_ALLOWLIST
fi

echo "[deploy-config] ENV=$ENV  project=$GCP_PROJECT  host=$PUBLIC_HOST  api=$API_PUBLIC_HOST"
