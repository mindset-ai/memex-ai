// spec-482 t-2 — the MCP-connection SIGNAL: "has this user (or their org) EVER
// produced observed MCP traffic?"
//
// This is a HISTORICAL, MONOTONIC fact derived from real telemetry, NOT a
// self-reported flag. The truth is the presence of an `mcp.tool_called`
// usage_event — one is written per MCP invocation (recordMcpToolCalled in
// services/funnel-events.ts). Because we only ever COUNT rows that already
// exist and never store or clear a sticky flag, the answer can only ever go
// false→true and never revert: monotonic by construction.
//
// usage_events is RLS-EXCLUDED by design (schema.ts) — there is no memex_id
// scoping applied automatically. The user-level query is naturally user-scoped
// (it filters on actor_user_id). The ORG-level query MUST filter explicitly by
// the org's member user IDs, or it would leak cross-tenant traffic. We never
// count without an explicit actor_user_id predicate.

import { and, eq, inArray, sql } from "drizzle-orm";
import { db, type Db } from "../db/connection.js";
import { orgMemberships, usageEvents } from "../db/schema.js";

const MCP_TOOL_CALLED = "mcp.tool_called";

/**
 * True iff ≥1 `mcp.tool_called` usage_event exists for this user — i.e. the user
 * has EVER produced observed MCP traffic. Monotonic: no sticky flag, so once a
 * tool call is recorded this can never revert to false.
 */
export async function hasEverUsedMcp(userId: string, conn: Db = db): Promise<boolean> {
  const [row] = await conn
    .select({ n: sql<number>`count(*)::int` })
    .from(usageEvents)
    .where(and(eq(usageEvents.actorUserId, userId), eq(usageEvents.name, MCP_TOOL_CALLED)));
  return (row?.n ?? 0) > 0;
}

/**
 * True iff ANY member of the org has ≥1 `mcp.tool_called` usage_event — i.e.
 * someone in the org has EVER produced observed MCP traffic. Same monotonic
 * guarantee as the user-level signal.
 *
 * usage_events is RLS-excluded, so the query is scoped EXPLICITLY to the org's
 * member user IDs (via org_memberships); a different org's traffic can never
 * flip this true. Disabled memberships are retained for attribution but never
 * grant access (std-6), so only ACTIVE members count toward the org signal.
 */
export async function orgHasEverUsedMcp(orgId: string, conn: Db = db): Promise<boolean> {
  const members = await conn
    .select({ userId: orgMemberships.userId })
    .from(orgMemberships)
    .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.status, "active")));

  const memberIds = members.map((m) => m.userId);
  if (memberIds.length === 0) return false;

  const [row] = await conn
    .select({ n: sql<number>`count(*)::int` })
    .from(usageEvents)
    .where(and(inArray(usageEvents.actorUserId, memberIds), eq(usageEvents.name, MCP_TOOL_CALLED)));
  return (row?.n ?? 0) > 0;
}
