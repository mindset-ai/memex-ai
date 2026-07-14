// spec-482 t-3 (ac-11) — the phase high-water mark: the furthest workflow phase
// transition a user has EVER personally completed VIA MCP, as one monotonic
// ordinal per user. A DERIVED query over activity_log status_changed rows scoped
// to channel='mcp' — NO dedicated table (the same journal-is-the-source posture
// as phase-history.ts, spec-122 ac-11). Transitions driven through the web UI
// (channel='rest_ui') never advance the mark; it only ever moves forward.

import { PHASE_ORDER } from "@memex/shared";
import { and, eq } from "drizzle-orm";
import { db, type Db } from "../db/connection.js";
import { activityLog } from "../db/schema.js";

/** One monotonic ordinal per user: the furthest MCP-driven phase transition ever completed. */
export type PhaseWatermark = "none" | "specify_build" | "build_verify" | "verify_done";

// The three forward workflow transitions, keyed by the phase ENTERED (`payload.to`):
// specify→build lands on `build`, build→verify on `verify`, verify→done on `done`.
// A row entering `draft`/`specify` carries no forward transition and never advances the mark.
const TRANSITION_BY_TO: Record<string, Exclude<PhaseWatermark, "none">> = {
  build: "specify_build",
  verify: "build_verify",
  done: "verify_done",
};

// spec-355 dry-2 / phase-history.ts — PHASE_ORDER from @memex/shared is the single
// source of ordering. A transition ranks by the phase it ENTERS, so a monotonic max
// over ranks can never regress even if a later row records an earlier phase.
const rankOf = (phase: string): number => PHASE_ORDER.indexOf(phase as (typeof PHASE_ORDER)[number]);

/**
 * The furthest workflow phase transition this user has EVER personally completed
 * VIA MCP. Only `channel='mcp'` status_changed rows attributed to `userId` count;
 * web-UI (`rest_ui`) moves are ignored. Monotonic: returns the max-rank transition
 * ever seen, so out-of-order or backward rows cannot pull the mark down.
 */
export async function getPhaseHighWaterMark(userId: string, conn: Db = db): Promise<PhaseWatermark> {
  const rows = await conn
    .select({ payload: activityLog.payload })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.action, "status_changed"),
        eq(activityLog.channel, "mcp"),
        eq(activityLog.actorUserId, userId),
      ),
    );

  let best: PhaseWatermark = "none";
  let bestRank = -1;
  for (const r of rows) {
    const to = ((r.payload ?? {}) as { to?: string }).to ?? "";
    const transition = TRANSITION_BY_TO[to];
    if (!transition) continue;
    const rank = rankOf(to);
    if (rank > bestRank) {
      bestRank = rank;
      best = transition;
    }
  }
  return best;
}
