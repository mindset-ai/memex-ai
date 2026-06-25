// spec-398 — bounded retention for test_events + the durable first-verified snapshot.
//
// test_events is the OPERATIONAL tier: keep only the latest N runs per
// (ac_uid, test_identifier) (dec-1/dec-2). The one-time shrink is the rewrite-and-swap
// in migration 0111; THIS module is the steady-state trim-on-write, called inside the
// emission transaction so the log never grows unbounded between deploys.
//
// recordFirstVerified maintains ac_first_verified — the analytical tier that survives
// retention (spec-125), so analytics.acsOverTime keeps a true "first went green" date
// even after the oldest passing row is trimmed away.

import { sql } from "drizzle-orm";
import { type Db } from "../db/connection.js";

// dec-2 (ac-2): retention is by COUNT, not age. N=10 fixed.
export const RETENTION_KEEP = 10;

/**
 * Trim a single (ac_uid, test_identifier) group to its latest RETENTION_KEEP rows
 * by created_at DESC (id DESC as a deterministic tiebreak) — the steady-state
 * trim-on-write (ac-1). Scoped to the one pair: a narrow delete riding
 * test_events_retention_idx, no table lock, no cross-pair contention. A null
 * test_identifier collapses to '' to match the migration's partitioning and the
 * test_event_latest key.
 */
export async function trimTestEventsForPair(
  conn: Db,
  acUid: string,
  testIdentifier: string | null,
): Promise<void> {
  const key = testIdentifier ?? "";
  await conn.execute(sql`
    DELETE FROM test_events
    WHERE id IN (
      SELECT id FROM test_events
      WHERE ac_uid = ${acUid} AND COALESCE(test_identifier, '') = ${key}
      ORDER BY created_at DESC, id DESC
      OFFSET ${RETENTION_KEEP}
    )
  `);
}

/**
 * Record the earliest passing emission for an ac_uid into the durable
 * ac_first_verified snapshot (spec-398 t-6). LEAST-wins so the earliest survives
 * regardless of arrival order (out-of-order backfills, replays). Call only for
 * non-hidden passes — hidden emissions are excluded from verification signals.
 */
export async function recordFirstVerified(
  conn: Db,
  acUid: string,
  at: Date,
): Promise<void> {
  // Pass the timestamp as an ISO string + explicit cast: a raw drizzle `sql`
  // template has no column-type context, so postgres.js can't bind a bare Date.
  await conn.execute(sql`
    INSERT INTO ac_first_verified (ac_uid, first_verified_at)
    VALUES (${acUid}, ${at.toISOString()}::timestamptz)
    ON CONFLICT (ac_uid) DO UPDATE
      SET first_verified_at = LEAST(ac_first_verified.first_verified_at, EXCLUDED.first_verified_at)
  `);
}
