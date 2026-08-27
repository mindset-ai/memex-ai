// Maintenance for the `test_run_daily` rollup (spec-520 dec-5 / t-9).
//
// The durable, ANALYTICAL tier over the test-event firehose, alongside
// `test_event_latest`'s OPERATIONAL one — spec-125's split applied to this path
// instead of patched around per metric.
//
// Grain: one row per test, per subject, per UTC day, carrying how many times it
// ran and how many times it passed / failed / errored.
//
// Why it exists: the history we believed we kept does not exist. The retention
// trim caps raw `test_events` at RETENTION_KEEP rows per pair, so the two
// history consumers (`testRunVolume`, `listAcAlignmentOverTime`) count rows that
// have already been deleted — and hardest for the busiest ACs, which are exactly
// the pairs that hit the cap. Counting at write time and keeping the counts is
// what makes the raw log droppable at all (t-12).
//
// This mirrors `applyEmissionToSummary` (test-event-latest.ts) on purpose: same
// `conn`-takes-a-transaction shape, same hidden-skip rule, same collapse of a
// null test_identifier to ''. When one changes, look at the other.

import { sql } from "drizzle-orm";
import { type Db } from "../db/connection.js";
import { testRunDaily } from "../db/schema.js";

export interface EmissionForRollup {
  subjectRef: string;
  /** The emitting Memex — first-class here [per std-32], never parsed from the ref. */
  memexId: string;
  /** null when the emitting test sent no test_identifier; collapses to '' on write. */
  testIdentifier: string | null;
  status: "pass" | "fail" | "error";
  /** The log row's created_at (server `now()` in production). Fixes the UTC day. */
  runAt: Date;
  /** spec-115: hidden emissions are stored in the log but excluded from counts. */
  hidden: boolean;
}

/**
 * The UTC calendar day an emission counts against.
 *
 * Derived in JS from the event's own timestamp rather than in SQL, so the day a
 * row lands on cannot drift with the session's TimeZone setting — the value is
 * fixed by the emission, identically in dev, CI and prod. `toISOString()` is
 * always UTC, so slicing its date part is exact rather than approximate.
 */
export function utcDayFor(runAt: Date): string {
  return runAt.toISOString().slice(0, 10);
}

/**
 * Increment the rollup row for an emission's (memex, subject, test, day) key.
 *
 * - Hidden emissions are skipped entirely, matching `applyEmissionToSummary`.
 * - A null test_identifier collapses to '' so it shares one PK slot.
 * - `run_count` and exactly ONE outcome count advance per emission. That is the
 *   invariant the table's `test_run_daily_counts_sum` CHECK enforces, so a
 *   miscount here fails the write rather than surfacing in a chart weeks later.
 *
 * Increments are expressed as `+ excluded.<col>` rather than `+ 1` so the same
 * statement stays correct if this is ever fed multi-row values (t-12's follow-on
 * coalescing): each conflicting row then adds exactly what it brought.
 */
export async function applyEmissionToRollup(
  conn: Db,
  emission: EmissionForRollup,
): Promise<void> {
  if (emission.hidden) return;
  const testIdentifier = emission.testIdentifier ?? "";
  const isPass = emission.status === "pass" ? 1 : 0;
  const isFail = emission.status === "fail" ? 1 : 0;
  const isError = emission.status === "error" ? 1 : 0;

  await conn
    .insert(testRunDaily)
    .values({
      memexId: emission.memexId,
      subjectRef: emission.subjectRef,
      testIdentifier,
      day: utcDayFor(emission.runAt),
      runCount: 1,
      passCount: isPass,
      failCount: isFail,
      errorCount: isError,
    })
    .onConflictDoUpdate({
      target: [
        testRunDaily.memexId,
        testRunDaily.subjectRef,
        testRunDaily.testIdentifier,
        testRunDaily.day,
      ],
      set: {
        runCount: sql`${testRunDaily.runCount} + excluded.run_count`,
        passCount: sql`${testRunDaily.passCount} + excluded.pass_count`,
        failCount: sql`${testRunDaily.failCount} + excluded.fail_count`,
        errorCount: sql`${testRunDaily.errorCount} + excluded.error_count`,
      },
    });
}
