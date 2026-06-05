#!/bin/bash
set -euo pipefail

# ── PAM requirement ───────────────────────────────────────────
# This script requires a PAM grant on:
#   memex-int-deploy-admin  (when ENV=int)
#   memex-prod-deploy-admin (when ENV=prod)
# Eligibility: domain:mindset.ai. Max duration: 2h. Request a grant via
# `gcloud pam grants create` before running. See README.md for details.
# Adding new GCS buckets or LB/CDN resources may require a PAM update —
# contact support@memex.ai before merging.

# All env-specific values come from scripts/deploy-config.sh.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PKG_DIR="${REPO_ROOT}/packages/admin"
cd "${PKG_DIR}"
source "${REPO_ROOT}/scripts/deploy-config.sh"

# ── Step 1: Build ─────────────────────────────────────────────
echo "Building admin SPA (ENV=${ENV})..."
VITE_API_URL="${API_BASE_URL}/api" \
VITE_GOOGLE_CLIENT_ID="${GOOGLE_CLIENT_ID}" \
  pnpm run build

# ── Step 2: Deploy to GCS ─────────────────────────────────────
echo "Deploying to ${STATIC_BUCKET}..."

# Assets have content hashes in filenames — cache forever
gcloud storage rsync dist/assets/ "${STATIC_BUCKET}/assets/" \
  --recursive \
  --delete-unmatched-destination-objects \
  --project "${GCP_PROJECT}" \
  --cache-control="public, max-age=31536000, immutable"

# index.html must never be cached — always fetch latest
gcloud storage cp dist/index.html "${STATIC_BUCKET}/index.html" \
  --project "${GCP_PROJECT}" \
  --cache-control="no-cache, no-store, must-revalidate"

# Other top-level static files from dist/ (favicon.svg, robots.txt, …). Vite copies anything
# under packages/admin/public/ into the dist/ root; they don't have content-hashed names, so
# cache moderately (1 day) and rely on CDN invalidation for updates.
for f in dist/*; do
  base=$(basename "$f")
  if [[ -f "$f" && "$base" != "index.html" ]]; then
    gcloud storage cp "$f" "${STATIC_BUCKET}/$base" \
      --project "${GCP_PROJECT}" \
      --cache-control="public, max-age=86400"
  fi
done

# ── Step 3: Invalidate CDN cache ──────────────────────────────
echo "Invalidating CDN cache (${URL_MAP_NAME})..."
gcloud compute url-maps invalidate-cdn-cache "${URL_MAP_NAME}" --path="/*" --project "${GCP_PROJECT}" || \
  echo "  (skipping invalidate — url-map ${URL_MAP_NAME} not yet provisioned in ${GCP_PROJECT}; see b-9 t-5)"

echo ""
echo "Deployed to: ${APP_BASE_URL}"
