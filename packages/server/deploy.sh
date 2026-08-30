#!/bin/bash
set -euo pipefail

# ── PAM requirement ───────────────────────────────────────────
# This script requires a PAM grant on:
#   memex-int-deploy-server  (when ENV=int)
#   memex-prod-deploy-server (when ENV=prod)
# Eligibility: domain:mindset.ai. Max duration: 2h. Request a grant via
# `gcloud pam grants create` before running. See README.md for details.
# Adding new secrets, KMS keys, or runtime roles may require a PAM update —
# contact support@memex.ai before merging changes that affect the deploy
# surface.

# ── Configuration ──────────────────────────────────────────────
# All env-specific values come from scripts/deploy-config.sh — sourced via the
# repo root so a single ENV var switches everything (project, region, SQL
# instance, bucket, hostnames). Default ENV=int matches today; ENV=prod
# targets memex-ai-prod (b-9).

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PKG_DIR="${REPO_ROOT}/packages/server"
cd "${PKG_DIR}"
source "${REPO_ROOT}/scripts/deploy-config.sh"

# Per-script extras (not env-specific).
DB_PORT=5432           # Cloud Run reaches Cloud SQL via Unix socket; this is just for the connection string syntax.
PROXY_PORT=15432       # local cloud-sql-proxy port for migrations

# ── Secret prerequisites ──────────────────────────────────────
# These secrets must exist in GCP Secret Manager before --update-secrets below
# can wire them into the Cloud Run revision. Create once per project (see
# scripts/deploy-config.sh comments + b-9 t-1 for the prod provisioning notes).
#
# For prod, all 5 secrets (auth-jwt-secret, anthropic-api-key,
# postmark-server-token, openai-api-key, memex-prod-db-password) are stored
# with --replication-policy=user-managed --locations=us-east4 to satisfy the
# org policy `constraints/gcp.resourceLocations`.
#
# Rotating AUTH_JWT_SECRET invalidates every active session (everyone signs in again).
# Pre-flight: fail fast if the required secrets don't exist, so we don't ship a broken revision.

echo "Verifying required secrets exist in Secret Manager (project=${GCP_PROJECT})..."
for S in auth-jwt-secret postmark-server-token anthropic-api-key openai-api-key; do
  if ! gcloud secrets describe "$S" --project "${GCP_PROJECT}" >/dev/null 2>&1; then
    echo ""
    echo "ERROR: secret '$S' not found in project '${GCP_PROJECT}'."
    echo "See the comment block at the top of deploy.sh / scripts/deploy-config.sh for creation commands."
    exit 1
  fi
done
# COHERE_API_KEY is optional — only needed if EMBEDDING_PROVIDER=cohere is set
# for A/B comparison. Default provider is OpenAI.
if gcloud secrets describe cohere-api-key --project "${GCP_PROJECT}" >/dev/null 2>&1; then
  echo "  ✓ all required secrets present (+ cohere-api-key for optional A/B)"
  HAS_COHERE=1
else
  echo "  ✓ all required secrets present (cohere-api-key not configured — OpenAI-only)"
  HAS_COHERE=0
fi
# SLACK_CLIENT_SECRET is optional until b-23 (Slack integration) ships to prod.
# Once b-23 is live, the decision in b-23 covers whether to make this mandatory.
if gcloud secrets describe slack-client-secret --project "${GCP_PROJECT}" >/dev/null 2>&1; then
  echo "  ✓ slack-client-secret present — Slack integration enabled"
  HAS_SLACK=1
else
  echo "  ⚠ slack-client-secret not found — Slack integration disabled (see b-23)"
  HAS_SLACK=0
fi
# MIXPANEL_TOKEN is optional (spec-244 analytics forwarder, dec-2/dec-9). Wired ONLY
# if the secret exists, so a deploy never breaks before it's provisioned — the
# forwarder simply stays in capture-only mode (events land in usage_events and are
# queryable in SQL; nothing forwards) until the secret lands. Same two-step
# provisioning as the other optional secrets (NO further code change): create the per-env
# secret AND grant the Cloud Run runtime SA read access. The per-env separation
# (dec-9) is the VALUE — the int secret holds the memex-int Mixpanel project token,
# prod holds memex-prod's — so int events never reach the prod project.
#   printf %s "<project-token>" | gcloud secrets create memex-mixpanel-token --data-file=- \
#     --project "${GCP_PROJECT}" --replication-policy=user-managed --locations=us-east4
#   gcloud secrets add-iam-policy-binding memex-mixpanel-token --project "${GCP_PROJECT}" \
#     --member="serviceAccount:<cloud-run-runtime-SA>" \
#     --role="roles/secretmanager.secretAccessor"
if gcloud secrets describe memex-mixpanel-token --project "${GCP_PROJECT}" >/dev/null 2>&1; then
  echo "  ✓ memex-mixpanel-token present — analytics forwarder enabled"
  HAS_MIXPANEL=1
else
  echo "  ⚠ memex-mixpanel-token not found — analytics forwarder in capture-only mode (spec-244)"
  HAS_MIXPANEL=0
fi
# STRIPE secrets are optional (spec-171 hosted purchase flow). Wired ONLY if BOTH
# secrets exist, so an env without billing configured deploys fine. Same two-step
# provisioning as MIXPANEL above (NO further code change): create the per-env
# secrets AND grant the Cloud Run runtime SA read access. Per-env VALUES differ —
# int holds Stripe TEST keys, prod holds LIVE keys (the secret's value carries the
# separation, like MIXPANEL).
#   printf %s "<sk_...>"    | gcloud secrets create memex-stripe-secret-key --data-file=- \
#     --project "${GCP_PROJECT}" --replication-policy=user-managed --locations=us-east4
#   printf %s "<whsec_...>" | gcloud secrets create memex-stripe-webhook-secret --data-file=- \
#     --project "${GCP_PROJECT}" --replication-policy=user-managed --locations=us-east4
#   # then add-iam-policy-binding secretAccessor for the Cloud Run runtime SA on each.
if gcloud secrets describe memex-stripe-secret-key --project "${GCP_PROJECT}" >/dev/null 2>&1 \
   && gcloud secrets describe memex-stripe-webhook-secret --project "${GCP_PROJECT}" >/dev/null 2>&1; then
  echo "  ✓ Stripe secrets present — hosted purchase flow enabled"
  HAS_STRIPE=1
else
  echo "  ⚠ Stripe secrets not found — hosted purchase flow disabled (spec-171)"
  HAS_STRIPE=0
fi
# Conversion API credentials (spec-21 issue-3). One optional block per ad platform —
# wired only if ALL secrets for that platform exist, so a partial or missing setup
# never breaks the deploy. When any secret is absent the corresponding conversion
# function in conversion-apis.ts silently skips. Same two-step provisioning as
# MIXPANEL above (create secret + grant runtime SA secretAccessor). Provisioning
# commands (substitute the correct project, SA, and credential values):
#   printf %s "<id>"     | gcloud secrets create google-ads-client-id           --data-file=- --project "${GCP_PROJECT}" --replication-policy=user-managed --locations=us-east4
#   printf %s "<secret>" | gcloud secrets create google-ads-client-secret       --data-file=- --project "${GCP_PROJECT}" --replication-policy=user-managed --locations=us-east4
#   printf %s "<token>"  | gcloud secrets create google-ads-refresh-token       --data-file=- --project "${GCP_PROJECT}" --replication-policy=user-managed --locations=us-east4
#   printf %s "<token>"  | gcloud secrets create google-ads-developer-token     --data-file=- --project "${GCP_PROJECT}" --replication-policy=user-managed --locations=us-east4
#   printf %s "<id>"     | gcloud secrets create google-ads-customer-id         --data-file=- --project "${GCP_PROJECT}" --replication-policy=user-managed --locations=us-east4
#   printf %s "<id>"     | gcloud secrets create google-ads-conversion-action-id --data-file=- --project "${GCP_PROJECT}" --replication-policy=user-managed --locations=us-east4
#   printf %s "<token>"  | gcloud secrets create linkedin-access-token        --data-file=- --project "${GCP_PROJECT}" --replication-policy=user-managed --locations=us-east4
#   printf %s "<id>"     | gcloud secrets create linkedin-ad-account-id       --data-file=- --project "${GCP_PROJECT}" --replication-policy=user-managed --locations=us-east4
#   printf %s "<id>"     | gcloud secrets create linkedin-conversion-id       --data-file=- --project "${GCP_PROJECT}" --replication-policy=user-managed --locations=us-east4
#   printf %s "<id>"     | gcloud secrets create openai-pixel-id              --data-file=- --project "${GCP_PROJECT}" --replication-policy=user-managed --locations=us-east4
#   printf %s "<key>"    | gcloud secrets create openai-pixel-api-key         --data-file=- --project "${GCP_PROJECT}" --replication-policy=user-managed --locations=us-east4
#   # then for each: gcloud secrets add-iam-policy-binding <secret> --project "${GCP_PROJECT}" --member="serviceAccount:<runtime-SA>" --role="roles/secretmanager.secretAccessor"
# spec-21: a conversion secret is only USABLE if it has an accessible `latest` VERSION.
# `gcloud secrets describe` passes on an empty (versionless) container, which would flip a
# guard ON and then fail the Cloud Run deploy resolving `:latest` (the linkedin-ad-account-id
# half-provisioned incident). Check the version instead so a half-provisioned secret cleanly
# DISABLES its conversion group rather than breaking the deploy.
secret_has_version() {
  gcloud secrets versions access latest --secret="$1" --project "${GCP_PROJECT}" >/dev/null 2>&1
}
if secret_has_version google-ads-client-id \
   && secret_has_version google-ads-client-secret \
   && secret_has_version google-ads-refresh-token \
   && secret_has_version google-ads-developer-token \
   && secret_has_version google-ads-customer-id \
   && secret_has_version google-ads-conversion-action-id; then
  echo "  ✓ Google Ads conversion secrets present — Enhanced Conversions enabled (spec-21)"
  HAS_GOOGLE_ADS_CONVERSIONS=1
else
  echo "  ⚠ Google Ads conversion secrets not found — Enhanced Conversions disabled (spec-21 issue-3)"
  HAS_GOOGLE_ADS_CONVERSIONS=0
fi
if secret_has_version linkedin-access-token \
   && secret_has_version linkedin-ad-account-id \
   && secret_has_version linkedin-conversion-id; then
  echo "  ✓ LinkedIn Conversions API secrets present — server-side conversions enabled (spec-21)"
  HAS_LINKEDIN_CONVERSIONS=1
else
  echo "  ⚠ LinkedIn Conversions API secrets not found — LinkedIn server-side conversions disabled (spec-21 issue-3)"
  HAS_LINKEDIN_CONVERSIONS=0
fi
if secret_has_version openai-pixel-id \
   && secret_has_version openai-pixel-api-key; then
  echo "  ✓ OpenAI pixel secrets present — server-side conversions enabled (spec-21)"
  HAS_OPENAI_PIXEL_CONVERSIONS=1
else
  echo "  ⚠ OpenAI pixel secrets not found — OpenAI server-side conversions disabled (spec-21 issue-3)"
  HAS_OPENAI_PIXEL_CONVERSIONS=0
fi

# ── KMS prerequisite ─────────────────────────────────────────
# The Slack token encryption path (services/slack/crypto.ts) requires a
# symmetric CryptoKey 'slack-tokens' in keyRing 'memex'. Without it the
# production server cannot encrypt or decrypt Slack OAuth tokens. This guard
# prevents deploying a revision that would fail silently on first token write.
# Provision once via the commands in b-23 T-11.
echo "Verifying KMS key for Slack token encryption..."
if ! gcloud kms keys describe slack-tokens \
    --keyring=memex \
    --location="$REGION" \
    --project="$GCP_PROJECT" >/dev/null 2>&1; then
  echo ""
  echo "ERROR: KMS CryptoKey 'slack-tokens' not found in keyRing 'memex' ($REGION, $GCP_PROJECT)."
  echo "This key is required before deploying any revision that includes the Slack integration."
  echo "Run the provisioning commands in b-23 T-11 first."
  exit 1
fi
echo "  ✓ KMS key 'slack-tokens' present"

# ── Step 1: Local build check ────────────────────────────────
# spec-417 dec-5 + dec-6 — the deploy order is:
#   Step 1 local build check → Step 2 container build/push → Step 3 SCHEMA migrations
#   (1a/1b) → Step 4 Cloud Run cutover → Step 5 DATA backfills (1c–1f, post-cutover).
# dec-5 moved build/push ahead of migrations; dec-6 then moved the data backfills
# past the cutover. Together they collapse the window in which the OLD revision runs
# against the NEW schema to ~schema-DDL-apply + cutover time. On the 2026-06-26
# incident that window was ~20 min — but the driver was the first-run data backfills
# (~18 min), NOT the build (~89s cache-hit); see issue-1. SCHEMA migrations (1a/1b)
# still land BEFORE the revision swap, so the b-36 invariant in Step 3 is preserved —
# and a build failure now aborts BEFORE any migration runs, which is strictly safer.
echo ""
echo "Running local build check..."
pnpm run build

# ── Step 2: Build and push container ──────────────────────────
echo ""
echo "Building container image (${IMAGE})..."

# Submit from the repo root so the build context includes packages/shared
# (workspace dep of @memex/server). The Dockerfile at the repo root is
# workspace-aware; .gcloudignore there keeps the upload lean.
#
# spec-281 Fix 2: build via cloudbuild.yaml (not bare `--tag`) so the build reuses
# cached layers from the previously-pushed image (`--cache-from` + BuildKit inline
# cache). `--tag` gives the clean Cloud Build worker no cache, so the pnpm-install
# `deps` layer rebuilt every deploy even when only source changed (~2min wasted on
# int + prod). `_IMAGE` is env-keyed, so this lands identically on both.
( cd "${REPO_ROOT}" && gcloud builds submit \
  --config cloudbuild.yaml \
  --substitutions "_IMAGE=${IMAGE}" \
  --project "${GCP_PROJECT}" \
  --region "${REGION}" \
  --default-buckets-behavior=regional-user-owned-bucket )

# ── Step 3: Run SCHEMA migrations (pre-cutover) ───────────────
# Two phases, matching the project convention (packages/server/TEST.md):
#   1a. drizzle-kit migrate  → journal-tracked files (0000–0008)
#   1b. apply-hand-migrations.sh → hand-written files (0009+), tracked in manual_migrations
#
# spec-417 dec-6 — only the SCHEMA DDL (1a/1b) runs here, before the cutover. The
# DATA backfills/generation (formerly 1c–1f) moved to Step 5, AFTER the Cloud Run
# revision is serving traffic. Reason (issue-1): the 2026-06-26 ~18-min downtime
# was the first-run backfills sitting in the OLD-revision-vs-NEW-schema window, not
# the build (which was ~89s cache-hit). The DDL itself is seconds, so keeping only
# 1a/1b pre-cutover collapses that window to ~DDL + cutover; the backfills (idempotent,
# non-gating, and not required for the new code to boot) run post-cutover where they
# cost wall-clock but never downtime. The cloud-sql-proxy started below stays UP
# across the cutover and is torn down in Step 5.
#
# ⚠️  b-36 canonical-refs hard switch: SCHEMA migrations MUST land before the Cloud
# Run revision swap (Step 4 below). The new server resolves entities by canonical
# ref + `seq` columns added in 0052 (doc_comments_seq) and rejects UUID inputs
# at the MCP boundary. Swapping the revision first would leave the old code
# running against a fresh schema (harmless) but the new code running against
# the old schema (broken section / comment lookups). The invariant is only that
# SCHEMA migrations (1a/1b) land BEFORE the Cloud Run revision swap (Step 4) — NOT
# before the image build, and the data backfills (Step 5) carry no such constraint.
# Per spec-417 dec-5 + dec-6 the order is now build → push → schema migrations →
# deploy → data backfills, which preserves this invariant while shrinking the window
# in which the OLD revision runs against the NEW schema to ~DDL-apply + cutover time.
#
# FIRST-TIME BOOTSTRAP (run once per environment before the first deploy through this
# path, e.g. against prod that's had 0009–0017 applied manually):
#   DATABASE_URL="..." ./scripts/apply-hand-migrations.sh --seed
# That marks every existing hand-written file as already-applied without running it.
# Subsequent deploys then only execute genuinely new files.
#
# ⚠️  PREREQUISITES for the standards-embeddings stack (doc-8 / migrations 0023+ and 0032):
#
#   1. pgvector extension MUST be available on the Cloud SQL instance.
#      It is available by default on POSTGRES_17 in Cloud SQL — migrations
#      `CREATE EXTENSION IF NOT EXISTS vector` self-install at the DB level.
#      (Do NOT set --database-flags=cloudsql.enable_pgvector=on — Cloud SQL
#      rejects that flag on POSTGRES_17 as "invalidFlagName".)
#
#   2. OPENAI_API_KEY secret MUST be set in Secret Manager (checked in the pre-flight
#      block above). Standards-search runs OpenAI text-embedding-3-large at
#      query-time AND document-time — without it, every standard write fails and the
#      agent's `search_memex` tool returns nothing useful. If you ever rotate the
#      key, also re-run `pnpm tsx packages/server/scripts/backfill-memex-embeddings.ts`
#      to re-embed any docs that were inserted during the gap.

echo "Running database migrations (ENV=${ENV})..."

# Kill any stale proxy on our port (leftover from a failed earlier run).
lsof -ti tcp:${PROXY_PORT} 2>/dev/null | xargs kill -9 2>/dev/null || true
cloud-sql-proxy "${CLOUD_SQL_INSTANCE_CONN}" --port ${PROXY_PORT} &
PROXY_PID=$!
sleep 3

# URL-encode DB_PASS to survive postgresql:// parsing (random base64 contains '+/=' chars).
DB_PASS_ENC=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "${DB_PASS}")
DB_URL="postgresql://${DB_USER}:${DB_PASS_ENC}@localhost:${PROXY_PORT}/${DB_NAME}"

# Runtime credentials for Cloud Run (spec-199 t-14). Migrations ALWAYS use the
# superuser path (DB_USER/DB_PASS) — RUNTIME_DB_* is the restricted memex_app
# role that RLS enforces on. Defaults to DB_USER/DB_PASS until t-14 is rolled
# out per environment via RUNTIME_DB_USER/RUNTIME_DB_PASS in the deploy-env secret.
RUNTIME_DB_USER="${RUNTIME_DB_USER:-$DB_USER}"
RUNTIME_DB_PASS="${RUNTIME_DB_PASS:-$DB_PASS}"
RUNTIME_DB_PASS_ENC=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "${RUNTIME_DB_PASS}")

# ── spec-515 t-3: reserved-root collision gate (PRE-condition, gating) ────────
# `memexResolver` treats a word in RESERVED_API_ROOTS as "not a tenant", which is
# what makes a flat /api/<root> mount reachable — and what would strand a tenant
# that already owns that word as its namespace slug. The two features compete for
# one vocabulary (std-3 cl-7); this is the interlock.
#
# Runs BEFORE migrations on purpose: it is a precondition, so it must fail while
# the schema is still untouched. GATING (no `|| true`) — unlike the idempotent
# backfills in Step 5, a collision here means a live tenant is about to go
# unroutable. Exit 2 ("could not check") is treated exactly like exit 1: an
# unverified deploy is not a verified one.
#
# Invoked through the package's own `check-reserved-roots` script, matching every
# sibling one-off in packages/server (`db:backfill-*`, `db:seed*`). The first
# attempt was `pnpm --filter @memex/server tsx <file>`, which pnpm reads as "run
# the script NAMED tsx" — there is none, so it died with
# ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT and, because this gate is fail-closed, aborted
# the whole deploy on its first real run. A named script keeps the deploy calling
# exactly what a developer can call locally, and deploy-script-parity.test.ts now
# asserts every script deploy.sh invokes actually exists.
echo "  1·pre. reserved-root collision check (spec-515)..."
if ! DATABASE_URL="${DB_URL}" pnpm --filter @memex/server check-reserved-roots; then
  echo ""
  echo "ERROR: reserved-root collision check did not pass — aborting before migrations."
  kill ${PROXY_PID} 2>/dev/null || true
  exit 1
fi

echo "  1a. drizzle-kit journal migrations..."
DATABASE_URL="${DB_URL}" pnpm db:migrate

echo "  1b. hand-written migrations..."
DATABASE_URL="${DB_URL}" bash "${PKG_DIR}/scripts/apply-hand-migrations.sh"

# spec-520 t-12: create the days ahead, drop the days past the retention window.
#
# ⚠ HERE, AND NOT IN THE SERVER. DROP TABLE requires ownership, and the request path's role
# must not have it [per std-36]. This runs on DB_URL — the owner connection already open for
# migrations — never on RUNTIME_DB_*. It is deliberately not the in-process setInterval
# shape used by activity-log-sweep, which runs inside the API server as the runtime role.
#
# Idempotent and safe on a schema that predates 0142: it exits quietly if test_events is not
# partitioned yet. A failure here is NOT fatal to the deploy — 60 days of partitions are
# created ahead, so a skipped run costs nothing until the horizon is nearly reached, and
# aborting a deploy over housekeeping would be the wrong trade.
echo "  1c. test_events partition maintenance..."
if ! DATABASE_URL="${DB_URL}" node "${PKG_DIR}/scripts/maintain-test-events-partitions.mjs"; then
  echo "  WARNING: partition maintenance failed — deploy continues (60-day horizon absorbs it)."
  echo "           Investigate before the horizon runs out, or inserts will start failing."
fi

# NOTE (spec-417 dec-6): the data backfills/generation that used to run here (1c–1f)
# now run in Step 5, AFTER the Cloud Run cutover. The cloud-sql-proxy started above
# is deliberately LEFT RUNNING across the cutover (Step 4) and is torn down at the end
# of Step 5 — DB_URL stays valid for the backfills without re-establishing the proxy.
echo "Schema migrations complete (1a/1b) — proxy stays up for post-cutover backfills (Step 5)."

# ── Step 3b: connection-budget PRE-FLIGHT (spec-518 t-7) ──────
# The cheap save: refuse to touch prod at all if the scaling config is not explicit, or if the
# values about to be applied do not fit the connection ceiling. Runs HERE because the proxy from
# Step 3 is up, so the ceiling is read from Postgres (`pg_settings`) rather than from
# `gcloud sql describe`'s recorded flags — prod ran a week on a recorded ceiling sized for a
# machine that no longer existed (spec-518 dec-2). On prod an absent MAX_INSTANCES / MIN_INSTANCES /
# DB_POOL_MAX aborts: `${VAR:-default}` below turns a missing variable into a live configuration
# change, and that default is the trap rather than the arithmetic. On int the guard warns and
# continues (spec-518 dec-5) — int violates the corrected invariant at its own defaults
# (2 × 3 × (5+1) = 36 against 22 usable) and survives it, because int's load never extends the pools.
DB_URL="${DB_URL}" pnpm run deploy:verify-scaling -- --mode=plan

# ── Step 4: Deploy to Cloud Run ───────────────────────────────
echo ""
echo "Deploying to Cloud Run..."

# Build the secrets wiring string. OPENAI_API_KEY is required for
# semantic code search; COHERE_API_KEY is only wired if the secret exists
# (optional A/B provider for embedding experimentation).
SECRETS_WIRING="ANTHROPIC_API_KEY=anthropic-api-key:latest"
SECRETS_WIRING+=",POSTMARK_SERVER_TOKEN=postmark-server-token:latest"
SECRETS_WIRING+=",AUTH_JWT_SECRET=auth-jwt-secret:latest"
# spec-341: Basic-auth credential for the Postmark delivery webhook
# (/api/postmark/webhook). OPTIONAL — only wired if the secret exists (same
# posture as COHERE below), so this deploy never breaks if it's not yet created.
# Until the secret is present the webhook route returns 401 (deliveries rejected);
# email send-logging + Stripe capture work regardless. Create with:
#   gcloud secrets create postmark-webhook-token --replication-policy=user-managed \
#     --locations=us-east4 --data-file=- --project "<project>"
if gcloud secrets describe postmark-webhook-token --project "${GCP_PROJECT}" >/dev/null 2>&1; then
  SECRETS_WIRING+=",POSTMARK_WEBHOOK_TOKEN=postmark-webhook-token:latest"
fi
# spec-427 t-3 / dec-8 (ac-15): the lifecycle/broadcast path uses the REAL Postmark
# token ONLY in prod (the same server-token secret, on the real broadcast stream —
# no second Postmark server). int deliberately leaves POSTMARK_BROADCAST_TOKEN unset
# so the server defaults to Postmark's sandbox token and delivers no real broadcast
# mail (fail-safe — see getEmailSender). The transactional POSTMARK_SERVER_TOKEN
# wiring above is unchanged in both envs.
if [ "$ENV" = "prod" ]; then
  SECRETS_WIRING+=",POSTMARK_BROADCAST_TOKEN=postmark-server-token:latest"
fi
SECRETS_WIRING+=",OPENAI_API_KEY=openai-api-key:latest"
if [ "$HAS_SLACK" = "1" ]; then
  SECRETS_WIRING+=",SLACK_CLIENT_SECRET=slack-client-secret:latest"
fi
if [ "$HAS_COHERE" = "1" ]; then
  SECRETS_WIRING+=",COHERE_API_KEY=cohere-api-key:latest"
fi
if [ "$HAS_MIXPANEL" = "1" ]; then
  SECRETS_WIRING+=",MIXPANEL_TOKEN=memex-mixpanel-token:latest"
fi
if [ "$HAS_STRIPE" = "1" ]; then
  SECRETS_WIRING+=",STRIPE_SECRET_KEY=memex-stripe-secret-key:latest,STRIPE_WEBHOOK_SECRET=memex-stripe-webhook-secret:latest"
fi
if [ "$HAS_GOOGLE_ADS_CONVERSIONS" = "1" ]; then
  SECRETS_WIRING+=",GOOGLE_ADS_CLIENT_ID=google-ads-client-id:latest,GOOGLE_ADS_CLIENT_SECRET=google-ads-client-secret:latest,GOOGLE_ADS_REFRESH_TOKEN=google-ads-refresh-token:latest,GOOGLE_ADS_DEVELOPER_TOKEN=google-ads-developer-token:latest,GOOGLE_ADS_CUSTOMER_ID=google-ads-customer-id:latest,GOOGLE_ADS_CONVERSION_ACTION_ID=google-ads-conversion-action-id:latest"
fi
if [ "$HAS_LINKEDIN_CONVERSIONS" = "1" ]; then
  SECRETS_WIRING+=",LINKEDIN_ACCESS_TOKEN=linkedin-access-token:latest,LINKEDIN_AD_ACCOUNT_ID=linkedin-ad-account-id:latest,LINKEDIN_CONVERSION_ID=linkedin-conversion-id:latest"
fi
if [ "$HAS_OPENAI_PIXEL_CONVERSIONS" = "1" ]; then
  SECRETS_WIRING+=",OPENAI_PIXEL_ID=openai-pixel-id:latest,OPENAI_PIXEL_API_KEY=openai-pixel-api-key:latest"
fi

# spec-21: --update-secrets is a MERGE, not a replace — so a conversion group's
# secret env-refs LINGER on the live service after the group is disabled (e.g. a
# secret loses its accessible `latest` version). The next deploy then FAILS creating
# the revision, because Cloud Run re-validates the stale `:latest` ref that
# --update-secrets never removed — the linkedin-ad-account-id / linkedin-conversion-id
# prod incident: the guard above correctly stopped ADDING them, but the old refs
# stayed wired on memex-api. So for every DISABLED group, explicitly REMOVE its keys.
# gcloud applies --remove-secrets BEFORE --update-secrets, and an enabled group is
# never in this list, so the two never fight; removing an absent key is a no-op.
REMOVE_CONVERSION_SECRETS=""
if [ "$HAS_GOOGLE_ADS_CONVERSIONS" != "1" ]; then
  REMOVE_CONVERSION_SECRETS+=",GOOGLE_ADS_CLIENT_ID,GOOGLE_ADS_CLIENT_SECRET,GOOGLE_ADS_REFRESH_TOKEN,GOOGLE_ADS_DEVELOPER_TOKEN,GOOGLE_ADS_CUSTOMER_ID,GOOGLE_ADS_CONVERSION_ACTION_ID"
fi
if [ "$HAS_LINKEDIN_CONVERSIONS" != "1" ]; then
  REMOVE_CONVERSION_SECRETS+=",LINKEDIN_ACCESS_TOKEN,LINKEDIN_AD_ACCOUNT_ID,LINKEDIN_CONVERSION_ID"
fi
if [ "$HAS_OPENAI_PIXEL_CONVERSIONS" != "1" ]; then
  REMOVE_CONVERSION_SECRETS+=",OPENAI_PIXEL_ID,OPENAI_PIXEL_API_KEY"
fi
REMOVE_CONVERSION_SECRETS="${REMOVE_CONVERSION_SECRETS#,}"  # strip leading comma

# HIDDEN_FEATURES is appended to --update-env-vars ONLY when it is set (see
# deploy-config.sh): ${HIDDEN_FEATURES+...} expands to the entry when set
# (including an explicit empty value — a deliberate un-hide) and to nothing when
# unset. An unset value is therefore OMITTED, so the Cloud Run --update-env-vars
# MERGE leaves the live setting intact rather than blanking it — a deploy from a
# checkout that never set the value can't silently un-hide features (spec-168
# dec-4). The ${var+...} form is safe under `set -u`.
# Resource/scaling flags are re-asserted every deploy: gcloud reverts anything a deploy
# doesn't restate, so a console-set value silently disappears on the next deploy (std-26 §6
# cl-136, spec-489). --memory/--concurrency/--cpu-boost restate the current live values so they
# survive. --min-instances/--max-instances are ENV-KEYED per-env (spec-518): MIN_INSTANCES /
# MAX_INSTANCES come from the memex-<env>-deploy-env secret and default to 0/3 (today's
# behaviour) when unset, so prod and int can differ and the live scaling can't drift from
# config. Budget invariant (spec-518 t-7) — now ASSERTED, in Steps 3b and 4b, not merely stated
# here. The single-term form this comment used to carry (MAX_INSTANCES × (DB_POOL_MAX + 1) < ~47)
# was not wrong, it was a sum with terms missing, and it was green throughout BOTH of this Spec's
# incidents:
#     Σ over every Cloud Run service on this Cloud SQL instance of
#       2 × MAX_INSTANCES × (DB_POOL_MAX + 1 relay LISTEN)   +   admin reserve
#     ≤ max_connections − superuser_reserved − reserved      (read from Postgres, not from gcloud)
# The 2× is the cutover: a draining revision holds its pool while serving nothing, so a deploy is
# the one moment the budget must hold twice over — and the only moment anyone changes the config.
# Prod today: 2×8×(4+1)=80 + backstage 2×3×(10+1)=66 + admin 5 = 151 against 197 usable (dec-2
# raised max_connections 50 → 200 on 2026-08-12; the old ~47 is what the 2026-08-03 FATAL and the
# 2026-08-11 outage were measured against). DB_POOL_MAX is the per-env pool cap (prod=4 under
# maxScale 8; spec-489/spec-518/spec-332); omitted when unset.
# MEMEX_EMISSION_* (spec-525 t-6) are the admission gate's knobs: GATE_MODE (shadow|enforcing —
# default shadow, the SAFE one, so a wiring mistake under-protects rather than silently
# enforcing untuned limits), WAIT_MS and MAX_WAITERS. All three optional; unset means the code
# default. The CEILING is absent on purpose — ac-12 requires it derived from DB_POOL_MAX, and a
# hand-set one is a number someone raises during a busy week. Guarded by
# spec-525-gate-knobs.regression.test.ts so a dropped entry fails CI, not production.
gcloud run deploy "${SERVICE}" \
  --image "${IMAGE}" \
  --platform managed \
  --region "${REGION}" \
  --project "${GCP_PROJECT}" \
  ${SERVICE_ACCOUNT:+--service-account=${SERVICE_ACCOUNT}} \
  --allow-unauthenticated \
  --port 8080 \
  --memory 512Mi \
  --min-instances "${MIN_INSTANCES:-0}" \
  --max-instances "${MAX_INSTANCES:-3}" \
  --concurrency 80 \
  --cpu-boost \
  --add-cloudsql-instances "${CLOUD_SQL_INSTANCE_CONN}" \
  --update-env-vars "^|^NODE_ENV=production|DATABASE_URL=postgresql://${RUNTIME_DB_USER}:${RUNTIME_DB_PASS_ENC}@localhost:${DB_PORT}/${DB_NAME}|CLOUD_SQL_SOCKET=/cloudsql/${CLOUD_SQL_INSTANCE_CONN}|GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}|EMAIL_FROM=${EMAIL_FROM}|APP_BASE_URL=${APP_BASE_URL}|OAUTH_ENABLED=1|MEMEX_RLS_GUARD_THROW=1|SLACK_CLIENT_ID=${SLACK_CLIENT_ID}|SLACK_OAUTH_REDIRECT_URI=${API_BASE_URL}/api/auth/slack/callback|KMS_KEY_NAME=projects/${GCP_PROJECT}/locations/${REGION}/keyRings/memex/cryptoKeys/slack-tokens${DB_POOL_MAX+|DB_POOL_MAX=${DB_POOL_MAX}}${HIDDEN_FEATURES+|HIDDEN_FEATURES=${HIDDEN_FEATURES}}${SIGNUP_DOMAIN_ALLOWLIST+|SIGNUP_DOMAIN_ALLOWLIST=${SIGNUP_DOMAIN_ALLOWLIST}}${STRIPE_PREMIUM_MONTHLY_PRICE_ID+|STRIPE_PREMIUM_MONTHLY_PRICE_ID=${STRIPE_PREMIUM_MONTHLY_PRICE_ID}}${STRIPE_PREMIUM_ANNUAL_PRICE_ID+|STRIPE_PREMIUM_ANNUAL_PRICE_ID=${STRIPE_PREMIUM_ANNUAL_PRICE_ID}}${STRIPE_ENTERPRISE_MONTHLY_PRICE_ID+|STRIPE_ENTERPRISE_MONTHLY_PRICE_ID=${STRIPE_ENTERPRISE_MONTHLY_PRICE_ID}}${STRIPE_ENTERPRISE_ANNUAL_PRICE_ID+|STRIPE_ENTERPRISE_ANNUAL_PRICE_ID=${STRIPE_ENTERPRISE_ANNUAL_PRICE_ID}}${OTEL_EXPORTER_OTLP_ENDPOINT+|OTEL_EXPORTER_OTLP_ENDPOINT=${OTEL_EXPORTER_OTLP_ENDPOINT}}${MEMEX_OTEL_EXPORT_INTERVAL_MS+|MEMEX_OTEL_EXPORT_INTERVAL_MS=${MEMEX_OTEL_EXPORT_INTERVAL_MS}}${EMAIL_ACTIVATION_FROM+|EMAIL_ACTIVATION_FROM=${EMAIL_ACTIVATION_FROM}}${EMAIL_ACTIVATION_REPLY_TO+|EMAIL_ACTIVATION_REPLY_TO=${EMAIL_ACTIVATION_REPLY_TO}}${EMAIL_SENDER_NAME+|EMAIL_SENDER_NAME=${EMAIL_SENDER_NAME}}${ACTIVATION_EMAILS_ENABLED+|ACTIVATION_EMAILS_ENABLED=${ACTIVATION_EMAILS_ENABLED}}${ACTIVATION_CONNECT_GO_LIVE+|ACTIVATION_CONNECT_GO_LIVE=${ACTIVATION_CONNECT_GO_LIVE}}${STORAGE_PROVIDER+|STORAGE_PROVIDER=${STORAGE_PROVIDER}}${STORAGE_GCS_BUCKET+|STORAGE_GCS_BUCKET=${STORAGE_GCS_BUCKET}}${MEMEX_EMISSION_GATE_MODE+|MEMEX_EMISSION_GATE_MODE=${MEMEX_EMISSION_GATE_MODE}}${MEMEX_EMISSION_WAIT_MS+|MEMEX_EMISSION_WAIT_MS=${MEMEX_EMISSION_WAIT_MS}}${MEMEX_EMISSION_MAX_WAITERS+|MEMEX_EMISSION_MAX_WAITERS=${MEMEX_EMISSION_MAX_WAITERS}}" \
  --update-secrets "${SECRETS_WIRING}" \
  ${REMOVE_CONVERSION_SECRETS:+--remove-secrets="${REMOVE_CONVERSION_SECRETS}"}

# ── Step 4b: assert what the deploy ACTUALLY applied (spec-518 t-7) ──
# Every check that runs before this line reads the SOURCE — this file's flag syntax,
# deploy-config.sh's exports, the budget arithmetic in a regression test. All of them were green
# throughout the 2026-08-03 and 2026-08-11 incidents, because none of them can observe what
# reached the running revision. This one reads the OUTCOME: it resolves the revision traffic is
# actually on (never spec.template, which is intent), compares every value config SET against
# what that revision carries, and re-checks the connection budget on the numbers in force,
# summed over EVERY Cloud Run service attached to this Cloud SQL instance (`backstage` included —
# it carries no pool cap and appeared in no arithmetic until now, spec-518 issue-2).
#
# Deliberately AFTER the cutover: what was applied cannot be known before applying it. So this
# gate is loud, not preventive — on a mismatch, roll back by re-running the deploy workflow
# (workflow_dispatch) against the previous SHA. A mismatch aborts in EVERY environment: a value
# set in config that did not arrive is a plumbing defect with no environmental excuse, and int is
# where it must be caught, since int deploys first.
#
# Placed BEFORE Step 5, so an abort here also skips the post-cutover data backfills. That is
# acceptable and deliberate: 1d/1f are idempotent and resume on the next deploy (spec-417 dec-6),
# and a deploy whose applied configuration is wrong should not go on to do more work.
DB_URL="${DB_URL}" pnpm run deploy:verify-scaling -- --mode=applied

# ── Step 5: Post-cutover data backfills (spec-417 dec-6) ──────
# The new revision is now serving 100% of traffic. These DATA backfills/generation
# steps (formerly 1c–1f inside the migration step) seed/decorate EXISTING rows and
# are NOT required for the new code to boot — so they run HERE, off the
# old-revision-vs-new-schema window that caused the 2026-06-26 outage (issue-1).
# Each stays bounded (`timeout 600`) + non-gating (`|| echo`) exactly as before, so a
# failure/timeout never aborts the (already-live) deploy and the next deploy resumes
# idempotently. The cloud-sql-proxy from Step 3 is still up; DB_URL is still valid.
# These run before the caller's post-deploy smoke, which only costs the smoke FLAG
# some wall-clock on a heavy first-run backfill — traffic is already live and healthy,
# so there is no downtime. (Moving them after smoke would mean re-plumbing the proxy +
# DB creds in the root deploy.sh; the fully-async form is dec-6 option 1, deferred.)
echo ""
echo "Running post-cutover data backfills (ENV=${ENV})..."

# 1c. REMOVED by spec-474 — the Handhold onboarding demo is deleted. The old auto-backfill
# (spec-178 t-5 / ac-28) seeded the demo into existing Memexes on every deploy; that
# capability, its `db:backfill-handhold` script, and the fixture are all gone. Existing
# demo docs are reconciled once by the operator-run demo→starter sweep
# (`pnpm --filter @memex/server db:sweep-demo-to-starter`), which is deliberately NOT
# wired here — it must be dry-run-rehearsed against a restored snapshot first (spec-474 ac-9).

# 1d. spec-184 t-4 / ac-15 — backfill the default Standards into EXISTING personal
# Memexes (namespaces.kind='user') whose Standards list is still empty. New signups
# already get them via the post-commit hook in ensureUserNamespace; this is the
# one-time catch-up. seedDefaultStandards is per-Memex idempotent (no-ops once a Memex
# holds any standard — and so never overwrites a user's own Standards, dec-4 empty-list
# scope), so it does zero work after the first pass and is safe to run on every deploy
# in BOTH environments. Bounded + non-gating like 1c: `timeout` caps the run and `|| echo`
# swallows a timeout (124) or any error so `set -e` can never abort a live deploy.
echo "  1d. default Standards backfill (spec-184 t-4 / ac-15)..."
DATABASE_URL="${DB_URL}" timeout 600 pnpm db:backfill-default-standards \
  || echo "  ⚠ default-standards backfill timed out or failed (non-gating, exit $?) — deploy continues; next deploy resumes (idempotent)."


# 1f. spec-200 t-3 / ac-8 — generate "What's New" feed entries for Specs newly
# shipped to prod. dec-2: this runs at the daily promotion so the feed tracks
# what's actually live; dec-3: it sources the global memex (mindset-prod/
# memex-building-itself) — on INT, where that memex doesn't exist, the script
# no-ops. dec-1: entries publish straight to the feed (no human approval).
#
# Bounded + non-gating, exactly like 1c/1d/1e — AND specifically hardened against
# the spec-178 t-5 hang: runWhatsNewGeneration skips already-published Specs
# BEFORE any LLM call and caps new entries per run (MAX_PER_RUN), so the daily
# cost is just today's promotions and the first backfill resumes idempotently.
# A missing Anthropic key just means no drafts land (next deploy retries) — it
# never fails the deploy.
#
# The Anthropic key is wired into the Cloud Run SERVICE at step 4 (--set-secrets),
# but that wiring never reaches THIS deploy-phase shell on the CI runner, where
# the generation script actually runs. So fetch it from Secret Manager here, the
# same way scripts/deploy-config.sh sources DB_PASS (`versions access`). Guarded
# with `|| true` so a fetch hiccup can't trip `set -e` and abort the deploy — an
# empty key just yields no drafts, exactly like the missing-key case above. The
# secret's existence is already asserted in the pre-flight block.
ANTHROPIC_API_KEY="$(gcloud secrets versions access latest --secret=anthropic-api-key --project="${GCP_PROJECT}" 2>/dev/null)" || true
echo "  1f. What's New generation (spec-200 t-3 / ac-8)..."
DATABASE_URL="${DB_URL}" ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY}" timeout 600 pnpm db:generate-whats-new \
  || echo "  ⚠ What's New generation timed out or failed (non-gating, exit $?) — deploy continues; next deploy resumes (idempotent)."

# Tear down the cloud-sql-proxy started in Step 3 (kept alive across the cutover).
kill $PROXY_PID 2>/dev/null
wait $PROXY_PID 2>/dev/null || true

echo "Post-cutover data backfills complete."

# ── Done ──────────────────────────────────────────────────────
URL=$(gcloud run services describe "${SERVICE}" --region "${REGION}" --project "${GCP_PROJECT}" --format='value(status.url)')
echo ""
echo "Deployed to: $URL"
echo "Health check: $URL/api/health"
echo "MCP endpoint: $URL/mcp"
echo "Public host:  ${API_BASE_URL} (when DNS / domain mapping lands — see b-9 t-5)"
