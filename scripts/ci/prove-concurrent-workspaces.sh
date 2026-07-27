#!/usr/bin/env bash
# spec-512 ac-1 — PROVE two working copies run concurrently without collisions.
#
# The motivating guidance is blunt about why this script exists rather than a
# paragraph of reasoning: "Shared state hides in unexpected places. You will only
# find this by genuinely running two copies at once." Every collision spec-512
# fixed was found that way, and the two that were merely reasoned about (the dev
# ports, and `make e2e` vs `make e2e-cold`) were both wrong until an independent
# reviewer actually ran them.
#
# So this does not inspect config. It provisions a second working copy, starts
# real servers in both, and drives real HTTP at them, concurrently.
#
# Re-runnable and self-cleaning: the throwaway worktree, its databases and every
# process are removed on exit, including on failure (trap).
#
#   bash scripts/ci/prove-concurrent-workspaces.sh          # tiers 1-3 (fast, ~1 min)
#   PROVE_E2E=1 bash scripts/ci/prove-concurrent-workspaces.sh   # + tier 4 (slow)
#
# Tier 4 runs two full Playwright suites at once. It is opt-in because it takes
# many minutes and needs a Postgres that can seat both.

set -uo pipefail

SELF="scripts/ci/prove-concurrent-workspaces.sh"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKTREE_DIR="${PROVE_WORKTREE_DIR:-/tmp/memex-ac1-proof}"
WORKTREE_BRANCH="spec-512-ac1-proof-$$"
PGHOST="${PGHOST:-localhost}"
PGUSER="${PGUSER:-postgres}"

PIDS=()
OWNED_PORTS=()   # every port this script binds; cleanup frees exactly these
FAILURES=0
CHECKS=0

# ── output ───────────────────────────────────────────────────────────────────
pass() { CHECKS=$((CHECKS + 1)); printf '  ✓ %s\n' "$1"; }
fail() {
  CHECKS=$((CHECKS + 1))
  FAILURES=$((FAILURES + 1))
  printf '  ✗ %s\n' "$1"
  [ $# -gt 1 ] && printf '      %s\n' "$2"
}
section() { printf '\n▶ %s\n' "$1"; }

cleanup() {
  local code=$?
  section "Cleanup"
  # Kill by PORT, not by process group. `kill -- -PGID` would take down this
  # script too: the background servers share its process group, so the first
  # cleanup attempt killed the runner mid-teardown (exit 144). Ports are the
  # precise handle — and they also catch the grandchildren pnpm spawns, which a
  # bare `kill $pid` leaves orphaned holding the port.
  for port in "${OWNED_PORTS[@]:-}"; do
    [ -n "${port:-}" ] && lsof -ti tcp:"$port" 2>/dev/null | xargs -r kill 2>/dev/null
  done
  sleep 1
  for port in "${OWNED_PORTS[@]:-}"; do
    [ -n "${port:-}" ] && lsof -ti tcp:"$port" 2>/dev/null | xargs -r kill -9 2>/dev/null
  done
  if [ -d "$WORKTREE_DIR" ]; then
    local wdb
    wdb=$(cd "$WORKTREE_DIR" 2>/dev/null && node scripts/ci/workspace-alloc.mjs e2e-database-name 2>/dev/null)
    local wtpl
    wtpl=$(cd "$WORKTREE_DIR" 2>/dev/null && node scripts/ci/workspace-alloc.mjs e2e-template-name 2>/dev/null)
    for db in "$wdb" "$wtpl"; do
      [ -n "${db:-}" ] && dropdb --if-exists --force -h "$PGHOST" -U "$PGUSER" "$db" 2>/dev/null
    done
    git -C "$REPO_ROOT" worktree remove --force "$WORKTREE_DIR" 2>/dev/null
  fi
  git -C "$REPO_ROOT" branch -D "$WORKTREE_BRANCH" 2>/dev/null >/dev/null
  echo "  worktree, databases and processes removed"
  exit $code
}
trap cleanup EXIT INT TERM

# Wait for an HTTP endpoint, up to N seconds. Returns 1 on timeout.
wait_for_http() {
  local url=$1 secs=${2:-60} i=0
  while [ $i -lt "$secs" ]; do
    curl -sf --max-time 2 "$url" >/dev/null 2>&1 && return 0
    sleep 1
    i=$((i + 1))
  done
  return 1
}

printf '═══ spec-512 ac-1: concurrent-workspace proof ═══\n'
printf 'workspace A: %s\n' "$REPO_ROOT"

# ── Provision the second working copy ────────────────────────────────────────
section "Provisioning workspace B"
git -C "$REPO_ROOT" worktree remove --force "$WORKTREE_DIR" 2>/dev/null
rm -rf "$WORKTREE_DIR"
if ! git -C "$REPO_ROOT" worktree add -b "$WORKTREE_BRANCH" "$WORKTREE_DIR" HEAD >/dev/null 2>&1; then
  echo "  ✗ could not create worktree at $WORKTREE_DIR"; exit 1
fi
printf 'workspace B: %s\n' "$WORKTREE_DIR"
# Install for real — ~3s against the shared pnpm store. The first version of this
# script symlinked workspace A's node_modules instead, and workspace B's server
# then died with `tsx: command not found`: a root symlink does not provide the
# per-package .bin shims. That produced a FALSE ac-1 failure — the proof harness
# lying about the thing it exists to measure. Provision the way a developer does.
echo "  installing dependencies (shared pnpm store)…"
if ! ( cd "$WORKTREE_DIR" && pnpm install --prefer-offline --ignore-scripts >/dev/null 2>&1 ); then
  echo "  ✗ pnpm install failed in workspace B — cannot run the proof"; exit 1
fi
# @memex/shared is built, not compiled on demand; copy A's dist so B's UI resolves
# the same exports (the alternative is a second full build for no extra signal).
[ -d "$REPO_ROOT/packages/shared/dist" ] && cp -R "$REPO_ROOT/packages/shared/dist" "$WORKTREE_DIR/packages/shared/dist" 2>/dev/null

alloc_a() { (cd "$REPO_ROOT" && node scripts/ci/workspace-alloc.mjs "$1"); }
alloc_b() { (cd "$WORKTREE_DIR" && node scripts/ci/workspace-alloc.mjs "$1"); }

# ── TIER 1: allocations must not overlap ─────────────────────────────────────
section "Tier 1 — derived allocations are disjoint"
ID_A=$(alloc_a workspace-id);        ID_B=$(alloc_b workspace-id)
[ "$ID_A" != "$ID_B" ] \
  && pass "workspace ids differ ($ID_A vs $ID_B)" \
  || fail "workspace ids COLLIDE ($ID_A)" "both copies would claim the same identity"

PORTS_A=$(alloc_a e2e-api-port)" "$(alloc_a e2e-ui-port)" "$(alloc_a dev-api-port)" "$(alloc_a dev-ui-port)
PORTS_B=$(alloc_b e2e-api-port)" "$(alloc_b e2e-ui-port)" "$(alloc_b dev-api-port)" "$(alloc_b dev-ui-port)
OVERLAP=$(comm -12 <(tr ' ' '\n' <<<"$PORTS_A" | sort -u) <(tr ' ' '\n' <<<"$PORTS_B" | sort -u))
[ -z "$OVERLAP" ] \
  && pass "all 8 ports disjoint (A: $PORTS_A | B: $PORTS_B)" \
  || fail "PORT COLLISION: $(tr '\n' ' ' <<<"$OVERLAP")" "one copy's server would answer the other's tests"

DB_A=$(alloc_a e2e-database-name);   DB_B=$(alloc_b e2e-database-name)
TPL_A=$(alloc_a e2e-template-name);  TPL_B=$(alloc_b e2e-template-name)
{ [ "$DB_A" != "$DB_B" ] && [ "$TPL_A" != "$TPL_B" ]; } \
  && pass "e2e databases + templates disjoint ($DB_A vs $DB_B)" \
  || fail "DATABASE COLLISION ($DB_A / $DB_B)" "one run's dropdb would destroy the other's data mid-run"

# ── TIER 2: two dev servers, actually running, at the same time ──────────────
# This is the half of ac-1 that was FALSE until the dev ports were wired: the
# allocator computed them but nothing read them, so both copies bound 8080 and
# Vite's strictPort killed the second.
section "Tier 2 — two dev servers bound concurrently"
DEV_A=$(alloc_a dev-api-port); DEV_B=$(alloc_b dev-api-port)
OWNED_PORTS+=("$DEV_A" "$DEV_B")
# DATABASE_URL is passed explicitly: packages/server/.env is gitignored, so a
# fresh worktree has none and the server throws at import. (That failure is loud
# and well-messaged, so it is not a silent-lie trap — but it does mean a new
# worktree cannot `make dev` until its .env exists. Noted, out of scope here.)
# Both dev servers share the dev database on purpose: `make dev` has always done
# so, and spec-512 derived the E2E databases, not the dev one.
DEV_DB="${PROVE_DEV_DATABASE_URL:-postgresql://postgres:postgres@localhost:5432/memex}"
for spec in "A:$REPO_ROOT:$DEV_A:$ID_A" "B:$WORKTREE_DIR:$DEV_B:$ID_B"; do
  IFS=: read -r name dir port wsid <<<"$spec"
  ( cd "$dir" && MEMEX_WORKSPACE_ID="$wsid" PORT="$port" GOOGLE_CLIENT_ID="" \
      DATABASE_URL="$DEV_DB" SLACK_TOKEN_ENCRYPTION=plaintext \
      pnpm --filter @memex/server dev >"/tmp/ac1-dev-$name.log" 2>&1 ) &
  PIDS+=($!)
done

BOOTED=0
for spec in "A:$DEV_A" "B:$DEV_B"; do
  IFS=: read -r name port <<<"$spec"
  if wait_for_http "http://localhost:$port/api/health" 75; then
    BOOTED=$((BOOTED + 1))
  else
    fail "workspace $name dev server never bound :$port" \
      "$(tail -3 "/tmp/ac1-dev-$name.log" 2>/dev/null | tr '\n' ' ' || echo 'no log')"
  fi
done
[ "$BOOTED" -eq 2 ] && pass "both dev servers live simultaneously (:$DEV_A and :$DEV_B)"

# ── TIER 3: each server proves WHICH copy it belongs to ──────────────────────
# Identity is what makes a foreign server refusable rather than adoptable.
section "Tier 3 — each server reports its own workspace identity"
if [ "$BOOTED" -eq 2 ]; then
  SEEN_A=$(curl -s --max-time 3 "http://localhost:$DEV_A/api/health" | sed -n 's/.*"workspace":"\([^"]*\)".*/\1/p')
  SEEN_B=$(curl -s --max-time 3 "http://localhost:$DEV_B/api/health" | sed -n 's/.*"workspace":"\([^"]*\)".*/\1/p')
  { [ "$SEEN_A" = "$ID_A" ] && [ "$SEEN_B" = "$ID_B" ] && [ "$SEEN_A" != "$SEEN_B" ]; } \
    && pass "servers self-identify correctly and distinctly ($SEEN_A / $SEEN_B)" \
    || fail "identity mismatch (A reported '$SEEN_A' want '$ID_A'; B reported '$SEEN_B' want '$ID_B')" \
            "without distinct identity the preflight cannot tell a foreign server from its own"

  # The load-bearing negative: B's preflight must REFUSE A's server.
  OUT=$( cd "$WORKTREE_DIR" && MEMEX_EMIT=off E2E_SERVER_PORT="$DEV_A" \
           node scripts/ci/e2e-preflight.mjs 2>&1 )
  if grep -q "BELONGS TO ANOTHER WORKSPACE" <<<"$OUT"; then
    pass "workspace B's preflight REFUSES workspace A's live server"
  else
    fail "workspace B's preflight ACCEPTED workspace A's server" \
      "this is the original silent-adoption bug — B would test A's code and pass"
  fi
else
  fail "skipped — dev servers did not both boot" "cannot test identity without two live servers"
fi

# ── TIER 4 (opt-in): two full e2e suites at once ─────────────────────────────
section "Tier 4 — concurrent e2e suites"
if [ "${PROVE_E2E:-0}" = "1" ]; then
  echo "  running two full Playwright suites concurrently (slow)…"
  ( cd "$REPO_ROOT"     && PGPASSWORD=postgres MEMEX_EMIT=off make e2e-cold >/tmp/ac1-e2e-a.log 2>&1 ) & A_PID=$!
  ( cd "$WORKTREE_DIR"  && PGPASSWORD=postgres MEMEX_EMIT=off make e2e-cold >/tmp/ac1-e2e-b.log 2>&1 ) & B_PID=$!
  wait $A_PID; RC_A=$?
  wait $B_PID; RC_B=$?

  # What this tier can and cannot conclude.
  #
  # A pre-existing red journey makes both suites exit non-zero, and blaming that
  # on concurrency would be a false accusation in the same family as the false
  # passes this Spec exists to remove — a harness must not claim a collision it
  # did not observe. So: report the counts, and name the failures each side saw.
  # Only failures unique to ONE side can plausibly be interference; a journey that
  # fails identically in both is a property of the branch, not of running two.
  #
  # Observed 2026-07-27: A 137 passed/1 failed, B 136 passed/2 failed. The shared
  # failure (journey-45) reproduces on clean `develop` against a cold DB with no
  # spec-512 code present — filed as issue-6, unrelated to concurrency.
  fails_of() {
    grep -oE '\[chromium\] › e2e/journey-[^ ]+\.spec\.ts:[0-9]+:[0-9]+' "$1" 2>/dev/null \
      | sort -u
  }
  A_FAILS=$(fails_of /tmp/ac1-e2e-a.log); B_FAILS=$(fails_of /tmp/ac1-e2e-b.log)
  ONLY_ONE_SIDE=$(comm -3 <(echo "$A_FAILS") <(echo "$B_FAILS") | tr -d '\t' | sed '/^$/d')

  printf '    A: %s\n' "$(grep -cE '^\s+[0-9]+ passed' /tmp/ac1-e2e-a.log >/dev/null && grep -oE '[0-9]+ passed \([^)]*\)' /tmp/ac1-e2e-a.log | tail -1)"
  printf '    B: %s\n' "$(grep -oE '[0-9]+ passed \([^)]*\)' /tmp/ac1-e2e-b.log | tail -1)"

  if [ $RC_A -eq 0 ] && [ $RC_B -eq 0 ]; then
    pass "both e2e suites passed concurrently"
  elif [ -z "$ONLY_ONE_SIDE" ]; then
    pass "both suites ran to completion concurrently; every failure was common to BOTH (pre-existing, not interference) — verify each against a solo run"
    printf '      shared failures: %s\n' "$(echo "$A_FAILS" | tr '\n' ' ')"
  else
    fail "failure(s) unique to ONE workspace — possible interference" \
      "$(echo "$ONLY_ONE_SIDE" | tr '\n' ' ') | logs: /tmp/ac1-e2e-a.log /tmp/ac1-e2e-b.log"
  fi
else
  echo "  ⚠ SKIPPED (opt-in). This tier is the fullest form of the claim —"
  echo "    tiers 1-3 prove allocation, binding and identity, not a whole suite."
  echo "    Run it with: PROVE_E2E=1 bash $SELF"
fi

# ── Verdict ──────────────────────────────────────────────────────────────────
section "Verdict"
if [ "$CHECKS" -eq 0 ]; then
  echo "  ✗ ZERO checks ran — that is a defect in this script, not a clean result."
  echo "    Check: $SELF"
  exit 2
fi
if [ "$FAILURES" -gt 0 ]; then
  printf '  ✗ ac-1 NOT PROVEN — %d of %d checks failed.\n' "$FAILURES" "$CHECKS"
  printf '    Two working copies cannot yet run concurrently without collisions.\n'
  printf '    Check: %s\n' "$SELF"
  exit 1
fi
printf '  ✓ ac-1 HOLDS for the tiers run — %d/%d checks passed.\n' "$CHECKS" "$CHECKS"
[ "${PROVE_E2E:-0}" = "1" ] || printf '    (tier 4, concurrent full e2e, was skipped — see above)\n'
exit 0
