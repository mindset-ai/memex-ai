#!/usr/bin/env bash
# spec-520 t-14 / ac-4 — the emission path's share of database time, as a DELTA.
#
#   ./emission-cost-delta.sh [WINDOW_SECONDS] [int|prod]     (default: 300 prod)
#
# ⚠ LIVES IN THE REPO ON PURPOSE. This was a scratchpad script for one session and was
# wiped overnight — while t-14's post-deploy procedure still referenced it by name. A
# procedure that does not survive a night is not a procedure.
#
# WHY A DELTA AND NOT A CUMULATIVE SHARE. pg_stat_statements counters run since
# stats_reset (2026-06-25 for prod). They hold months of pre-change traffic, so after a
# change they barely move: a statement going from 12.6% to ZERO still reads ~12%
# cumulatively because its 21M historical calls do not disappear. Reading that as "the fix
# did nothing" is a measurement artifact, and it has already bitten this Spec once.
#
# ⚠ FOUR WAYS THIS MEASUREMENT LIED BEFORE, all now guarded, all of which failed TOWARDS
# the flattering answer:
#   1. CREATE TEMP TABLE for the snapshot — refused under default_transaction_read_only.
#      Both readings now go to local CSV and are differenced here; prod stays read-only.
#   2. A dropped connection left an empty snapshot; nothing differenced against something
#      reported "0.000%" — a triumph, on the exact criterion being measured. A short
#      snapshot now ABORTS instead of reporting zeros.
#   3. Patterns matched unquoted SQL only. Drizzle quotes identifiers, so the INSERT was
#      silently dropped from the total. Matching is quote-insensitive, and any BUSY
#      statement no pattern classified is printed.
#   4. A window taken while traffic was idle read ~0% and meant nothing. Check there is
#      traffic first (scripts/ops/day-after-check.sh answers this).
#
# And one that is not the script's fault but bites the reader: a single window is not a
# comparator. Two windows ten minutes apart disagreed by 2x on an unchanged system. Take
# several on each side and compare ranges.
set -uo pipefail
WINDOW="${1:-300}"
ENVNAME="${2:-prod}"
cd "$(dirname "$0")/../../../.."

export ENV="$ENVNAME" DEPLOY_CONFIG_PROJECT="memex-ai-${ENVNAME}"
source scripts/deploy-config.sh || { echo "deploy-config failed"; exit 1; }

PORT=15452
cloud-sql-proxy "$CLOUD_SQL_INSTANCE_CONN" --port "$PORT" >/dev/null 2>&1 &
PROXY=$!
TMP=$(mktemp -d)
trap 'kill $PROXY 2>/dev/null || true; rm -rf "$TMP"' EXIT
for i in $(seq 1 30); do
  PGPASSWORD="$DB_PASS" psql -h 127.0.0.1 -p "$PORT" -U "$DB_USER" -d "$DB_NAME" -c 'SELECT 1' >/dev/null 2>&1 && break
  sleep 1
done
Q() { PGPASSWORD="$DB_PASS" psql -q -h 127.0.0.1 -p "$PORT" -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -At -F'|' \
        -c "SET default_transaction_read_only = on; $1"; }

echo "══ gate: has pg_stat_statements been reset since the t-1 baseline? ══"
Q "SELECT stats_reset, stats_reset = '2026-06-25 10:04:23.277059+00'::timestamptz FROM pg_stat_statements_info;" \
  | awk -F'|' '{printf "  stats_reset=%s   same_window_as_t1=%s\n", $1, $2}'

SNAP="SELECT queryid, calls, total_exec_time, replace(left(regexp_replace(query, '\s+', ' ', 'g'), 90), '|', ' ') FROM pg_stat_statements WHERE queryid IS NOT NULL;"
snap() {
  for attempt in 1 2 3; do
    if Q "$SNAP" > "$1" 2>"$TMP/err" && [ "$(wc -l < "$1")" -gt 100 ]; then return 0; fi
    echo "  snapshot attempt $attempt failed ($(wc -l < "$1") rows) — retrying" >&2
    sed 's/^/    /' "$TMP/err" >&2
    sleep 3
  done
  echo "  ✗ ABORTING: no complete snapshot after 3 attempts. Zeros here would look like a result." >&2
  exit 1
}
echo ""
echo "══ reading 1 … waiting ${WINDOW}s … reading 2 ══"
snap "$TMP/a" ; sleep "$WINDOW" ; snap "$TMP/b"
echo "  (${WINDOW}s elapsed; $(wc -l < "$TMP/a") and $(wc -l < "$TMP/b") statements captured)"

python3 - "$TMP/a" "$TMP/b" "$WINDOW" <<'PY'
import sys
a_path, b_path, window = sys.argv[1], sys.argv[2], float(sys.argv[3])
def norm(q): return q.lower().replace('"', "")
def load(p):
    out = {}
    for line in open(p):
        parts = line.rstrip("\n").split("|")
        if len(parts) < 4 or not parts[0].lstrip("-").isdigit(): continue
        out[parts[0]] = (int(parts[1]), float(parts[2]), parts[3])
    return out
a, b = load(a_path), load(b_path)
rows = []
for qid, (c2, t2, q) in b.items():
    c1, t1, _ = a.get(qid, (0, 0.0, q))
    dc, dt = c2 - c1, t2 - t1
    if dc > 0 and dt > 0: rows.append((dt, dc, q, norm(q)))
total = sum(r[0] for r in rows) or 1.0
PATTERNS = [
    ("retention DELETE   (t-1: 12.606%)", "delete from test_events"),
    ("test_events insert (t-1:  4.967%)", "insert into test_events"),
    ("test_event_latest  (t-1:  2.017%)", "test_event_latest"),
    ("ac_first_verified  (t-1:  6.073%)", "ac_first_verified"),
    ("emission key bump  (t-1:  3.618%)", "memex_emission_keys"),
    ("test_run_daily     (new tier)    ", "test_run_daily"),
]
print(f"\n══ THE EMISSION PATH over the last {int(window)}s ══")
print(f"{'statement':36} {'%db':>7} {'calls/s':>9} {'mean ms':>9}")
claimed, path_ms = set(), 0.0
for label, pat in PATTERNS:
    hit = [r for r in rows if pat in r[3]]
    for r in hit: claimed.add(id(r))
    if not hit:
        print(f"{label:36} {'—':>7} {'0':>9} {'—':>9}   (no calls in window)"); continue
    dt = sum(r[0] for r in hit); dc = sum(r[1] for r in hit)
    path_ms += dt
    print(f"{label:36} {100*dt/total:7.3f} {dc/window:9.3f} {dt/dc:9.4f}")
print(f"\n  emission path total: {100*path_ms/total:.3f}%")
print(f"  pre-deploy delta baseline (2026-08-31, c-20): 32.518%")
missed = [r for r in rows if id(r) not in claimed
          and any(t in r[3] for t in ("test_event","ac_first_verified","memex_emission_keys","test_run_daily"))
          and r[1]/window >= 0.5]
if missed:
    print("\n  ⚠ UNCLASSIFIED but busy — touch the emission tables, matched no pattern:")
    for dt, dc, q, _ in sorted(missed, reverse=True)[:8]:
        print(f"     {100*dt/total:6.3f}%  {dc/window:8.2f}/s  {q[:88]}")
else:
    print("\n  ✓ nothing busy on these tables went unclassified.")
PY

echo ""
echo "══ ac-13 — deletes across the WHOLE partition family, never the parent alone ══"
Q "SELECT sum(n_tup_ins), sum(n_tup_del), sum(n_live_tup), count(*)
     FROM pg_stat_user_tables
    WHERE relname = 'test_events' OR relname LIKE 'test\_events\_%';" \
  | awk -F'|' '{printf "  ins=%s  del=%s  live=%s  across %s relations\n",$1,$2,$3,$4}'
echo "  del read 38,723,340 on 2026-08-31 and 38,723,352 a day later — +12, all from"
echo "  explicit retirement (discontinue_test_events), not the trim. It was ~54,000/90s before."
