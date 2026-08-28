// spec-398 — bounded retention for test_events + the durable first-verified snapshot.
//
// test_events is the OPERATIONAL tier: keep only the latest N runs per
// (subject_ref, test_identifier) (dec-1/dec-2). The one-time shrink is the rewrite-and-swap
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
 * Trim a single (subject_ref, test_identifier) group to its latest RETENTION_KEEP rows
 * by created_at DESC (id DESC as a deterministic tiebreak) — the steady-state
 * trim-on-write (ac-1). Scoped to the one pair: a narrow delete riding
 * test_events_retention_idx, no table lock, no cross-pair contention. A null
 * test_identifier collapses to '' to match the migration's partitioning and the
 * test_event_latest key.
 */
export async function trimTestEventsForPair(
  conn: Db,
  subjectRef: string,
  testIdentifier: string | null,
): Promise<void> {
  const key = testIdentifier ?? "";
  await conn.execute(sql`
    DELETE FROM test_events
    WHERE id IN (
      SELECT id FROM test_events
      WHERE subject_ref = ${subjectRef} AND COALESCE(test_identifier, '') = ${key}
      ORDER BY created_at DESC, id DESC
      OFFSET ${RETENTION_KEEP}
    )
  `);
}

/**
 * Record the earliest passing emission for an subject_ref into the durable
 * ac_first_verified snapshot (spec-398 t-6). LEAST-wins so the earliest survives
 * regardless of arrival order (out-of-order backfills, replays). Call only for
 * non-hidden passes — hidden emissions are excluded from verification signals.
 */
export async function recordFirstVerified(
  conn: Db,
  subjectRef: string,
  at: Date,
  memexId: string,
): Promise<void> {
  // Pass the timestamp as an ISO string + explicit cast: a raw drizzle `sql`
  // template has no column-type context, so postgres.js can't bind a bare Date.
  // spec-520 dec-7 option D (ac-34): the DO UPDATE is now predicated, so it stops
  // rewriting a row it is not changing.
  //
  // Without the WHERE, LEAST returns the value ALREADY STORED on every pass after the
  // first — so the statement wrote an identical date into a brand-new row version, every
  // time. Measured on prod 2026-08-28 as a 600s delta: 30.972 calls/s at 0.0496 ms, one
  // per passing event, ~21.3M lifetime updates that changed nothing. The statement still
  // runs; it now finds no row, so there is no new row version and no dead tuple.
  //
  // ⚠ THE WHERE MUST COMPARE, NOT JUST SUPPRESS. LEAST-wins exists for OUT-OF-ORDER
  // arrival — a replay or backfill carrying an EARLIER first pass must still win, or
  // "earliest pass" quietly becomes "first pass SEEN". `stored > EXCLUDED` fires exactly
  // when LEAST would actually change the value and never otherwise. A blanket
  // `DO NOTHING` would have been cheaper to write and would have broken that silently.
  //
  // LEAST is kept in the SET even though the WHERE already implies it: it states the
  // intent at the point of the write, and it keeps the statement correct if the predicate
  // is ever loosened.
  //
  // Note this is the COST half only. `ac_first_verified` still exists, is still read, and
  // still has no memex_id — see dec-7 for why the retirement (ac-23) was separated from
  // this and deliberately left open.
  await conn.execute(sql`
    INSERT INTO ac_first_verified (subject_ref, first_verified_at, memex_id)
    VALUES (${subjectRef}, ${at.toISOString()}::timestamptz, ${memexId}::uuid)
    ON CONFLICT (subject_ref) DO UPDATE
      SET first_verified_at = LEAST(ac_first_verified.first_verified_at, EXCLUDED.first_verified_at),
          -- spec-520 dec-7 option C: heal a NULL left by the 0136 backfill. A row whose ref
          -- had no surviving test_event_latest match could not be resolved at migration time;
          -- the next emission for it knows the memex and fills it in. Never OVERWRITES a
          -- resolved value — a ref cannot change tenant, so a differing value would be a bug
          -- worth keeping visible rather than silently reconciling.
          memex_id = COALESCE(ac_first_verified.memex_id, EXCLUDED.memex_id)
      WHERE ac_first_verified.first_verified_at > EXCLUDED.first_verified_at
         OR ac_first_verified.memex_id IS NULL
  `);
}
