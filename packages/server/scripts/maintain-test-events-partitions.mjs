#!/usr/bin/env node
// spec-520 t-12 — partition maintenance for test_events. Creates the days ahead, drops the
// days past the retention window.
//
// ⚠ RUNS AS THE OWNING ROLE, FROM DEPLOY — NEVER FROM THE REQUEST PATH.
// DROP TABLE requires ownership, and the request path's role must not have it [per
// std-36]. deploy.sh already holds an owner connection for migrations (DB_URL); this hooks
// in beside them. It is deliberately NOT the in-process setInterval shape used by
// activity-log-sweep: that runs inside the API server, as the runtime role, which is
// exactly the role this must not be.
//
// FAILURE DIRECTION, ON PURPOSE. If no deploy happens for a long time:
//   • no new partitions are created — but 60 days of horizon were pre-created, so inserts
//     keep working;
//   • no old partitions are dropped — so the table GROWS.
// Growing is the safe failure. The alternative (a DEFAULT partition as a catch-all) was
// measured and rejected: once rows land in a default, creating that day's real partition
// fails outright, so the next deploy's migration cannot apply until someone drains it.
//
// IDEMPOTENT. Creating is IF NOT EXISTS; dropping only touches partitions whose entire
// range is already outside the window. Re-running changes nothing.

import postgres from "postgres";

const RETENTION_DAYS = clampInt(process.env.TEST_EVENTS_RETENTION_DAYS, 3, 1, 90);
const HORIZON_DAYS = 60; // keep in step with PARTITION_HORIZON_DAYS in test-event-retention.ts

function clampInt(raw, fallback, min, max) {
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.min(n, max);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("[partitions] DATABASE_URL is required");
  process.exit(1);
}

const sql = postgres(url, { max: 1 });

try {
  // Bail out quietly if the table is not partitioned yet — this script ships with 0142 but
  // deploy.sh calls it unconditionally, and a deploy of an older schema must not fail here.
  const [{ kind } = {}] = await sql`
    SELECT relkind AS kind FROM pg_class WHERE relname = 'test_events'
  `;
  if (kind !== "p") {
    console.log("[partitions] test_events is not partitioned yet — nothing to do");
    process.exit(0);
  }

  // ── create ahead ────────────────────────────────────────────────────────────────────
  // The day list and the cutoff are computed in JS from ONE reading of the database clock.
  // Deriving them in SQL meant parameterising intervals inside a tagged template, which
  // postgres.js cannot type ("could not determine data type of parameter $1"). One clock
  // read also means every decision below shares a single instant — a loop that re-read
  // now() could straddle midnight and create or drop the wrong day.
  const [{ now: dbNow }] = await sql`SELECT now() AS now`;
  const nowMs = new Date(dbNow).getTime();
  const DAY_MS = 86_400_000;
  // Midnight UTC of the current day, so bounds never depend on the session timezone —
  // a `date` bound is resolved in the SESSION's zone, which silently shifts every boundary
  // on a non-UTC server. 0142 hit exactly that.
  const todayUtc = Date.UTC(
    new Date(nowMs).getUTCFullYear(),
    new Date(nowMs).getUTCMonth(),
    new Date(nowMs).getUTCDate(),
  );

  const nameFor = (ms) => `test_events_${new Date(ms).toISOString().slice(0, 10).replace(/-/g, "")}`;

  // Read every existing partition's REAL range once, and use it for both halves below.
  //
  // ⚠ COVERAGE, NOT NAMES. The first version skipped a day when a table of that NAME
  // existed — which let it try to create test_events_20260830 while `test_events_legacy`
  // already covered that day, and Postgres refused with "would overlap". The legacy
  // partition is the whole point of the attach-based migration and it is not named for a
  // day, so any name-based reasoning is wrong here by construction.
  const partitions = (
    await sql`
      SELECT c.relname AS name, pg_get_expr(c.relpartbound, c.oid) AS bound
      FROM pg_class c
      JOIN pg_inherits i ON i.inhrelid = c.oid
      WHERE i.inhparent = 'test_events'::regclass
    `
  ).map((row) => {
    const m = /FROM \('([^']+)'\) TO \('([^']+)'\)/.exec(row.bound ?? "");
    return {
      name: row.name,
      from: m ? new Date(m[1]).getTime() : null,
      to: m ? new Date(m[2]).getTime() : null, // null for a DEFAULT partition
    };
  });

  const covered = (from, to) =>
    partitions.some((p) => p.from !== null && p.to !== null && p.from < to && p.to > from);

  let madeCount = 0;
  for (let i = 0; i <= HORIZON_DAYS; i++) {
    const from = todayUtc + i * DAY_MS;
    const to = from + DAY_MS;
    if (covered(from, to)) continue;
    const name = nameFor(from);
    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS ${name} PARTITION OF test_events ` +
        `FOR VALUES FROM ('${new Date(from).toISOString()}') TO ('${new Date(to).toISOString()}')`,
    );
    partitions.push({ name, from, to });
    madeCount += 1;
  }

  // ── drop what is entirely past the window ───────────────────────────────────────────
  // The partition's UPPER bound is read from the catalogue rather than parsed out of its
  // name: a partition whose name and bounds disagree (a hand-made one, a restore) would
  // otherwise be dropped on the strength of its name. This also covers `test_events_legacy`
  // with no special case — it is dropped once its whole range, which ends at the
  // migration's boundary, has aged out.
  const cutoffMs = nowMs - RETENTION_DAYS * DAY_MS;

  let droppedCount = 0;
  for (const row of partitions) {
    if (row.to === null) continue; // a DEFAULT partition has no TO bound — never dropped here
    if (!Number.isFinite(row.to) || row.to > cutoffMs) continue;
    // DETACH first, then DROP. Detaching takes a brief lock on the parent and leaves a
    // standalone table; dropping that table then touches nothing the emission path uses.
    // A bare DROP of an attached partition holds its lock on the parent for the whole drop.
    await sql.unsafe(`ALTER TABLE test_events DETACH PARTITION ${row.name}`);
    await sql.unsafe(`DROP TABLE ${row.name}`);
    droppedCount += 1;
    console.log(`[partitions] dropped ${row.name} (ended ${new Date(row.to).toISOString()}, window ${RETENTION_DAYS}d)`);
  }

  console.log(
    `[partitions] created ${madeCount} ahead (horizon ${HORIZON_DAYS}d), dropped ${droppedCount} past the ${RETENTION_DAYS}d window`,
  );
} catch (err) {
  console.error("[partitions] FAILED", err);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
