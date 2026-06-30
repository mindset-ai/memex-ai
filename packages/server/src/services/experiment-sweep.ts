// Experiments verdict sweep (spec-426 dec-1). The experiment construct settles its
// outcome the way spec-109 mandates: Memex *tallies decided booleans*, it never
// aggregates a firehose. The decision is "did `hasSpec` flip true within the
// per-experiment window (dec-2)" — a non-occurrence within a window, so something
// must watch a clock. This background sweep is that clock.
//
// Shape mirrors the existing housekeeping schedulers exactly:
//   - activity-log-sweep.startActivityLogSweep  (in-process setInterval, .unref()'d)
//   - comms-log.startCommsLogPrune              (same, env-tunable cadence)
//
// Each pass reads `pending` assignments whose experiment is `running`, asks
// services/experiments.computeVerdict for each verdict, and stamps `succeeded` /
// `failed` + `decided_at` on those that resolve. It is:
//   - bounded per pass (SWEEP_BATCH_LIMIT) so one pass can't lock the table on a
//     backlog — the scheduler simply runs again next tick;
//   - idempotent and safe to run concurrently across instances — every UPDATE
//     re-asserts `outcome = 'pending'` in its WHERE, so two passes contending over
//     the same assignment can't double-stamp or clobber a verdict;
//   - a NO-OP once every live assignment is decided (nothing matches `pending`).

import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/connection.js";
import { experimentAssignments, experiments } from "../db/schema.js";
import { computeVerdict } from "./experiments.js";

// Per-pass cap. Bounds the work (and the row-lock footprint) of a single sweep so a
// backlog drains incrementally across ticks rather than holding locks for an
// unbounded time. Idempotent: once assignments are decided, every pass is a no-op.
const SWEEP_BATCH_LIMIT = 1_000;

const DEFAULT_SWEEP_INTERVAL_MS = 3 * 60 * 60 * 1000; // 3 hours (dec-1)

// Read EXPERIMENT_SWEEP_INTERVAL_MS once at module load. Falls back to the 3-hour
// default for any missing / non-numeric / non-positive value so a typo can never
// disable or invert the cadence (a zero/negative interval would busy-loop).
function resolveSweepIntervalMs(): number {
  const raw = process.env.EXPERIMENT_SWEEP_INTERVAL_MS;
  if (raw === undefined || raw === "") {
    return DEFAULT_SWEEP_INTERVAL_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SWEEP_INTERVAL_MS;
  }
  return parsed;
}

export const EXPERIMENT_SWEEP_INTERVAL_MS = resolveSweepIntervalMs();

// One sweep pass. Loads up to `limit` ACTIVE (`superseded_at IS NULL`) `pending`
// assignments whose experiment is `running`, computes each verdict, and stamps the
// ones that resolve. Returns the number of assignments newly decided (for logging /
// loop control). Superseded history rows are intentionally excluded — a superseded
// assignment is frozen history (spec-426: one active assignment per user/experiment),
// never re-decided. Concluded/draft experiments are excluded by the `running` filter,
// so a concluded experiment's verdicts stay frozen.
//
// Idempotent and concurrency-safe: the verdict is computed read-only, then each
// resolving row is stamped with an UPDATE that re-asserts `outcome = 'pending'` in
// its WHERE. Two instances racing the same batch therefore serialise via row locks
// and the second update no-ops — no row is double-stamped.
export async function sweepExperimentVerdicts(limit: number = SWEEP_BATCH_LIMIT): Promise<number> {
  const rows = await db
    .select({ assignment: experimentAssignments, experiment: experiments })
    .from(experimentAssignments)
    .innerJoin(experiments, eq(experimentAssignments.experimentId, experiments.id))
    .where(
      and(
        eq(experimentAssignments.outcome, "pending"),
        isNull(experimentAssignments.supersededAt),
        eq(experiments.status, "running"),
      ),
    )
    .limit(limit);

  let decided = 0;
  for (const { assignment, experiment } of rows) {
    const verdict = await computeVerdict(assignment, experiment.windowDays);
    if (verdict !== "succeeded" && verdict !== "failed") {
      // Still pending — the window is open and `hasSpec` has not flipped. Leave it
      // for a later pass; nothing to stamp.
      continue;
    }
    const stamped = (await db
      .update(experimentAssignments)
      .set({ outcome: verdict, decidedAt: new Date() })
      .where(
        and(
          eq(experimentAssignments.id, assignment.id),
          // Re-assert pending so a concurrent pass that already decided this row is a
          // no-op — keeps the sweep idempotent and safe across instances.
          eq(experimentAssignments.outcome, "pending"),
        ),
      )
      .returning({ id: experimentAssignments.id })) as Array<{ id: string }>;
    decided += stamped.length;
  }
  return decided;
}

// Scheduler registration. Wired into src/index.ts alongside the other periodic jobs
// (startActivityLogSweep / startCommsLogPrune). Returns the NodeJS.Timeout so the
// caller can `.unref()` it — matching the existing `setInterval(...).unref()` pattern
// so the timer never holds the process open during shutdown. A failed pass just
// retries next tick; the verdict is at most one cadence (~3h) late.
export function startExperimentSweep(
  intervalMs: number = EXPERIMENT_SWEEP_INTERVAL_MS,
): NodeJS.Timeout {
  return setInterval(async () => {
    try {
      const decided = await sweepExperimentVerdicts();
      if (decided > 0) {
        console.log(`[experiment-sweep] decided ${decided} assignment verdict(s)`);
      }
    } catch (err) {
      console.error("[experiment-sweep] failed (will retry next tick):", err);
    }
  }, intervalMs);
}
