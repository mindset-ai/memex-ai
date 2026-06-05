// Maintenance for the `test_event_latest` summary table (spec-162).
//
// The summary is a derived "latest event per (ac_uid, test_identifier)" rollup
// over the append-only `test_events` log. It is maintained app-side at the two —
// and only two — sites that mutate `test_events` (spec-162 dec-1):
//   1. emission   → applyEmissionToSummary  (POST /api/test-events)
//   2. discontinue → removeSummaryForPair   (discontinueTestEventsForAc)
// Each caller wraps its log write and the summary write in a single
// db.transaction() so the log and its derived summary can never diverge on a
// crash. Both functions take the active connection/transaction as `conn`.

import { and, eq, sql } from "drizzle-orm";
import { type Db } from "../db/connection.js";
import { testEventLatest } from "../db/schema.js";

export interface EmissionForSummary {
  acUid: string;
  /** null when the emitting test sent no test_identifier; collapses to '' on write. */
  testIdentifier: string | null;
  status: "pass" | "fail" | "error";
  /** The log row's created_at (server `now()` in production). */
  latestRunAt: Date;
  /** spec-115: hidden emissions are stored in the log but excluded from badges. */
  hidden: boolean;
}

/**
 * Upsert the test_event_latest row for an emission's (ac_uid, test_identifier)
 * pair (spec-162 dec-1; ac-5, ac-6, ac-9).
 *
 * - Hidden emissions are skipped entirely — no row touched, no run_count bump
 *   (spec-115 semantics; ac-6).
 * - A null test_identifier collapses to '' so it shares one PK slot, mirroring
 *   the old JS reduce key `ev.testIdentifier ?? ""` (dec-2; ac-9).
 * - run_count ALWAYS increments (count of non-hidden emissions, matching the
 *   prior reduce). latest_status / latest_run_at advance ONLY when this event is
 *   at least as new as the stored one. In production every insert is the newest
 *   (created_at defaults to now()), so the guard is a no-op there; it only bites
 *   on out-of-order writes (test seeds, backfills).
 */
export async function applyEmissionToSummary(
  conn: Db,
  emission: EmissionForSummary,
): Promise<void> {
  if (emission.hidden) return;
  const testIdentifier = emission.testIdentifier ?? "";
  await conn
    .insert(testEventLatest)
    .values({
      acUid: emission.acUid,
      testIdentifier,
      latestStatus: emission.status,
      latestRunAt: emission.latestRunAt,
      runCount: 1,
    })
    .onConflictDoUpdate({
      target: [testEventLatest.acUid, testEventLatest.testIdentifier],
      set: {
        // Newest-wins for the displayed status: keep the existing status unless
        // the incoming event is at least as recent.
        latestStatus: sql`CASE WHEN excluded.latest_run_at >= ${testEventLatest.latestRunAt} THEN excluded.latest_status ELSE ${testEventLatest.latestStatus} END`,
        latestRunAt: sql`GREATEST(excluded.latest_run_at, ${testEventLatest.latestRunAt})`,
        // Every non-hidden emission counts, regardless of arrival order.
        runCount: sql`${testEventLatest.runCount} + 1`,
      },
    });
}

/**
 * Delete the test_event_latest row for a discontinued (ac_uid, test_identifier)
 * pair so it drops out of the badge immediately, leaving no stale 'latest'
 * (spec-162 dec-1; ac-7). The '' coercion mirrors the write path.
 */
export async function removeSummaryForPair(
  conn: Db,
  acUid: string,
  testIdentifier: string | null,
): Promise<void> {
  await conn
    .delete(testEventLatest)
    .where(
      and(
        eq(testEventLatest.acUid, acUid),
        eq(testEventLatest.testIdentifier, testIdentifier ?? ""),
      ),
    );
}
