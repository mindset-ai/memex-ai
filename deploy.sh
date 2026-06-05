#!/bin/bash
set -euo pipefail

# Top-level deploy — runs server + admin in sequence. Driven by ENV (default int).
#   make deploy              # int
#   ENV=prod make deploy     # prod

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${REPO_ROOT}/scripts/deploy-config.sh"

echo "═══════════════════════════════════════════════"
echo "  Memex — Full Deploy (Server + UI)"
echo "  ENV=${ENV}  project=${GCP_PROJECT}  host=${PUBLIC_HOST}"
echo "═══════════════════════════════════════════════"
echo ""

# Server (migrations + Cloud Run)
echo "▶ Deploying server..."
echo ""
cd "${REPO_ROOT}/packages/server"
bash deploy.sh

echo ""
echo "═══════════════════════════════════════════════"
echo ""

# UI (build + GCS + CDN)
echo "▶ Deploying UI..."
echo ""
cd "${REPO_ROOT}/packages/ui"
bash deploy.sh

echo ""
echo "═══════════════════════════════════════════════"
echo "  Deploy complete (ENV=${ENV})"
echo "  API:   ${API_BASE_URL}"
echo "  UI:    ${APP_BASE_URL}"
echo "═══════════════════════════════════════════════"

# Post-deploy smoke (b-70 dec-4). Runs AFTER server + admin land — traffic is
# already live, so this FLAGS a bad deploy rather than gating it: a red smoke
# means roll back. Exits non-zero so a broken deploy is loud and obvious.
#
# The public tier always runs; the authed write tier (b-70 t-8) skips cleanly
# when SMOKE_MCP_TOKEN is unset, so this tail stays green where creds are absent.
echo ""
echo "▶ Post-deploy smoke (make smoke-${ENV})..."
echo ""
cd "${REPO_ROOT}"
if make "smoke-${ENV}"; then
  echo ""
  echo "═══════════════════════════════════════════════"
  echo "  ✓ Smoke passed (ENV=${ENV})"
  echo "═══════════════════════════════════════════════"
else
  echo ""
  echo "═══════════════════════════════════════════════"
  echo "  ✗ SMOKE FAILED (ENV=${ENV}) — traffic is LIVE."
  echo "    Investigate / roll back immediately."
  echo "═══════════════════════════════════════════════"
  exit 1
fi
