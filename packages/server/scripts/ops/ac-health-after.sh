#!/usr/bin/env bash
# spec-520 ac-1 / ac-11 — the AC-health read's cost after t-4, measured against t-1's baseline.
#
#   ./ac-health-after.sh
#
# Does NOT depend on any pending deploy: t-4 has been live in prod since 2026-08-31.
#
# WHAT t-1 RECORDED (s-4), so the comparison is against a written number and not a memory:
#   * the read's mean was 642 ms over 1,752 calls on one variant, 792 ms on another
#   * ONE logical read was fragmented into 1,098 DISTINCT pg_stat_statements fingerprints,
#     408,339 calls, 19,908 s (5h32m) cumulative, largest observed bind count 3,745 params —
#     because the wide `subject_ref IN (…)` shape makes every parameter count its own
#     prepared statement and its own plan-cache entry
#   * planning time alone was 7.564 ms for the 1,800-literal form vs 0.037 ms for the simple
#     one — a 200x difference paid before a row is touched
#
# ⚠ THE FINGERPRINT COUNT IS THE SHARPER EVIDENCE, and it is the one to read first. A mean
# can move for a dozen reasons — cache state, load, a quiet hour. 1,098 fingerprints
# collapsing to 1 can only happen because the query shape changed. t-1 also warned that the
# EXPLAIN timings there are a LOWER bound (taken on a quiet connection with everything in
# shared_buffers), so a rewrite must not be sized as 642 ms -> 48 ms.
#
# ⚠ THE FIRST VERSION OF THIS SCRIPT READ CUMULATIVE COUNTERS AND COULD NOT ANSWER ITS OWN
# QUESTION. pg_stat_statements has run since 2026-06-25; every pre-t-4 fingerprint is still
# in it and always will be. The count came back as 1,134 — MORE than t-1's 1,098 — which
# reads like a regression and means nothing at all. The same trap this Spec documented for
# the emission path, walked into again on the next measurement.
#
# So this takes a DELTA. A fingerprint that is still being CALLED shows a non-zero delta; one
# that merely still exists in the table shows zero.
#
# Read-only.
set -uo pipefail
WINDOW="${1:-180}"
cd "$(dirname "$0")/../../../.."
export ENV=prod DEPLOY_CONFIG_PROJECT=memex-ai-prod
source scripts/deploy-config.sh || exit 1
PORT=15462
cloud-sql-proxy "$CLOUD_SQL_INSTANCE_CONN" --port "$PORT" >/dev/null 2>&1 &
P=$!; trap 'kill $P 2>/dev/null || true' EXIT
for i in $(seq 1 30); do
  PGPASSWORD="$DB_PASS" psql -h 127.0.0.1 -p "$PORT" -U "$DB_USER" -d "$DB_NAME" -c 'SELECT 1' >/dev/null 2>&1 && break
  sleep 1
done
Q() { PGPASSWORD="$DB_PASS" psql -q -h 127.0.0.1 -p "$PORT" -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -At -F'|' \
        -c "SET default_transaction_read_only = on; $1"; }
TMP=$(mktemp -d); trap 'kill $P 2>/dev/null || true; rm -rf "$TMP"' EXIT

SNAP="SELECT queryid, calls, total_exec_time, replace(left(regexp_replace(query,'\s+',' ','g'),110),'|',' ') FROM pg_stat_statements WHERE queryid IS NOT NULL;"
snap() {
  for a in 1 2 3; do
    Q "$SNAP" > "$1" 2>"$TMP/e" && [ "$(wc -l < "$1")" -gt 100 ] && return 0
    echo "  snapshot attempt $a failed — retrying" >&2; sleep 3
  done
  echo "  ✗ ABORTING: no complete snapshot. Zeros here would look like a result." >&2; exit 1
}
echo "══ reading 1 … waiting ${WINDOW}s … reading 2 ══"
snap "$TMP/a"; sleep "$WINDOW"; snap "$TMP/b"
echo "  (${WINDOW}s elapsed; $(wc -l < "$TMP/a") statements captured)"

python3 - "$TMP/a" "$TMP/b" "$WINDOW" <<'PY'
import sys
a_p, b_p, w = sys.argv[1], sys.argv[2], float(sys.argv[3])
def load(p):
    o = {}
    for line in open(p):
        q = line.rstrip("\n").split("|")
        if len(q) < 4 or not q[0].lstrip("-").isdigit(): continue
        o[q[0]] = (int(q[1]), float(q[2]), q[3])
    return o
a, b = load(a_p), load(b_p)
rows = []
for qid, (c2, t2, q) in b.items():
    c1, t1, _ = a.get(qid, (0, 0.0, q))
    if c2 - c1 > 0: rows.append((t2 - t1, c2 - c1, q, q.lower().replace('"', "")))

wide = [r for r in rows if "test_event_latest" in r[3] and "subject_ref" in r[3] and " in (" in r[3]]
print(f"\n══ 1. IS THE WIDE `IN (…)` SHAPE STILL BEING CALLED? ══")
if not wide:
    print("  ✓ ZERO calls in the window. t-1 recorded 1,098 fingerprints and 408,339 calls of it.")
    print("    The lifetime rows remain in pg_stat_statements forever; nothing is invoking them.")
else:
    print(f"  ⚠ {len(wide)} fingerprint(s) STILL CALLED — the shape survives somewhere:")
    for dt, dc, q, _ in sorted(wide, reverse=True)[:5]:
        print(f"     {dc/w:8.3f}/s  {dt/dc:8.2f} ms  {q[:90]}")

print(f"\n══ 2. THE AC-HEALTH READS ACTUALLY RUNNING NOW ══")
hits = [r for r in rows if ("test_event_latest" in r[3] and "select" in r[3][:40]) or ("from acs" in r[3] and "documents" in r[3])]
if not hits:
    print("  (no AC-health read ran in this window — try again during UI traffic)")
for dt, dc, q, _ in sorted(hits, reverse=True)[:6]:
    print(f"  {dc/w:8.3f}/s  mean {dt/dc:8.3f} ms   {q[:88]}")
print("\n  t-1 baseline: mean 642 ms (1,752 calls) and 792 ms on two variants.")
print("  ac-1 asks for at least an order of magnitude — a mean under ~65 ms clears it.")
PY
