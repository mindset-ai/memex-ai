// Activation-funnel emitters (spec-297 dec-1) — the DIRECT-path user-scoped events.
//
// account.created / mcp.connected / mcp.tool_called are not mutations and have no
// Memex by nature, so they do NOT go through the mutate() bus (which would also
// forge a memex-scoped activity_log row). They are written by a DIRECT
// recordUsageEvent({ source:'backend' }) call instead:
//   - account.created  — fired when a brand-new user row is created (signup).
//   - mcp.connected     — fired on the MCP `initialize` handshake.
//   - mcp.tool_called   — fired once per MCP tool invocation (dec-3, not deduped).
//
// memex_id is NULL for the first two (pre-Memex / pre-tool) and the RESOLVED Memex
// for tool calls (NULL only for the Memex-agnostic tools list_memexes /
// get_information). memex_id is never forwarded to Mixpanel; the funnel keys on
// distinct_id (the user UUID). Each call is advisory — recordUsageEvent swallows
// its own failures, so a telemetry hiccup can never disturb signup, the handshake,
// or a tool call.

import type { UsageEvent } from "../db/schema.js";
import { recordUsageEvent } from "./usage-events.js";

/**
 * Funnel stage 1 — signup. Direct emission with a NULL Memex (the personal Memex
 * is provisioned lazily afterwards, so at account-creation time there is none).
 */
export async function recordAccountCreated(userId: string): Promise<UsageEvent | null> {
  return recordUsageEvent({
    memexId: null,
    actorUserId: userId,
    name: "account.created",
    source: "backend",
  });
}

/**
 * Funnel stage 3 — agent connected. Fired on the MCP `initialize` handshake, which
 * authenticates the user before any tool names a Memex, so memex_id is NULL.
 */
export async function recordMcpConnected(userId: string): Promise<UsageEvent | null> {
  return recordUsageEvent({
    memexId: null,
    actorUserId: userId,
    name: "mcp.connected",
    source: "backend",
  });
}

/**
 * Funnel stage 4 — first tool call. One event per invocation (dec-3). `toolName`
 * rides as a low-cardinality, non-PII property; `memexId` is the resolved Memex
 * (NULL only for the Memex-agnostic tools list_memexes / get_information).
 */
export async function recordMcpToolCalled(
  userId: string,
  toolName: string,
  memexId: string | null | undefined,
): Promise<UsageEvent | null> {
  return recordUsageEvent({
    memexId: memexId ?? null,
    actorUserId: userId,
    name: "mcp.tool_called",
    source: "backend",
    props: { tool_name: toolName },
  });
}

/**
 * The anonymous→identified stitch (spec-324 — the spec-244 retrofit). Emitted at
 * the identify moment (applyVisitorMerge) when a consented `visitor_id` first BINDS
 * to a user. It carries BOTH ids, so the sink stamps `$device_id` (the visitor) and
 * `$user_id` (the user) on one event and Mixpanel's Simplified ID Merge attributes
 * every pre-identity event the visitor generated to the now-known user — the whole
 * point of the visitor spine. memex_id is NULL (a pure identity signal). Advisory.
 */
export async function recordIdentityMerge(
  userId: string,
  visitorId: string,
): Promise<UsageEvent | null> {
  return recordUsageEvent({
    memexId: null,
    actorUserId: userId,
    visitorId,
    name: "identity.merged",
    source: "backend",
  });
}
