#!/usr/bin/env bash
# spec-563 t-2 — apply out-of-band/0145 to PRODUCTION, before the develop→main promotion.
#
# ⚠ THIS IS A WORKED EXAMPLE, NOT A GENERAL TOOL. It is pinned to 0145 and has already
# been run (prod, 2026-09-12: 64 partitions, 64 attached, indisvalid = t). It is kept
# because `out-of-band/` migrations are applied BY HAND and rebuilding the proxy-and-psql
# scaffolding from scratch each time is where mistakes get made — not because it adapts.
# COPY it for the next out-of-band migration and change the SQL path, the port, and the
# freshness guard; do not parameterise it into something that looks safe to run blind.
#
# What the next copy should keep, because each line cost something to learn:
#   • the freshness guard — refuse to run a checkout older than the SQL file's own guard
#   • a distinct proxy port — 15432=deploy, 15440=smoke, 15450/15451/15452 taken by spec-563
#   • a BEFORE readout, so "nothing to do" and "not yet done" are distinguishable
#   • tee to a file — the verification table is the deliverable, not the scrollback
#
# WHAT THIS DOES. Builds the expression index behind the activity footer's spec filter
# CONCURRENTLY, one partition at a time, then ATTACHes each to the parent. Concurrent
# builds block no writes, which matters here more than usual: test_events takes ~31
# events/s from a client with a 5 s timeout that NEVER retries (std-48), so a blocked
# emission is DISCARDED, not delayed. 0111 held ACCESS EXCLUSIVE on this table for ~80 s
# and deadlocked a prod deploy on its first attempt.
#
# ⚠ ORDER. This runs BEFORE 0146 reaches prod — i.e. before the develop→main promotion.
# Run it after, and the 61 concurrent builds SUCCEED under different names while every
# ATTACH fails, leaving 61 orphan duplicate indexes attached to nothing, each costing a
# tuple per insert forever. 0145 refuses in that situation (measured, spec-563 #714), so
# the worst case here is a clean refusal — but the refusal is the safety net, not the plan.
#
# ⚠ THIS IS A WRITE. Unlike the read-only EXPLAIN probe, no default_transaction_read_only
# is set. Expect it to take minutes: ~5.7 M rows across 61 partitions, each scanned twice
# by a concurrent build.
#
# ⚠ DO NOT INTERRUPT IT. An aborted CONCURRENTLY build leaves an INVALID index behind that
# the planner silently ignores — the deploy would then "succeed" and change nothing. §4 of
# the SQL file reports indisvalid; 0146 also refuses to proceed on an invalid index.
#
# PREREQUISITE: PAM entitlement `memex-prod-deploy-server` (2h max).
#
# AFTERWARDS, before promoting: confirm the final row reads
#   is_valid = t   and   partitions = attached_indexes

set -euo pipefail

REPO_ROOT="/home/fcooker/Projects/Companies/Mindset.ai/Apps/gitlabs/memex-ai"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SQL="${HERE}/../drizzle/out-of-band/0145_spec563_activity_footer_index_prep.sql"
PROXY_PORT=15451          # 15432=deploy, 15440=smoke, 15450=the spec-563 EXPLAIN probe

[ -f "$SQL" ] || { echo "✗ introuvable: $SQL" >&2; exit 1; }
# The guard and ON_ERROR_STOP only exist post-#714. Running an older copy of this file is
# exactly the failure mode the guard was written for, so refuse rather than trust the path.
grep -q 'REFUSE TO RUN AFTER 0146' "$SQL" || {
  echo "✗ $SQL predates the #714 order guard. Update the checkout before running this." >&2
  exit 1
}

export ENV=prod
export DEPLOY_CONFIG_PROJECT=memex-ai-prod   # REQUIRED — deploy-config.sh aborts without it
source "${REPO_ROOT}/scripts/deploy-config.sh"

echo "▶ cloud-sql-proxy → ${CLOUD_SQL_INSTANCE_CONN} on localhost:${PROXY_PORT}"
cloud-sql-proxy "${CLOUD_SQL_INSTANCE_CONN}" --port ${PROXY_PORT} >/tmp/spec563-0145-proxy.log 2>&1 &
PROXY_PID=$!
trap 'kill ${PROXY_PID} 2>/dev/null || true' EXIT

for _ in $(seq 1 30); do
  grep -q "ready for new connections" /tmp/spec563-0145-proxy.log && break
  sleep 0.5
done
grep -q "ready for new connections" /tmp/spec563-0145-proxy.log || {
  echo "✗ proxy not ready:"; tail -20 /tmp/spec563-0145-proxy.log; exit 1; }

echo "▶ BEFORE — current state of the index on prod:"
PGPASSWORD="${DB_PASS}" psql -h 127.0.0.1 -p ${PROXY_PORT} -U "${DB_USER}" -d "${DB_NAME}" \
  -tAc "SELECT COALESCE((SELECT count(*)::text FROM pg_inherits pi JOIN pg_class p ON p.oid=pi.inhparent WHERE p.relname='test_events_memex_spec_handle_created_idx'), '0') || ' partition indexes attached (0 = not yet built, which is what we want)'"

echo "▶ applying 0145 — minutes, do NOT interrupt"
PGPASSWORD="${DB_PASS}" psql -h 127.0.0.1 -p ${PROXY_PORT} -U "${DB_USER}" -d "${DB_NAME}" \
  -f "$SQL" 2>&1 | tee "${HERE}/../../../spec-563-0145-prod.out"

echo
echo "✓ done. The last table above MUST read is_valid = t and partitions = attached_indexes."
echo "  If is_valid is f: a partition build failed. Find it, DROP INDEX CONCURRENTLY it, re-run."
echo "  Only promote develop→main once this is green."
