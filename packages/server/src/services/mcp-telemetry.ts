// MCP tool-call telemetry — per-session client identity + per-call audit trail.
//
// Two responsibilities:
//   1. `upsertSession` — called from /mcp on every request. ON CONFLICT DO
//      UPDATE refreshes last_seen_at and COALESCEs new non-null identity
//      fields into existing nulls. The first call for a session_id (often the
//      `initialize` POST) populates client_info; subsequent calls don't carry
//      it. We never overwrite a known value with a later null.
//   2. `logToolCall` — called from the tool-handler wrap in mcp/tools.ts on
//      every invocation. Error-swallowing — a logging failure must NEVER
//      bubble back into the tool path.
//
// Capture policy (mirrored from drizzle/0062_add_mcp_tool_calls.sql):
//   * args_json: always captured.
//   * result_text: dev-mode only. isDevMode() gate enforced here so callers
//     don't have to remember.
//   * error: always captured.

import { eq, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  mcpSessions,
  mcpToolCalls,
  memexes,
  namespaces,
  orgs,
} from "../db/schema.js";
import { isDevMode } from "../middleware/session.js";

function log(...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.error("[mcp-telemetry]", ...args);
}

// User-Agent parser — best-effort split into name + version.
// MCP clients seen in the wild (spike data):
//   "claude-code/2.1.145 (claude-vscode, agent-sdk/0.3.145)"  → name=claude-code, version=2.1.145
//   "curl-probe/0.0.1"                                        → name=curl-probe, version=0.0.1
//   "cursor/0.42.3"                                           → name=cursor, version=0.42.3
//   "Mozilla/5.0 ..."                                         → name=Mozilla, version=5.0 (fine — UA is preserved raw too)
//
// Exported for unit testing — the parsing is small enough that a regression
// here would silently degrade analytics without any other signal.
export function parseUserAgent(ua: string | null | undefined): {
  name: string | null;
  version: string | null;
} {
  if (!ua) return { name: null, version: null };
  // First token of the form "name/version" — everything after the first space
  // is parens / extras we don't care about for the rollup columns.
  const firstToken = ua.split(/\s+/, 1)[0] ?? "";
  const slash = firstToken.indexOf("/");
  if (slash <= 0) return { name: firstToken || null, version: null };
  const name = firstToken.slice(0, slash);
  const version = firstToken.slice(slash + 1);
  return {
    name: name || null,
    version: version || null,
  };
}

// X-Forwarded-For can be a comma-separated chain when there are multiple
// proxies — the original client is the first entry. Cloud Run sets a single
// entry but we normalise for safety.
export function parseClientIp(xff: string | null | undefined): string | null {
  if (!xff) return null;
  const first = xff.split(",")[0]?.trim();
  return first || null;
}

export interface UpsertSessionInput {
  sessionId: string;
  userId: string;
  userAgent: string | null;
  clientInfo: unknown | null;
  ipAddress: string | null;
}

/**
 * Idempotent session row. Called from /mcp on every request. Safe to call
 * many times per session — ON CONFLICT refreshes last_seen_at and only
 * back-fills identity columns that are still null (initialize-only fields
 * like client_info arrive later than the first SSE GET).
 *
 * Error-swallowing: a telemetry failure must never break the MCP request.
 */
export async function upsertSession(input: UpsertSessionInput): Promise<void> {
  try {
    const { name, version } = parseUserAgent(input.userAgent);
    await db
      .insert(mcpSessions)
      .values({
        sessionId: input.sessionId,
        userId: input.userId,
        clientName: name,
        clientVersion: version,
        userAgent: input.userAgent,
        // jsonb column accepts the structured object directly.
        clientInfo: input.clientInfo ?? null,
        ipAddress: input.ipAddress,
      })
      .onConflictDoUpdate({
        target: mcpSessions.sessionId,
        set: {
          lastSeenAt: sql`now()`,
          // COALESCE so a later request never overwrites a known value with
          // null. Particularly important for client_info (only the
          // initialize POST carries it).
          clientName: sql`COALESCE(${mcpSessions.clientName}, EXCLUDED.client_name)`,
          clientVersion: sql`COALESCE(${mcpSessions.clientVersion}, EXCLUDED.client_version)`,
          userAgent: sql`COALESCE(${mcpSessions.userAgent}, EXCLUDED.user_agent)`,
          clientInfo: sql`COALESCE(${mcpSessions.clientInfo}, EXCLUDED.client_info)`,
          ipAddress: sql`COALESCE(${mcpSessions.ipAddress}, EXCLUDED.ip_address)`,
        },
      });
  } catch (err) {
    log("upsertSession failed", err);
  }
}

export interface LogToolCallInput {
  sessionId: string;
  userId: string;
  // The memex this call acted on. Undefined / null for tools that don't
  // touch a specific memex (list_memexes, get_information) or calls that
  // errored before any resolver ran. Captured server-side by the
  // mcp/tools.ts telemetry wrap from the ctx.resolveMemex / resolveRef /
  // resolveMemexFromEntity calls — never trusted from the client.
  memexId?: string | null;
  toolName: string;
  args: unknown;
  durationMs: number;
  error?: string | null;
  resultText?: string | null;
}

// Resolve the owning org for a memex. Returns NULL for personal-kind
// namespaces (no owning org). Exported for direct testing.
//
// Implementation: memex → namespace → (LEFT JOIN) orgs. The LEFT JOIN
// is the load-bearing part — personal namespaces have no row in orgs,
// and we want NULL not "no rows" in that case.
export async function lookupOrgForMemex(memexId: string): Promise<string | null> {
  try {
    const [row] = await db
      .select({ orgId: orgs.id })
      .from(memexes)
      .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
      .leftJoin(orgs, eq(orgs.namespaceId, namespaces.id))
      .where(eq(memexes.id, memexId))
      .limit(1);
    return row?.orgId ?? null;
  } catch (err) {
    log("lookupOrgForMemex failed", { memexId, err });
    return null;
  }
}

// Cap on stored error text. The wrap in mcp/tools.ts now sends full
// `${err.name}: ${err.message}\n${err.stack}`, which is what we want — the
// telemetry row should be debuggable without hunting Cloud Run logs by
// request id. 8 KB is comfortably more than any sane V8 stack and well
// under PostgreSQL TEXT's practical row size.
const MAX_ERROR_LENGTH = 8_000;
// Cap on stored result text (dev-only). Big enough for a verbose tool
// response but bounded so a pathological return doesn't wedge the row.
const MAX_RESULT_TEXT_LENGTH = 16_000;

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…[truncated ${s.length - max}]`;
}

/**
 * Persist one tool-call row. Called from the tool-handler wrap in
 * mcp/tools.ts AFTER the tool returns (or throws). Error-swallowing — a
 * logging failure must NEVER bubble back into the tool path.
 *
 * `resultText` is captured ONLY in dev mode. In production the column stays
 * NULL until per-customer opt-in lands.
 */
export async function logToolCall(input: LogToolCallInput): Promise<void> {
  try {
    const error = input.error ? clip(input.error, MAX_ERROR_LENGTH) : null;
    const resultText =
      isDevMode() && input.resultText
        ? clip(input.resultText, MAX_RESULT_TEXT_LENGTH)
        : null;
    // Derive org_id from memex_id at insert time so analytics queries
    // don't need a 3-table join every time. lookupOrgForMemex returns
    // null for personal-kind memexes (no owning org).
    const memexId = input.memexId ?? null;
    const orgId = memexId ? await lookupOrgForMemex(memexId) : null;
    await db.insert(mcpToolCalls).values({
      sessionId: input.sessionId,
      userId: input.userId,
      memexId,
      orgId,
      toolName: input.toolName,
      argsJson: input.args ?? {},
      durationMs: input.durationMs,
      error,
      resultText,
    });
  } catch (err) {
    log("logToolCall failed", { toolName: input.toolName, err });
  }
}
