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

# ── Did the load ACTUALLY apply? ─────────────────────────────────────────────
# Both branches above print which source they chose BEFORE applying it, so the
# announcement is not evidence. On 2026-08-12 the prod deploy's smoke step sourced
# this file under dash (make's default /bin/sh), where `source` on line ~119 does
# not exist: it printed "source=SECRET-MANAGER", applied nothing, and returned 0.
# PUBLIC_HOST was unset, `SMOKE_BASE_URL="https://$PUBLIC_HOST"` became "https://",
# and the only reason the smoke hit the right host was something nobody chose
# (spec-518 issue-5). The Makefile now pins SHELL := /bin/bash, which fixes that
# instance — this guard is what stops the NEXT one, in whatever shell or caller
# nobody has thought of yet.
#
# Checking one representative key rather than all of them: any partial-source
# failure loses this too, and a full list would rot as keys come and go.
#
# POSIX `[ ]`, NOT `[[ ]]` — deliberately, and this is the whole point. A guard
# written with `[[ ]]` cannot fire in a shell that has no `[[ ]]`, which is the
# exact shell this guard exists for: dash prints "[[: not found", carries on
# non-fatally, and the check silently never runs. My first draft of this block
# made that mistake. A check must work in the failure mode it is checking for.
if [ -z "${PUBLIC_HOST:-}" ]; then
  echo "ERROR: deploy config reported a source but applied nothing — PUBLIC_HOST is unset." >&2
  echo "       The config body did not load. Most likely this file was sourced by a" >&2
  echo "       non-bash shell (it needs \`source\`, \`[[ ]]\` and \${BASH_SOURCE[0]}):" >&2
  echo "         • from a Makefile recipe → the Makefile must set SHELL := /bin/bash" >&2
  echo "         • from a script         → run it with bash, not sh" >&2
  echo "       Failing closed: shipping with half-loaded config is how spec-518 happened." >&2
  return 1 2>/dev/null || exit 1
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
# spec-428 (welcome) / spec-427 (drip) team-identity sender — optional per env;
# wired into Cloud Run via the ${VAR+...} optional pattern in packages/server/deploy.sh.
export EMAIL_ACTIVATION_FROM EMAIL_ACTIVATION_REPLY_TO EMAIL_SENDER_NAME
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
# ACTIVATION_EMAILS_ENABLED — spec-427 t-6 (dec-9): the activation-drip master + kill
# switch. Default OFF; enabled only in prod, only by hand, at the deliberate launch
# moment (and flipped back to stop everything). Same set-vs-unset semantics as
# HIDDEN_FEATURES — a deploy from a checkout that never set it must not silently flip
# the drip on OR off, so it is passed to Cloud Run only when the per-env config set it.
if [ -n "${ACTIVATION_EMAILS_ENABLED+set}" ]; then
  export ACTIVATION_EMAILS_ENABLED
fi
# ACTIVATION_CONNECT_GO_LIVE — spec-453 t-6 (dec-10/dec-11): the FIXED go-live instant the
# "Connect with people" Day-12 pass gates its back-catalog floor on. MUST be the same
# moment t-1's migration backfilled users.first_ac_verified_at to (deploy time), so the two
# emails agree on go-live. ISO-8601. Unset → the lifecycle-tick endpoint SKIPS the Connect
# pass (safe, never blasts). Same set-vs-unset passthrough as ACTIVATION_EMAILS_ENABLED so a
# checkout that never set it can't silently change go-live. (LIFECYCLE_TICK_SECRET is a
# SECRET — wired via Secret Manager by scripts/deploy-lifecycle-scheduler.sh, not here.)
if [ -n "${ACTIVATION_CONNECT_GO_LIVE+set}" ]; then
  export ACTIVATION_CONNECT_GO_LIVE
fi

# OTEL_EXPORTER_OTLP_ENDPOINT — turns on database observability and chooses
# where the metrics go. Unset (the default) means telemetry is off with zero
# overhead. Set it to any OpenTelemetry OTLP/HTTP endpoint and the server
# exports its own view of the database (query latency, throughput, errors, total
# backends vs max_connections, pool utilisation) directly there — no separate
# collector required. Point it at a managed backend (e.g. GCP Cloud Monitoring's
# OTLP ingest), or, when self-hosting, at your own collector / Grafana / Datadog;
# the metrics show up in your stack with no code change. Optional
# MEMEX_OTEL_EXPORT_INTERVAL_MS tunes the export/probe cadence (default 20000ms).
# Same set-vs-unset MERGE semantics as HIDDEN_FEATURES above: export ONLY when
# this checkout actually set it, so a deploy never blanks a live endpoint.
if [ -n "${OTEL_EXPORTER_OTLP_ENDPOINT+set}" ]; then
  export OTEL_EXPORTER_OTLP_ENDPOINT
fi
if [ -n "${MEMEX_OTEL_EXPORT_INTERVAL_MS+set}" ]; then
  export MEMEX_OTEL_EXPORT_INTERVAL_MS
fi

# MEMEX_EMISSION_* — spec-525 t-6: the AC-emission admission gate's knobs.
#
#   MEMEX_EMISSION_GATE_MODE    "shadow" (default, and what the first deploy runs) or
#                               "enforcing". Exactly one spelling turns refusal on;
#                               anything else — including "ENFORCING" or "true" — stays
#                               shadow. The DEFAULT IS THE SAFE ONE on purpose: a wiring
#                               mistake under-protects rather than silently applying
#                               untuned limits to real traffic.
#   MEMEX_EMISSION_WAIT_MS      how long a caller may be held before a 429 (default 250).
#                               Must stay an order of magnitude inside the emitter's own
#                               PER_REQUEST_TIMEOUT_MS=5000, or a server-side wait becomes
#                               client-side truncation (ac-18).
#   MEMEX_EMISSION_MAX_WAITERS  how many callers may queue at once. Unset means DERIVED
#                               (ceiling × waitMs / serviceMs) — prefer the derivation.
#   MEMEX_EMISSION_EVENT_BUDGET EMISSIONS in flight allowed at once — dec-6's second term,
#                               the one that bounds what a queued request actually costs
#                               (a parsed body, 1.1–1.5× its wire bytes; c-18). Default
#                               20000, deliberately unreachable at today's ceiling of 2
#                               (2 × 500 events max), so it cannot refuse before t-10 has
#                               measured. Read the value to set from the heartbeat's
#                               `inFlightEvents`, not from a guess.
#
# The CEILING is deliberately absent: ac-12 requires it computed from the resolved pool,
# so it follows DB_POOL_MAX. A hand-set ceiling is a number someone raises during a busy
# week, and the guarantee that user traffic always retains connections disappears without
# a trace.
#
# Both edits are mandatory — this export AND the --update-env-vars entry in deploy.sh.
# Miss the second and prod silently takes the code default while the right value sits
# unread in the canonical secret: that is spec-518, and the 2026-08-03 incident followed
# it. Here the same slip means shipping shadow while believing enforcement is on.
# Same set-vs-unset MERGE semantics as HIDDEN_FEATURES above.
if [ -n "${MEMEX_EMISSION_GATE_MODE+set}" ]; then
  export MEMEX_EMISSION_GATE_MODE
fi
if [ -n "${MEMEX_EMISSION_WAIT_MS+set}" ]; then
  export MEMEX_EMISSION_WAIT_MS
fi
if [ -n "${MEMEX_EMISSION_MAX_WAITERS+set}" ]; then
  export MEMEX_EMISSION_MAX_WAITERS
fi
if [ -n "${MEMEX_EMISSION_EVENT_BUDGET+set}" ]; then
  export MEMEX_EMISSION_EVENT_BUDGET
fi

# STORAGE_PROVIDER / STORAGE_GCS_BUCKET — spec-300: the blob backend for Skills'
# BINARY auxiliary files (getStorageProvider(), services/storage/index.ts). Unset in an
# env means the code default applies (local in dev, gcs in prod) — but gcs REQUIRES a
# bucket, so a prod env that stores binary aux files MUST set both here:
#   STORAGE_PROVIDER="gcs"
#   STORAGE_GCS_BUCKET="<bucket-name>"   # no gs:// prefix — the raw bucket name
# The bucket + its IAM are provisioned separately; the NAME is per-env instance config,
# so it lives in the memex-<env>-deploy-env secret, never hardcoded here. Same
# set-vs-unset MERGE semantics as HIDDEN_FEATURES above: exported (and passed to Cloud
# Run) ONLY when this checkout actually set it, so a deploy never blanks a live value.
if [ -n "${STORAGE_PROVIDER+set}" ]; then
  export STORAGE_PROVIDER
fi
if [ -n "${STORAGE_GCS_BUCKET+set}" ]; then
  export STORAGE_GCS_BUCKET
fi

# SERVICE_ACCOUNT — spec-300: the dedicated Cloud Run runtime service account. Pinned
# EXPLICITLY on deploy (rather than relying on Cloud Run's preserve-on-update) so a
# service recreate or first deploy lands the right identity — the one granted the
# skill-blob bucket's objectAdmin + serviceAccountTokenCreator-on-self for V4 signed
# URLs. Per-env value in the memex-<env>-deploy-env secret; passed via the optional
# ${SERVICE_ACCOUNT:+--service-account=...} flag in packages/server/deploy.sh, so an
# env that never sets it deploys unchanged (Cloud Run keeps the existing SA).
if [ -n "${SERVICE_ACCOUNT+set}" ]; then
  export SERVICE_ACCOUNT
fi

# MIN_INSTANCES / MAX_INSTANCES — spec-518: per-env Cloud Run autoscaling bounds, consumed by
# packages/server/deploy.sh as --min-instances ${MIN_INSTANCES:-0} / --max-instances
# ${MAX_INSTANCES:-3}. Unset → the 0/3 defaults (current behaviour), so an env that never sets
# them deploys unchanged. Set them in the memex-<env>-deploy-env secret to raise an env's
# ceiling (prod: MIN_INSTANCES=1, MAX_INSTANCES=8). Budget invariant: MAX_INSTANCES ×
# (DB_POOL_MAX + 1 relay LISTEN) must stay under the DB's effective max_connections ceiling
# (prod ~47). Same set-vs-unset export as the knobs above.
if [ -n "${MIN_INSTANCES+set}" ]; then
  export MIN_INSTANCES
fi
if [ -n "${MAX_INSTANCES+set}" ]; then
  export MAX_INSTANCES
fi
# DB_POOL_MAX — spec-518 t-7: exported for the same reason, and it took a red prod deploy to
# notice it wasn't. The value has always been read correctly by deploy.sh's own gcloud line
# (${DB_POOL_MAX+|DB_POOL_MAX=...} expands in THAT shell, where a plain sourced assignment is
# visible), so prod has run the right pool for weeks. But a plain assignment is not exported, so
# no CHILD process could see it — and t-7's guard is a child process. Its first prod run therefore
# reported DB_POOL_MAX absent while the canonical secret carried DB_POOL_MAX=4 and Cloud Run was
# applying it. Three states, not two: declared, in force, and VISIBLE to the thing checking.
# int could never have caught this, because int genuinely does not set the value.
# Same set-vs-unset semantics, so an env that never sets it still deploys byte-for-byte unchanged.
if [ -n "${DB_POOL_MAX+set}" ]; then
  export DB_POOL_MAX
fi

echo "[deploy-config] ENV=$ENV  project=$GCP_PROJECT  host=$PUBLIC_HOST  api=$API_PUBLIC_HOST"
