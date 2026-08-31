#!/usr/bin/env bash
# spec-520 t-12 — rehearse migration 0142 against a realistic-volume copy UNDER CONCURRENT
# WRITE LOAD, and record the result. This is the AC an agent cannot satisfy alone; it needs
# a database the agent must not touch.
#
# WHY THIS EXISTS AND WHY IT IS NOT OPTIONAL. spec-398's migration 0111 restructured this
# same table and its first production release DEADLOCKED against live traffic (40P01) and
# rolled back — std-39 cl-9's worked example. 0142 is designed so that cannot recur (both
# locks taken up front in the emission path's order, and no row copy at all), and the design
# was measured: ~150 ms of ACCESS EXCLUSIVE at 1.4M rows. But "measured on an idle local
# database" is not "measured under load", and the difference is exactly where 0111 failed.
#
# WHAT IT DOES
#   1. Builds a throwaway database at realistic volume (default 1.5M rows, ~prod).
#   2. Starts N writers hammering the emission shape — INSERT + summary UPSERT in one
#      transaction, in the SAME lock order as routes/test-events.ts.
#   3. Applies 0141 (out-of-band) then 0142 while they run.
#   4. Reports: how long the exclusive window actually took, whether any writer saw a
#      deadlock or a lock timeout, and how many writes were lost.
#
# WHAT TO RECORD ON t-12 AFTERWARDS: the exclusive-window duration, the writer error count
# by SQLSTATE, and the row counts before/after. A rehearsal whose result is not written down
# has not been rehearsed.
#
#   ./scripts/rehearse-test-events-partition.sh [ROWS] [WRITERS] [SECONDS]
#
# Defaults: 1500000 rows, 8 writers, load running throughout the migration.
set -euo pipefail

ROWS="${1:-1500000}"
WRITERS="${2:-8}"
PGPORT_LOCAL="${PGPORT_LOCAL:-5433}"
DB="memex_t12_rehearsal"
PKG_DIR="$(cd "$(dirname "$0")/.." && pwd)"
export PGPASSWORD="${PGPASSWORD:-postgres}"
PSQL="psql -h localhost -p ${PGPORT_LOCAL} -U postgres"
URL="postgresql://postgres:postgres@localhost:${PGPORT_LOCAL}/${DB}"

echo "── building a ${ROWS}-row copy in ${DB} ─────────────────────────────────────"
$PSQL -q -c "DROP DATABASE IF EXISTS ${DB}" postgres
$PSQL -q -c "CREATE DATABASE ${DB}" postgres
for f in "${PKG_DIR}"/drizzle/*.sql; do
  # Stop before the migration under rehearsal — it is applied later, under load.
  case "$f" in *0142_spec520_partition_test_events.sql) break;; esac
  psql -v ON_ERROR_STOP=1 "$URL" -f "$f" >/dev/null
done

psql -q "$URL" <<SQL
INSERT INTO namespaces (slug, kind) VALUES ('reh', 'org') ON CONFLICT DO NOTHING;
INSERT INTO memexes (namespace_id, slug, name)
  SELECT id, 'mx', 'rehearsal' FROM namespaces WHERE slug='reh' ON CONFLICT DO NOTHING;
INSERT INTO test_events (subject_ref, memex_id, status, test_identifier, created_at)
SELECT 'reh/mx/specs/spec-' || (g % 500) || '/acs/ac-' || (g % 40),
       (SELECT m.id FROM memexes m JOIN namespaces n ON n.id=m.namespace_id WHERE n.slug='reh'),
       (ARRAY['pass','fail','error'])[1 + (g % 3)],
       'file' || (g % 200) || '.test.ts::it',
       now() - ((g % 90) || ' days')::interval - ((g % 86400) || ' seconds')::interval
FROM generate_series(1, ${ROWS}) g;
ANALYZE test_events;
SQL
echo "rows: $(psql -t -A "$URL" -c 'SELECT count(*) FROM test_events')"

echo "── starting ${WRITERS} writers in the emission's lock order ─────────────────"
ERRLOG="$(mktemp)"
for i in $(seq 1 "$WRITERS"); do
  (
    while [ ! -f /tmp/t12_rehearsal_stop ]; do
      psql -v ON_ERROR_STOP=1 "$URL" -q >>"$ERRLOG" 2>&1 <<SQL || true
BEGIN;
INSERT INTO test_events (subject_ref, memex_id, status, test_identifier)
  VALUES ('reh/mx/specs/spec-1/acs/ac-1',
          (SELECT m.id FROM memexes m JOIN namespaces n ON n.id=m.namespace_id WHERE n.slug='reh'),
          'pass', 'load::w${i}');
INSERT INTO test_event_latest (subject_ref, test_identifier, latest_status, latest_run_at, memex_id, run_count)
  VALUES ('reh/mx/specs/spec-1/acs/ac-1', 'load::w${i}', 'pass', now(),
          (SELECT m.id FROM memexes m JOIN namespaces n ON n.id=m.namespace_id WHERE n.slug='reh'), 1)
  ON CONFLICT (subject_ref, test_identifier) DO UPDATE SET run_count = test_event_latest.run_count + 1;
COMMIT;
SQL
    done
  ) &
done
rm -f /tmp/t12_rehearsal_stop
sleep 3

echo "── applying 0141 (out-of-band) UNDER LOAD ──────────────────────────────────"
/usr/bin/time -f "  0141 wall: %e s" psql -v ON_ERROR_STOP=1 "$URL" \
  -f "${PKG_DIR}/drizzle/out-of-band/0141_spec520_test_events_partition_prep.sql" 2>&1 | tail -2

echo "── applying 0142 UNDER LOAD — this is the exclusive window ─────────────────"
START=$(date +%s.%N)
psql -v ON_ERROR_STOP=1 "$URL" -f "${PKG_DIR}/drizzle/0142_spec520_partition_test_events.sql" 2>&1 | tail -3
END=$(date +%s.%N)

touch /tmp/t12_rehearsal_stop
sleep 2
wait 2>/dev/null || true

echo ""
echo "══ RESULT ══════════════════════════════════════════════════════════════════"
echo "  exclusive window (0142 wall clock): $(echo "$END - $START" | bc) s"
echo "  partitioned:  $(psql -t -A "$URL" -c "SELECT relkind FROM pg_class WHERE relname='test_events'")  (want p)"
echo "  rows after:   $(psql -t -A "$URL" -c 'SELECT count(*) FROM test_events')"
echo "  partitions:   $(psql -t -A "$URL" -c "SELECT count(*) FROM pg_inherits WHERE inhparent='test_events'::regclass")"
echo ""
echo "  writer errors by kind (empty = no writer was refused):"
grep -oE 'ERROR:[^\"]*' "$ERRLOG" | sort | uniq -c | sed 's/^/    /' || echo "    none"
echo ""
echo "  ⚠ A deadlock (40P01) or a lock timeout (55P03) here is the 0111 failure repeating."
echo "    Record this whole block on spec-520 t-12 before promoting past int."
rm -f "$ERRLOG" /tmp/t12_rehearsal_stop
