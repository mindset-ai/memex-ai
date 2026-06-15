#!/usr/bin/env bash
# Applies hand-written migrations (those beyond the drizzle-kit journal) in order, and
# tracks them in a `manual_migrations` table so each file only runs once per database.
#
# The project has a two-tier migration convention (documented in packages/server/TEST.md):
#   * 0000–0008 are drizzle-kit journal-tracked → applied via `pnpm db:migrate`
#   * 0009+     are hand-written — this script owns them
#
# Modes:
#   apply-hand-migrations.sh            Apply every unapplied hand-written migration.
#   apply-hand-migrations.sh --seed     Mark every hand-written file currently on disk
#                                       as already applied WITHOUT running it. Use this
#                                       once per environment the first time this script
#                                       runs — it catches existing prod DBs up to the
#                                       tracker without re-applying SQL that's already
#                                       been DDL'd in by hand.
#   apply-hand-migrations.sh --dry-run  Print what would be applied, don't run it.
#
# Required env: DATABASE_URL (Postgres connection string).
#
# Transactions: each file + its tracking insert run in a single psql transaction
# (--single-transaction). If the migration fails, neither the DDL nor the tracking row
# is committed → next run retries the same file.

set -euo pipefail

MODE="apply"
case "${1:-}" in
  --seed)    MODE="seed" ;;
  --dry-run) MODE="dry-run" ;;
  "")        MODE="apply" ;;
  *)
    echo "usage: $0 [--seed | --dry-run]" >&2
    exit 2
    ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRIZZLE_DIR="$SCRIPT_DIR/../drizzle"
JOURNAL_FILE="$DRIZZLE_DIR/meta/_journal.json"

# Auto-source the local .env when DATABASE_URL isn't already in the environment.
# Lets `pnpm db:migrate` (which chains drizzle-kit migrate + this script) work
# from a fresh shell where only drizzle-kit was loading the dotenv file. The
# guard `[[ -z $DATABASE_URL ]]` keeps deploy paths (which pass an explicit
# Cloud SQL URL via env) untouched.
ENV_FILE="$SCRIPT_DIR/../.env"
if [[ -z "${DATABASE_URL:-}" && -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

: "${DATABASE_URL:?DATABASE_URL env var is required (set via .env or shell)}"

if [[ ! -f "$JOURNAL_FILE" ]]; then
  echo "ERROR: drizzle journal not found at $JOURNAL_FILE" >&2
  exit 1
fi

# Ensure the tracking table exists. Owned by this script — not part of the drizzle schema.
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE TABLE IF NOT EXISTS manual_migrations (
  filename text PRIMARY KEY,
  applied_at timestamp with time zone NOT NULL DEFAULT now()
);
SQL

# Extract the set of tags drizzle-kit owns so we skip them.
# Under Git Bash / MSYS on Windows, python3 is a native Windows binary that doesn't
# understand /c/... paths — translate to a Windows path via cygpath when available.
if command -v cygpath >/dev/null 2>&1; then
  JOURNAL_FILE_NATIVE=$(cygpath -w "$JOURNAL_FILE")
else
  JOURNAL_FILE_NATIVE="$JOURNAL_FILE"
fi
JOURNAL_TAGS=$(python3 -c "
import json, sys
j = json.load(open(sys.argv[1]))
for e in j['entries']:
    print(e['tag'])
" "$JOURNAL_FILE_NATIVE")

# Read the applied set ONCE, up front (spec-281 Fix 1). The collection loop below
# only asks "is this file already applied?" — a pure set-membership test. The old
# loop opened a fresh psql process + DB connection PER FILE to ask it (one
# `SELECT 1 ... WHERE filename = $tag` each), so the number of round-trips scaled
# with the count of .sql files on disk (~105 hand-written files → ~105 connections
# every deploy). Through cloud-sql-proxy on prod each connection costs several×
# int's latency, so that loop ballooned the prod migration phase to ~5min even
# when nothing was pending. Pulling the whole applied set in a single query and
# comparing in memory (`grep -qFx`) collapses ~105 connections to 1, with
# byte-identical skip behaviour. The guard against reintroducing the per-file
# query lives in src/__regression__/apply-hand-migrations-batch.regression.test.ts.
APPLIED=$(psql "$DATABASE_URL" -tAc "SELECT filename FROM manual_migrations")

# Collect applied + pending in deterministic filename order.
PENDING=()
for f in "$DRIZZLE_DIR"/*.sql; do
  [[ -e "$f" ]] || continue   # no files → exit cleanly
  tag=$(basename "$f" .sql)

  # Skip journal-tracked files — drizzle-kit migrate handles them.
  if grep -qFx "$tag" <<<"$JOURNAL_TAGS"; then
    continue
  fi

  # Skip already-applied files — in-memory membership test against the set read
  # once above (no per-file DB round-trip).
  if grep -qFx "$tag" <<<"$APPLIED"; then
    continue
  fi

  PENDING+=("$f")
done

if [[ ${#PENDING[@]} -eq 0 ]]; then
  echo "No hand-written migrations to apply."
  exit 0
fi

case "$MODE" in
  dry-run)
    echo "Would apply ${#PENDING[@]} migration(s):"
    for f in "${PENDING[@]}"; do echo "  - $(basename "$f")"; done
    exit 0
    ;;
  seed)
    echo "Seeding manual_migrations with ${#PENDING[@]} existing file(s) (not running SQL):"
    for f in "${PENDING[@]}"; do
      tag=$(basename "$f" .sql)
      echo "  + $tag"
      psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q \
        -c "INSERT INTO manual_migrations (filename) VALUES ('$tag') ON CONFLICT DO NOTHING"
    done
    echo "Seed complete. Future runs of this script will only apply files added after this point."
    exit 0
    ;;
  apply)
    echo "Applying ${#PENDING[@]} hand-written migration(s)..."
    for f in "${PENDING[@]}"; do
      tag=$(basename "$f" .sql)
      echo "  → $tag"
      psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction \
        -f "$f" \
        -c "INSERT INTO manual_migrations (filename) VALUES ('$tag')"
    done
    echo "  ✓ all hand-written migrations applied"
    ;;
esac
