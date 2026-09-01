#!/usr/bin/env bash
# spec-520 t-14 — POSITIVELY verify AC emission after a deploy. int first, then prod.
#
#   MEMEX_EMIT_KEY=mxk_... ./verify-emission-landed.sh int|prod
#
# ⚠ WHY "NO ALARM FIRED" IS NOT EVIDENCE. spec-520 modifies the machinery by which every
# AC on every Spec reports whether it passes. Break it and the failure HIDES ITSELF:
# emissions stop landing, the board keeps showing the last known state, and "no ACs went
# red" reads as "nothing broke". The emitter swallows its own errors by design (std-48 —
# telemetry must never fail CI), so the client cannot tell you either. The only honest
# check is to emit a known event and confirm it arrived, in all three tiers.
#
# It also covers the failure mode partitioning introduced: a row whose created_at finds no
# partition is REJECTED. That shows up as a non-201 on the POST — loud, but only if
# somebody looks.
set -uo pipefail
ENVNAME="${1:-}"
case "$ENVNAME" in
  int)  BASE="https://int.memex.ai";  NS="mindset-int" ;;
  prod) BASE="https://memex.ai";      NS="mindset-prod" ;;
  *) echo "usage: MEMEX_EMIT_KEY=... $0 int|prod"; exit 2 ;;
esac
[ -n "${MEMEX_EMIT_KEY:-}" ] || { echo "MEMEX_EMIT_KEY is required (provision_ac_emission)"; exit 2; }
cd "$(dirname "$0")/../../../.."

AC="${AC_REF:-${NS}/memex-building-itself/specs/spec-520/acs/ac-14}"
MARK="post-deploy-verify::$(date -u +%Y%m%dT%H%M%SZ)"

echo "══ 1. emit a known event through the REAL ingest path ══"
echo "   ac  = $AC"
echo "   tid = $MARK"
BODY=$(mktemp)
CODE=$(curl -s -o "$BODY" -w '%{http_code}' -X POST "$BASE/api/test-events" \
  -H "Authorization: Bearer $MEMEX_EMIT_KEY" -H 'Content-Type: application/json' \
  -d "{\"ac_uid\":\"$AC\",\"status\":\"pass\",\"test_identifier\":\"$MARK\",\"duration_ms\":1}")
echo "   HTTP $CODE"
if [ "$CODE" != "201" ]; then
  echo "   ✗ THE INGEST PATH IS BROKEN. Body:"; sed 's/^/     /' "$BODY"; rm -f "$BODY"
  echo "   After a partitioning deploy, suspect first: 'no partition of relation found for"
  echo "   row' — the forward horizon ran out and maintenance has not run."
  exit 1
fi
rm -f "$BODY"; echo "   ✓ accepted"

echo ""
echo "══ 2. confirm it LANDED in all three tiers (201 only proves the route accepted it) ══"
export ENV="$ENVNAME" DEPLOY_CONFIG_PROJECT="memex-ai-${ENVNAME}"
source scripts/deploy-config.sh || { echo "   deploy-config failed"; exit 1; }
PORT=15453
cloud-sql-proxy "$CLOUD_SQL_INSTANCE_CONN" --port "$PORT" >/dev/null 2>&1 &
PROXY=$!; trap 'kill $PROXY 2>/dev/null || true' EXIT
for i in $(seq 1 30); do
  PGPASSWORD="$DB_PASS" psql -h 127.0.0.1 -p "$PORT" -U "$DB_USER" -d "$DB_NAME" -c 'SELECT 1' >/dev/null 2>&1 && break
  sleep 1
done
PGPASSWORD="$DB_PASS" psql -h 127.0.0.1 -p "$PORT" -U "$DB_USER" -d "$DB_NAME" <<SQL
SET default_transaction_read_only = on;
\echo '  -- tier 1: the raw log, and WHICH PARTITION it routed to --'
SELECT tableoid::regclass::text AS partition, status, created_at FROM test_events WHERE test_identifier = '${MARK}';
\echo '  -- tier 2: the summary the badge reads --'
SELECT latest_status, latest_run_at, run_count FROM test_event_latest WHERE test_identifier = '${MARK}';
\echo '  -- tier 3: the per-day rollup the charts read --'
SELECT day, run_count, pass_count FROM test_run_daily WHERE test_identifier = '${MARK}';
SQL

echo ""
echo "  A MISSING tier is the interesting failure:"
echo "    no tier 1 → the insert was rejected (partition? RLS?)"
echo "    no tier 2 → applyEmissionToSummary failed; the badge goes stale silently"
echo "    no tier 3 → the rollup upsert failed; both history charts flatten with no error"
echo ""
echo "  ⚠ THEN RETIRE THE PROBE, or it lingers as a fake test on the AC (std-48):"
echo "    discontinue_test_events(ref: '$AC', test_identifier: '$MARK')"
echo "    (each retirement is a real row delete — it is why n_tup_del ticks up by a few a day)"
