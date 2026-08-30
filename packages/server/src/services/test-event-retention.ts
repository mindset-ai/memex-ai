// spec-520 t-12 — retention for test_events is AGE, enforced by partition drop.
//
// WHAT USED TO BE HERE. `trimTestEventsForPair` ran inside every emission transaction and
// deleted the pair's oldest rows past RETENTION_KEEP=10. It cost 13.4% of all database
// time and produced 11.24M deletes against 11.87M inserts — autovacuum ran near-
// continuously chasing the dead tuples it created. Retention is now a property of WHICH
// PARTITION a row lands in: rows leave only when an aged-out partition is dropped, which
// is a catalogue operation. No row deletion, no dead tuples, nothing for autovacuum to
// chase. The 13.4% does not shrink — it goes to zero.
//
// The window is CONFIGURATION, not a compiled-in constant, following spec-60 dec-6's
// precedent for activity_log (`PULSE_RETENTION_DAYS`). spec-62's W4 retention workstream
// has not pinned a schedule for this table — the ISO 27001 audit trail rides
// `change_events`, not `test_events` — so no floor is fixed today, but one may be later,
// and it must be a config change rather than a re-partitioning.
//
// ⚠ THE WINDOW IS NOT A DISPLAY BOUND. Measured on prod 2026-08-30, 196,978 of 243,339
// pairs had not run in three days: 81% of pairs hold NO row inside a 3-day window. The AC
// tab handles that through dec-9's carry-forward, reading the durable summary. Shortening
// this window makes more pairs carry-forward; it does not make them invisible.
//
// recordFirstVerified stays: ac_first_verified is the analytical tier that survives
// retention (spec-125), and dec-7 deliberately declined to retire it.

import { sql } from "drizzle-orm";
import { type Db } from "../db/connection.js";

const DEFAULT_RETENTION_DAYS = 3;

/**
 * How many days of raw emissions are retained, from TEST_EVENTS_RETENTION_DAYS.
 *
 * Read once at module load and clamped, mirroring `PULSE_RETENTION_DAYS`. A missing,
 * non-numeric or non-positive value falls back to the default: a zero or negative window
 * would mean "drop every partition", so a typo must never be able to express it.
 *
 * The upper clamp is not tidiness. At ~2.68M emissions/day (spec-520 c-12) each retained
 * day is roughly 2.7M rows; 3 days is ~8M and 30 days is ~80M. An accidental extra zero in
 * an env var would silently commit the database to an order of magnitude more storage and
 * scan cost, and nothing downstream would complain until it hurt.
 */
const MAX_RETENTION_DAYS = 90;

function resolveRetentionDays(): number {
  const raw = process.env.TEST_EVENTS_RETENTION_DAYS;
  if (raw === undefined || raw === "") return DEFAULT_RETENTION_DAYS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RETENTION_DAYS;
  return Math.min(parsed, MAX_RETENTION_DAYS);
}

export const TEST_EVENTS_RETENTION_DAYS = resolveRetentionDays();

/**
 * How many days of partitions are created AHEAD of today.
 *
 * A partitioned table with no partition for an incoming row rejects the INSERT outright
 * ("no partition of relation found for row") — proven on pg16 2026-08-30. That is a loud,
 * immediate failure rather than a silent one, which is the right direction, but it must
 * never be reachable: maintenance runs at DEPLOY time, so the horizon has to outlast any
 * realistic gap between deploys.
 *
 * ⚠ A DEFAULT PARTITION IS NOT THE ANSWER, and this was measured rather than assumed.
 * Once rows for a given day land in a DEFAULT partition, creating that day's real
 * partition FAILS outright:
 *
 *     ERROR: updated partition constraint for default partition would be violated by
 *            some row
 *
 * So a default would convert a quiet no-deploy gap into a migration that cannot apply
 * until someone drains it by hand — a worse failure than the one it was meant to prevent.
 *
 * Sixty days costs nothing: creating 61 daily partitions measured 122 ms, and the
 * idempotent re-run 2 ms (local pg16, 2026-08-30).
 */
export const PARTITION_HORIZON_DAYS = 60;

/**
 * The partition name for a UTC day — `test_events_YYYYMMDD`. One function, used by both
 * the maintenance script and the tests, so a naming drift cannot make maintenance silently
 * create duplicates alongside the ones it should have found.
 */
export function partitionNameFor(day: Date): string {
  const y = day.getUTCFullYear();
  const m = String(day.getUTCMonth() + 1).padStart(2, "0");
  const d = String(day.getUTCDate()).padStart(2, "0");
  return `test_events_${y}${m}${d}`;
}

/**
 * Record the earliest passing emission for a subject_ref into the durable
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
  // spec-520 dec-7 option D (ac-34): the DO UPDATE is predicated, so it stops
  // rewriting a row it is not changing.
  //
  // ⚠ THE WHERE MUST COMPARE, NOT JUST SUPPRESS. LEAST-wins exists for OUT-OF-ORDER
  // arrival — a replay or backfill carrying an EARLIER first pass must still win, or
  // "earliest pass" quietly becomes "first pass SEEN". `stored > EXCLUDED` fires exactly
  // when LEAST would actually change the value and never otherwise. A blanket
  // `DO NOTHING` would have been cheaper to write and would have broken that silently.
  await conn.execute(sql`
    INSERT INTO ac_first_verified (subject_ref, first_verified_at, memex_id)
    VALUES (${subjectRef}, ${at.toISOString()}::timestamptz, ${memexId}::uuid)
    ON CONFLICT (subject_ref) DO UPDATE
      SET first_verified_at = LEAST(ac_first_verified.first_verified_at, EXCLUDED.first_verified_at),
          -- spec-520 dec-7 option C: heal a NULL left by the 0136 backfill. Never
          -- OVERWRITES a resolved value — a ref cannot change tenant, so a differing value
          -- would be a bug worth keeping visible rather than silently reconciling.
          memex_id = COALESCE(ac_first_verified.memex_id, EXCLUDED.memex_id)
      WHERE ac_first_verified.first_verified_at > EXCLUDED.first_verified_at
         OR ac_first_verified.memex_id IS NULL
  `);
}
