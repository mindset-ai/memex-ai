// spec-427 t-5 (dec-2) — the per-user activation cohort primitive that t-7's ladder
// consumes. Cohorts are derived at SEND TIME from the reliable `users` row + funnel
// state, NEVER from the `account.created` event (ac-8: an SSO/magic-link user emits no
// account.created but must still be evaluated). We reuse the existing per-user
// derivation in journey-state.ts (getUserMilestones — usage_events for mcp.connected /
// mcp.tool_called, documents for the spec count) rather than invent parallel flags.
//
// The two cohorts are mutually exclusive by construction: connected-inactive requires
// MCP connected; signed-in-dormant requires MCP never connected.

import { and, eq, sql } from "drizzle-orm";
import { db, type Db } from "../db/connection.js";
import { users, usageEvents } from "../db/schema.js";
import { getUserMilestones } from "./journey-state.js";

export type ActivationCohort = "connected_inactive" | "signed_in_dormant";

export interface ActivationState {
  /** Which activation email the user currently qualifies for, or null (activated / ineligible). */
  cohort: ActivationCohort | null;
  /** When the user entered that cohort — the dwell anchor t-7 measures its timer against. */
  enteredAt: Date | null;
}

/** The funnel signals the cohort ladder keys on. */
export interface ActivationSignals {
  /** Set by all three auth paths (password verify, SSO, magic-link) — the "verified signup" gate. */
  emailVerifiedAt: Date | null;
  mcpConnected: boolean;
  mcpToolCalled: boolean;
  hasSpec: boolean;
}

/**
 * The PURE cohort ladder (dec-2). At most one cohort per user; evaluated live.
 *   Email 1 — connected-but-inactive: MCP connected AND no tool call AND no spec.
 *             The hard "MCP connected" gate is what makes the two cohorts disjoint.
 *   Email 2 — signed-in-but-dormant: verified signup AND MCP never connected.
 * Anyone who has called a tool or created a spec (activated), or who is unverified,
 * qualifies for neither → null.
 */
export function classifyActivationCohort(s: ActivationSignals): ActivationCohort | null {
  if (s.mcpConnected && !s.mcpToolCalled && !s.hasSpec) return "connected_inactive";
  if (!s.mcpConnected && s.emailVerifiedAt) return "signed_in_dormant";
  return null;
}

// Earliest mcp.connected event time — the dwell anchor for the connected-inactive
// cohort. usage_events has no RLS, so no runWithUserId wrapping is needed here.
async function firstMcpConnectedAt(userId: string, conn: Db): Promise<Date | null> {
  const [row] = await conn
    // min() comes back as a timestamp string from the driver — coerce to Date below.
    .select({ at: sql<string | null>`min(${usageEvents.occurredAt})` })
    .from(usageEvents)
    .where(and(eq(usageEvents.actorUserId, userId), eq(usageEvents.name, "mcp.connected")));
  return row?.at ? new Date(row.at) : null;
}

/**
 * Evaluate a user's current activation state (cohort + dwell anchor). Reads the users
 * row and reuses getUserMilestones (which self-wraps in the user's RLS context). Returns
 * `{cohort:null}` for an activated, unverified, or unknown user. The dwell anchor is the
 * cohort-entry time: first mcp.connected for connected-inactive, email_verified_at for
 * signed-in-dormant.
 */
export async function evaluateActivationState(userId: string, conn: Db = db): Promise<ActivationState> {
  const [u] = await conn
    .select({ emailVerifiedAt: users.emailVerifiedAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!u) return { cohort: null, enteredAt: null };

  const m = await getUserMilestones(userId, conn);
  const cohort = classifyActivationCohort({
    emailVerifiedAt: u.emailVerifiedAt,
    mcpConnected: m.mcpConnected,
    mcpToolCalled: m.mcpToolCalled,
    hasSpec: m.hasSpec,
  });

  if (cohort === "connected_inactive") {
    return { cohort, enteredAt: await firstMcpConnectedAt(userId, conn) };
  }
  if (cohort === "signed_in_dormant") {
    return { cohort, enteredAt: u.emailVerifiedAt };
  }
  return { cohort: null, enteredAt: null };
}
