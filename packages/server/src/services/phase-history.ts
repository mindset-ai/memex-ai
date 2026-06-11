// spec-122 dec-3 (ac-13) — per-spec phase history derived from the spec-179
// status_changed journal rows in activity_log. NO phase_transitions table
// (ac-11): the ordered sequence of immutable {from, to} rows is the source, and
// dwell-time + thrash fall out of it.

import { and, asc, eq, sql } from "drizzle-orm";
import { db, type Db } from "../db/connection.js";
import { activityLog } from "../db/schema.js";

export interface PhaseTransition {
  from: string;
  to: string;
  at: Date;
  actorUserId: string | null;
  actorName: string | null;
  channel: string;
}

/**
 * The ordered phase-move history for one spec — every immutable
 * document|status_changed row, oldest first. This is what `documents.status` (a
 * single overwriting column) and `status_changed_at` (the latest move only)
 * cannot give: the full sequence.
 */
export async function getPhaseHistory(
  memexId: string,
  docId: string,
  conn: Db = db,
): Promise<PhaseTransition[]> {
  const rows = await conn
    .select({
      payload: activityLog.payload,
      at: activityLog.createdAt,
      actorUserId: activityLog.actorUserId,
      actorName: activityLog.actorName,
      channel: activityLog.channel,
    })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.memexId, memexId),
        eq(activityLog.briefId, docId),
        eq(activityLog.entity, "document"),
        eq(activityLog.action, "status_changed"),
      ),
    )
    .orderBy(asc(activityLog.createdAt), asc(activityLog.id));

  return rows.map((r) => {
    const p = (r.payload ?? {}) as { from?: string; to?: string };
    return {
      from: p.from ?? "",
      to: p.to ?? "",
      at: r.at,
      actorUserId: r.actorUserId,
      actorName: r.actorName,
      channel: r.channel,
    };
  });
}

export interface PhaseMetrics {
  /** Milliseconds the spec spent in each phase it ENTERED (held until the next move, or `now`). */
  dwellMsByPhase: Record<string, number>;
  /** Backward moves — a transition to an earlier phase (e.g. a verify→build bounce). */
  thrashCount: number;
  /** Total recorded transitions. */
  transitions: number;
}

const PHASE_ORDER = ["draft", "specify", "build", "verify", "done"] as const;
const rankOf = (phase: string): number => PHASE_ORDER.indexOf(phase as (typeof PHASE_ORDER)[number]);

/**
 * Derive dwell-time and thrash from an ordered phase history. Pure — the caller
 * supplies `now` so the function is deterministic and resume-safe.
 */
export function computePhaseMetrics(history: PhaseTransition[], now: Date): PhaseMetrics {
  const dwellMsByPhase: Record<string, number> = {};
  let thrashCount = 0;

  for (let i = 0; i < history.length; i++) {
    const t = history[i];
    // A move to a lower-ranked phase is a regression (thrash) — the canonical
    // case is a verify→build bounce.
    const fromRank = rankOf(t.from);
    const toRank = rankOf(t.to);
    if (fromRank >= 0 && toRank >= 0 && toRank < fromRank) thrashCount++;

    // The phase just entered (`to`) is held until the next move, or `now`.
    const enteredAt = t.at.getTime();
    const leftAt = (history[i + 1]?.at ?? now).getTime();
    dwellMsByPhase[t.to] = (dwellMsByPhase[t.to] ?? 0) + Math.max(0, leftAt - enteredAt);
  }

  return { dwellMsByPhase, thrashCount, transitions: history.length };
}

/** True iff this Memex has NO dedicated phase_transitions table — phase history rides activity_log (ac-11). */
export async function hasPhaseTransitionsTable(conn: Db = db): Promise<boolean> {
  const rows = await conn.execute(sql`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'phase_transitions'
  `);
  return (rows as unknown as unknown[]).length > 0;
}
