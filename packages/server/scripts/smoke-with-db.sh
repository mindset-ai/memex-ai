#!/usr/bin/env bash
# Wrapper that runs the post-deploy smoke suite with DB-aware probes enabled.
#
# The default smoke suite (`make smoke-int` / `make smoke-prod`) is pure HTTP
# and intentionally needs no DB credentials. This wrapper additionally spins
# up a cloud-sql-proxy to the env's Cloud SQL instance and exports
# SMOKE_DATABASE_URL so the telemetry-smoke tier
# (src/__smoke__/telemetry.smoke.test.ts) can verify that MCP tool calls
# actually land rows in mcp_tool_calls — the contract pure-HTTP smoke can't
# check.
#
# Usage (from repo root):
#   bash packages/server/scripts/smoke-with-db.sh int
#   bash packages/server/scripts/smoke-with-db.sh prod
#
# Prerequisites mirror the main deploy script:
#   - cloud-sql-proxy on PATH (`brew install google-cloud-sdk` + the proxy)
#   - psql on PATH (for the proxy connection; node's `postgres` package handles
#     the actual queries, psql is only used by the deploy migration path)
#   - PAM grant on `memex-{env}-deploy-server` (same as `make deploy-server` —
#     the smoke uses the cloudsql.client role from that entitlement).
#
# Skip-when-unconfigured behaviour:
#   The telemetry-smoke tier itself skips when SMOKE_MCP_TOKEN is unset, so
#   this wrapper is only useful when you ALSO have a smoke MCP token. Without
#   one, fall back to plain `make smoke-int` / `make smoke-prod`.

set -euo pipefail

ENV="${1:-}"
if [ "$ENV" != "int" ] && [ "$ENV" != "prod" ]; then
  echo "usage: $0 <int|prod>" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PKG_DIR="${REPO_ROOT}/packages/server"

# Source env-specific values (DB_USER, DB_PASS, CLOUD_SQL_INSTANCE_CONN, etc.).
export ENV
source "${REPO_ROOT}/scripts/deploy-config.sh"

# Throwaway local port for the proxy. Distinct from the deploy script's
# 15432 so a deploy-in-progress doesn't collide with a smoke run.
PROXY_PORT=15440

# Tear down any stale proxy on our port (a previous failed run, or a still-
# running deploy that picked the same port via different convention).
lsof -ti tcp:${PROXY_PORT} 2>/dev/null | xargs kill -9 2>/dev/null || true

echo "▶ Starting cloud-sql-proxy → ${CLOUD_SQL_INSTANCE_CONN} on localhost:${PROXY_PORT}..."
cloud-sql-proxy "${CLOUD_SQL_INSTANCE_CONN}" --port ${PROXY_PORT} >/tmp/smoke-proxy.${ENV}.log 2>&1 &
PROXY_PID=$!

# Always kill the proxy on exit, even if smoke fails or this script is Ctrl-C'd.
trap 'kill ${PROXY_PID} 2>/dev/null || true' EXIT INT TERM

# Wait for the proxy to actually be listening. The proxy prints
# "ready for new connections" on startup; tail the log to detect it.
for i in $(seq 1 30); do
  if grep -q "ready for new connections" /tmp/smoke-proxy.${ENV}.log 2>/dev/null; then
    break
  fi
  sleep 0.5
  if [ $i -eq 30 ]; then
    echo "✗ cloud-sql-proxy did not become ready in 15s. Log tail:" >&2
    tail -20 /tmp/smoke-proxy.${ENV}.log >&2
    exit 1
  fi
done
echo "  ✓ proxy ready"

# URL-encode DB_PASS so symbols in the password survive postgresql:// parsing.
DB_PASS_ENC=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "${DB_PASS}")
export SMOKE_DATABASE_URL="postgresql://${DB_USER}:${DB_PASS_ENC}@localhost:${PROXY_PORT}/${DB_NAME}"
export SMOKE_ENV="${ENV}"
export SMOKE_BASE_URL="https://${PUBLIC_HOST}"

echo "▶ Running smoke suite (env=${ENV}, db-aware)..."
cd "${PKG_DIR}"
pnpm smoke
