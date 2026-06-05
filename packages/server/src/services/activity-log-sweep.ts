// Pulse (b-60) retention sweep. The activity_log table is an append-only feed of
// reads + writes (see schema.ts → activityLog). Left unbounded it grows without
// limit, so we age out rows older than the retention window on a background cadence.
//
// Shape mirrors the existing housekeeping sweeps:
//   - auth-tokens.cleanupExpiredAuthTokens  (Mutated<number> via mutate())
//   - domain-verification.cleanupExpiredDomainVerificationTokens (plain number)
// (Invite tokens are intentionally NOT swept — expired rows are retained so an
//  expired link reports "expired" not "invalid"; see invite-tokens.ts.)
//
// We follow the domain-verification precedent and return a plain `number`: the
// delete is pure housekeeping on a log table and there is no bus subscriber to
// notify. (`activity_log` is intentionally NOT a ChangeEntity in bus.ts — Pulse
// emits per-row read/write events under entities like `query`/`tool_call`, not
// under an `activity_log` entity — so a mutate() wrap here would have no valid key.)

import { sql } from "drizzle-orm";
import { db } from "../db/connection.js";

// Per-pass cap. Bounds the work (and the row lock footprint) of a single DELETE so
// one sweep can't lock the table for an unbounded amount of time on a backlog. The
// scheduler simply runs again next tick; multiple passes drain a large backlog
// incrementally. Idempotent: once rows are within the window, every pass is a no-op.
const SWEEP_BATCH_LIMIT = 10_000;

const DEFAULT_RETENTION_DAYS = 30;

// Read PULSE_RETENTION_DAYS once at module load. Falls back to 30 days for any
// missing / non-numeric / non-positive value so a typo can never disable or invert
// the sweep (a zero/negative window would delete everything).
function resolveRetentionDays(): number {
  const raw = process.env.PULSE_RETENTION_DAYS;
  if (raw === undefined || raw === "") {
    return DEFAULT_RETENTION_DAYS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_RETENTION_DAYS;
  }
  return parsed;
}

export const PULSE_RETENTION_DAYS = resolveRetentionDays();

// Background-job entry point: deletes activity_log rows older than the retention
// window, capped at SWEEP_BATCH_LIMIT rows per call. Returns the number of rows
// deleted (for logging / loop control). Idempotent and safe to run concurrently
// across instances — the worst case is two passes contending over the same batch,
// which Postgres serialises via row locks; no row is double-counted.
//
// Implementation note: Drizzle's `db.delete()` builder has no `.limit()` for
// Postgres, and the cutoff must be computed in-DB (`now() - INTERVAL`) so every
// instance agrees on the boundary regardless of clock skew. We therefore issue raw
// SQL and bound the batch via a `ctid IN (SELECT … LIMIT N)` subselect. `RETURNING 1`
// + counting the rows avoids depending on the postgres-js driver's rowCount shape
// (same approach as doc-move.ts).
export async function sweepActivityLog(
  retentionDays: number = PULSE_RETENTION_DAYS,
  limit: number = SWEEP_BATCH_LIMIT,
): Promise<number> {
  const deleted = (await db.execute(sql`
    DELETE FROM activity_log
     WHERE ctid IN (
       SELECT ctid FROM activity_log
        WHERE created_at < now() - (${retentionDays} * INTERVAL '1 day')
        LIMIT ${limit}
     )
    RETURNING 1
  `)) as unknown as unknown[];
  return deleted.length;
}

// Scheduler registration. The orchestrator wires this into src/index.ts alongside
// the other periodic cleanups (invite-tokens, domain-verification). Returns the
// NodeJS.Timeout so the caller can `.unref()` it — matching the existing
// `setInterval(...).unref()` pattern so the timer never keeps the process alive
// during shutdown. One sweep per hour drains gradually; not time-critical.
const ONE_HOUR_MS = 60 * 60 * 1000;

export function startActivityLogSweep(): NodeJS.Timeout {
  return setInterval(async () => {
    try {
      const deleted = await sweepActivityLog();
      if (deleted > 0) {
        console.log(
          `[activity-log-sweep] deleted ${deleted} row(s) older than ${PULSE_RETENTION_DAYS}d`,
        );
      }
    } catch (err) {
      console.error("[activity-log-sweep] failed:", err);
    }
  }, ONE_HOUR_MS);
}
