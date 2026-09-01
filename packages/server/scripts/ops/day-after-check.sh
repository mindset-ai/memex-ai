#!/usr/bin/env bash
# spec-520 — the day-after check. Things that could not be observed on deploy day.
#
# Read-only. Answers four questions the first 24 hours make answerable:
#   1. Are rows routing to a DAILY partition now? (yesterday everything went to legacy)
#   2. Is n_tup_del still frozen across a full day of traffic? (ac-13, now unarguable)
#   3. Is the table growing at the predicted rate? (dec-9 was corrected to ~5M/day, c-21)
#   4. Is there traffic RIGHT NOW, i.e. can the ac-4 after-measurement be taken?
set -uo pipefail
cd "$(dirname "$0")/../../../.."
export ENV=prod DEPLOY_CONFIG_PROJECT=memex-ai-prod
source scripts/deploy-config.sh || exit 1
PORT=15459
cloud-sql-proxy "$CLOUD_SQL_INSTANCE_CONN" --port "$PORT" >/dev/null 2>&1 &
P=$!; trap 'kill $P 2>/dev/null || true' EXIT
for i in $(seq 1 30); do
  PGPASSWORD="$DB_PASS" psql -h 127.0.0.1 -p "$PORT" -U "$DB_USER" -d "$DB_NAME" -c 'SELECT 1' >/dev/null 2>&1 && break
  sleep 1
done
Q() { PGPASSWORD="$DB_PASS" psql -q -h 127.0.0.1 -p "$PORT" -U "$DB_USER" -d "$DB_NAME" -c "SET default_transaction_read_only=on; $1"; }

echo "══ 1. WHERE ARE ROWS LANDING NOW? (yesterday: all in test_events_legacy) ══"
Q "SELECT tableoid::regclass::text AS partition, count(*),
          min(created_at)::timestamp(0) AS oldest, max(created_at)::timestamp(0) AS newest
   FROM test_events GROUP BY 1 ORDER BY 3 DESC NULLS LAST LIMIT 6;"
echo "   A daily partition (test_events_YYYYMMDD) holding recent rows = routing works past the boundary."

echo ""
echo "══ 2. ac-13 — n_tup_del across a full day of traffic ══"
Q "SELECT sum(n_tup_ins) AS ins, sum(n_tup_del) AS del, sum(n_live_tup) AS live, count(*) AS relations
   FROM pg_stat_user_tables WHERE relname='test_events' OR relname LIKE 'test\_events\_%';"
echo "   del was 38,723,340 on 2026-08-31 (c-22/c-23). Unchanged after a day of traffic"
echo "   is the strongest form this evidence can take."

echo ""
echo "══ 3. growth rate — dec-9 was corrected to ~5M rows/day (c-21) ══"
Q "SELECT date_trunc('day', created_at)::date AS day, count(*),
          pg_size_pretty(sum(pg_column_size(t.*))) AS approx_bytes
   FROM test_events t GROUP BY 1 ORDER BY 1 DESC LIMIT 5;"

echo ""
echo "══ 4. is there traffic RIGHT NOW? (ac-4's after-measurement needs an active window) ══"
Q "SELECT count(*) FILTER (WHERE created_at > now() - interval '5 minutes')  AS last_5min,
          count(*) FILTER (WHERE created_at > now() - interval '60 minutes') AS last_hour
   FROM test_events;"
echo "   last_5min in the hundreds → run prod-emission-delta.sh 300 now."
echo "   near zero → still idle; the after-measurement would read ~0% and mean nothing (c-23)."
