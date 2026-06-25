import { eq, sql } from "drizzle-orm";
import type { PgTable, PgColumn } from "drizzle-orm/pg-core";
import { db } from "../../db/connection.js";
import { pgError } from "./pg-error.js";

/**
 * Returns the next sequence number for a given table/column,
 * scoped by a filter column (e.g. docId or conversationId).
 *
 * Reads `COALESCE(MAX(seq), 0) + 1` from the table — a read-then-write
 * pattern that is racy under concurrent inserts. Combine with
 * {@link withSeqRetry} when callers may compete for the next seq under
 * a `UNIQUE(<filter>, seq)` constraint (b-36 T-2: doc_comments,
 * doc_sections).
 */
export async function nextSeq(
  table: PgTable,
  seqColumn: PgColumn,
  filterColumn: PgColumn,
  filterValue: string
): Promise<number> {
  const [result] = await db
    .select({ maxSeq: sql<number>`coalesce(max(${seqColumn}), 0)` })
    .from(table)
    .where(eq(filterColumn, filterValue));
  return (result.maxSeq ?? 0) + 1;
}

/**
 * Retry an insert that allocates a per-doc seq on `UNIQUE(doc_id, seq)`
 * collision. Two concurrent inserts can both read the same `MAX(seq)`
 * and both try to commit `seq = N+1` — Postgres lets the first one
 * through and raises 23505 (unique_violation) on the second. Re-running
 * the allocator + insert recovers cleanly because by the time we retry,
 * the first row is visible and `MAX(seq)` now reflects it.
 *
 * Only retries on the named per-doc-seq unique constraints (so an
 * unrelated 23505 — e.g. the `(doc_id, section_type)` constraint —
 * surfaces immediately and reaches the caller's existing error handler).
 *
 * @param fn         The allocator + insert. Must re-read MAX(seq) on each call.
 * @param constraint The constraint name to watch for (e.g. `doc_comments_doc_seq_unique`).
 * @param maxAttempts Cap on retries. Sized to the worst case, not the typical
 *                   one: with N writers racing on the same doc, each retry
 *                   round commits exactly one winner, so the unluckiest
 *                   writer needs N attempts. The old cap of 5 was provably
 *                   insufficient for 6+ concurrent creates (the concurrency
 *                   test fires exactly 6 and flaked on slow CI runners where
 *                   the race window is widest). 12 absorbs realistic bursts
 *                   while still turning a pathological livelock into a clear
 *                   error rather than an infinite loop.
 */
export async function withSeqRetry<T>(
  fn: () => Promise<T>,
  constraint: string,
  maxAttempts = 12,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isSeqConflict(err, constraint)) throw err;
      // Retry: the next call to nextSeq will see the committed competitor row.
    }
  }
  throw lastErr;
}

function isSeqConflict(err: unknown, constraint: string): boolean {
  const e = pgError(err);
  if (!e || e.code !== "23505") return false;
  if (e.constraint_name === constraint) return true;
  // postgres-js exposes the constraint via `constraint_name`; if missing fall
  // back to a string match on the message so we don't accidentally swallow
  // unrelated 23505s with no constraint metadata.
  return typeof e.message === "string" && e.message.includes(constraint);
}
