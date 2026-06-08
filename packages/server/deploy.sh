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
# ELEVENLABS_API_KEY is optional (spec-190 voice guide). Wired ONLY if the secret
# exists, so a deploy never breaks before it's provisioned — voice simply stays
# disabled (isVoiceConfigured() is false) until the secret lands. Create it once
# per project to light voice up (no code change needed):
#   printf %s "<key>" | gcloud secrets create elevenlabs-api-key --data-file=- \
#     --project "${GCP_PROJECT}" --replication-policy=user-managed --locations=us-east4
if gcloud secrets describe elevenlabs-api-key --project "${GCP_PROJECT}" >/dev/null 2>&1; then
  echo "  ✓ elevenlabs-api-key present — voice guide enabled"
  HAS_ELEVENLABS=1
else
  echo "  ⚠ elevenlabs-api-key not found — voice guide disabled (spec-190)"
  HAS_ELEVENLABS=0
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

# ── Step 1: Run database migrations ───────────────────────────
# Two phases, matching the project convention (packages/server/TEST.md):
#   1a. drizzle-kit migrate  → journal-tracked files (0000–0008)
#   1b. apply-hand-migrations.sh → hand-written files (0009+), tracked in manual_migrations
#
# ⚠️  b-36 canonical-refs hard switch: migrations MUST land before the Cloud Run
# revision swap (Step 4 below). The new server resolves entities by canonical
# ref + `seq` columns added in 0052 (doc_comments_seq) and rejects UUID inputs
# at the MCP boundary. Swapping the revision first would leave the old code
# running against a fresh schema (harmless) but the new code running against
# the old schema (broken section / comment lookups). Keep this script's step
# order: migrations → build → push → deploy.
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

echo "  1a. drizzle-kit journal migrations..."
DATABASE_URL="${DB_URL}" pnpm db:migrate

echo "  1b. hand-written migrations..."
DATABASE_URL="${DB_URL}" bash "${PKG_DIR}/scripts/apply-hand-migrations.sh"

# 1c. spec-178 t-5 / ac-28 — backfill the Handhold onboarding demo into EXISTING
# personal Memexes (namespaces.kind='user') that predate the feature. New signups
# already get it via the post-commit hook in ensureUserNamespace; this is the
# one-time catch-up. seedHandholdDemo is per-Memex idempotent (no-ops once a Memex
# holds an is_demo spec), so it does zero work after the first successful pass and
# is safe to run on every deploy. Lives in the shared deploy.sh so it covers BOTH
# environments: INT on each develop deploy, PROD on the daily develop→main promotion.
#
# Bounded + non-gating (learned the hard way — an earlier unbounded version hung the
# deploy to the 30-min job timeout): `timeout` caps the run, and `|| echo` swallows
# BOTH a timeout (exit 124) and any error so `set -e` can never abort a live deploy.
# If the cap is hit mid-backfill the deploy still proceeds and the next deploy resumes
# (idempotent), so partial progress is safe. demo seeding is also off the embedding +
# drift-scan paths now (dec-11 / ac-42), so this is pure fast inserts. `timeout` is
# GNU coreutils — present on the CI ubuntu runner that actually runs this deploy.
echo "  1c. handhold demo backfill (spec-178 t-5 / ac-28)..."
DATABASE_URL="${DB_URL}" timeout 600 pnpm db:backfill-handhold \
  || echo "  ⚠ handhold backfill timed out or failed (non-gating, exit $?) — deploy continues; next deploy resumes (idempotent)."

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

# 1e. spec-190 t-7 / ac-18,ac-20 — import the repo's guide-content/ markdown into
# the guide_content table (the voice guide's knowledge store). Content is imported
# from the SAME commit being deployed, per environment, so the guide never describes
# UI that isn't shipped here (dec-7d). The import is idempotent — upsert by
# source_path + content_hash, so unchanged chunks are never re-embedded — and prunes
# rows whose source file is gone, so it's safe to run on every deploy.
#
# Bounded + non-gating, exactly like 1c/1d: `timeout` caps the run and `|| echo`
# swallows a timeout (124) or any error (incl. a frontmatter validation failure) so
# `set -e` can never abort a live deploy; the next deploy resumes. Embeddings ride on
# resolveEmbeddingProvider() (Cohere default); with no provider rows land vectorless
# and FTS covers (spec-64 posture), so a missing embedding key never fails the deploy.
echo "  1e. guide-content import (spec-190 t-7 / ac-18)..."
DATABASE_URL="${DB_URL}" timeout 600 pnpm db:import-guide-content \
  || echo "  ⚠ guide-content import timed out or failed (non-gating, exit $?) — deploy continues; next deploy resumes (idempotent)."

kill $PROXY_PID 2>/dev/null
wait $PROXY_PID 2>/dev/null || true

echo "Migrations complete."

# ── Step 2: Local build check ────────────────────────────────
echo ""
echo "Running local build check..."
pnpm run build

# ── Step 3: Build and push container ──────────────────────────
echo ""
echo "Building container image (${IMAGE})..."

# Submit from the repo root so the build context includes packages/shared
# (workspace dep of @memex/server). The Dockerfile at the repo root is
# workspace-aware; .gcloudignore there keeps the upload lean.
( cd "${REPO_ROOT}" && gcloud builds submit \
  --tag "${IMAGE}" \
  --project "${GCP_PROJECT}" \
  --region "${REGION}" \
  --default-buckets-behavior=regional-user-owned-bucket )

# ── Step 4: Deploy to Cloud Run ───────────────────────────────
echo ""
echo "Deploying to Cloud Run..."

# Build the secrets wiring string. OPENAI_API_KEY is required for
# semantic code search; COHERE_API_KEY is only wired if the secret exists
# (optional A/B provider for embedding experimentation).
SECRETS_WIRING="ANTHROPIC_API_KEY=anthropic-api-key:latest"
SECRETS_WIRING+=",POSTMARK_SERVER_TOKEN=postmark-server-token:latest"
SECRETS_WIRING+=",AUTH_JWT_SECRET=auth-jwt-secret:latest"
SECRETS_WIRING+=",OPENAI_API_KEY=openai-api-key:latest"
if [ "$HAS_SLACK" = "1" ]; then
  SECRETS_WIRING+=",SLACK_CLIENT_SECRET=slack-client-secret:latest"
fi
if [ "$HAS_COHERE" = "1" ]; then
  SECRETS_WIRING+=",COHERE_API_KEY=cohere-api-key:latest"
fi
if [ "$HAS_ELEVENLABS" = "1" ]; then
  SECRETS_WIRING+=",ELEVENLABS_API_KEY=elevenlabs-api-key:latest"
fi

# HIDDEN_FEATURES is appended to --update-env-vars ONLY when it is set (see
# deploy-config.sh): ${HIDDEN_FEATURES+...} expands to the entry when set
# (including an explicit empty value — a deliberate un-hide) and to nothing when
# unset. An unset value is therefore OMITTED, so the Cloud Run --update-env-vars
# MERGE leaves the live setting intact rather than blanking it — a deploy from a
# checkout that never set the value can't silently un-hide features (spec-168
# dec-4). The ${var+...} form is safe under `set -u`.
gcloud run deploy "${SERVICE}" \
  --image "${IMAGE}" \
  --platform managed \
  --region "${REGION}" \
  --project "${GCP_PROJECT}" \
  --allow-unauthenticated \
  --port 8080 \
  --memory 512Mi \
  --min-instances 0 \
  --max-instances 3 \
  --add-cloudsql-instances "${CLOUD_SQL_INSTANCE_CONN}" \
  --update-env-vars "^|^NODE_ENV=production|DATABASE_URL=postgresql://${DB_USER}:${DB_PASS_ENC}@localhost:${DB_PORT}/${DB_NAME}|CLOUD_SQL_SOCKET=/cloudsql/${CLOUD_SQL_INSTANCE_CONN}|GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}|EMAIL_FROM=${EMAIL_FROM}|APP_BASE_URL=${APP_BASE_URL}|OAUTH_ENABLED=1|SLACK_CLIENT_ID=${SLACK_CLIENT_ID}|SLACK_OAUTH_REDIRECT_URI=${API_BASE_URL}/api/auth/slack/callback|KMS_KEY_NAME=projects/${GCP_PROJECT}/locations/${REGION}/keyRings/memex/cryptoKeys/slack-tokens${HIDDEN_FEATURES+|HIDDEN_FEATURES=${HIDDEN_FEATURES}}${SIGNUP_DOMAIN_ALLOWLIST+|SIGNUP_DOMAIN_ALLOWLIST=${SIGNUP_DOMAIN_ALLOWLIST}}" \
  --update-secrets "${SECRETS_WIRING}"

# ── Done ──────────────────────────────────────────────────────
URL=$(gcloud run services describe "${SERVICE}" --region "${REGION}" --project "${GCP_PROJECT}" --format='value(status.url)')
echo ""
echo "Deployed to: $URL"
echo "Health check: $URL/api/health"
echo "MCP endpoint: $URL/mcp"
echo "Public host:  ${API_BASE_URL} (when DNS / domain mapping lands — see b-9 t-5)"
