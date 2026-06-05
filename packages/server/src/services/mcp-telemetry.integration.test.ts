// DB-backed integration tests for MCP telemetry persistence.
//
// Covers the rules that pure unit tests can't:
//   * upsertSession ON CONFLICT semantics (insert-then-update behaviour).
//   * upsertSession COALESCE — a later request with NULL identity columns
//     does NOT clobber a known value (matters for the SSE GET → initialize
//     POST sequence we observed in the spike).
//   * logToolCall persists a row and joins back to mcp_sessions cleanly.
//   * logToolCall derives org_id from memex_id (memex → namespace → org).
//   * logToolCall leaves org_id NULL for personal-kind memexes.
//   * logToolCall leaves memex_id + org_id NULL when no memex was supplied
//     (matches list_memexes / get_information shape).
//   * isDevMode() gate for result_text — in dev, we capture; in prod we don't.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  mcpSessions,
  mcpToolCalls,
  memexes,
  namespaces,
  orgs,
  users,
} from "../db/schema.js";
import { upsertSession, logToolCall } from "./mcp-telemetry.js";

const createdMemexIds: string[] = [];
const createdNamespaceIds: string[] = [];
const createdOrgIds: string[] = [];
const createdUserIds: string[] = [];
const createdSessionIds: string[] = [];

function unique(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`.toLowerCase();
}

async function seedUser(): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ email: `${unique("tel-user")}@example.com` })
    .returning();
  createdUserIds.push(u.id);
  return u.id;
}

async function seedOrgMemex(): Promise<{ memexId: string; orgId: string }> {
  // namespace + memex + matching org row — mirrors the real product shape
  // (an org-kind namespace has exactly one orgs row hung off it).
  const [ns] = await db
    .insert(namespaces)
    .values({ slug: unique("tel-org"), kind: "org" })
    .returning();
  createdNamespaceIds.push(ns.id);
  const [org] = await db
    .insert(orgs)
    .values({ namespaceId: ns.id, name: "Telemetry Test Org" })
    .returning();
  createdOrgIds.push(org.id);
  const [mx] = await db
    .insert(memexes)
    .values({ namespaceId: ns.id, slug: "main", name: "Telemetry Test Memex" })
    .returning();
  createdMemexIds.push(mx.id);
  return { memexId: mx.id, orgId: org.id };
}

async function seedPersonalMemex(): Promise<string> {
  // personal-kind namespace has no orgs row. Real users get one of these
  // lazily provisioned by ensureUserNamespace on first request.
  const [ns] = await db
    .insert(namespaces)
    .values({ slug: unique("tel-personal"), kind: "user" })
    .returning();
  createdNamespaceIds.push(ns.id);
  const [mx] = await db
    .insert(memexes)
    .values({ namespaceId: ns.id, slug: "personal", name: "Personal Memex" })
    .returning();
  createdMemexIds.push(mx.id);
  return mx.id;
}

beforeAll(() => {
  // Test the production-like path by default; specific tests flip dev mode on
  // when they need to assert result_text capture.
  delete process.env.NODE_ENV; // isDevMode returns true when GOOGLE_CLIENT_ID is unset
});

afterAll(async () => {
  // Order matters: tool_calls FK→sessions FK→users; memexes FK→namespaces.
  if (createdSessionIds.length) {
    await db
      .delete(mcpSessions)
      .where(inArray(mcpSessions.sessionId, createdSessionIds))
      .catch(() => {});
  }
  if (createdMemexIds.length) {
    await db
      .delete(memexes)
      .where(inArray(memexes.id, createdMemexIds))
      .catch(() => {});
  }
  if (createdOrgIds.length) {
    await db
      .delete(orgs)
      .where(inArray(orgs.id, createdOrgIds))
      .catch(() => {});
  }
  if (createdNamespaceIds.length) {
    await db
      .delete(namespaces)
      .where(inArray(namespaces.id, createdNamespaceIds))
      .catch(() => {});
  }
  if (createdUserIds.length) {
    await db
      .delete(users)
      .where(inArray(users.id, createdUserIds))
      .catch(() => {});
  }
});

describe("upsertSession", () => {
  it("inserts on first call, refreshes last_seen_at on subsequent calls", async () => {
    const userId = await seedUser();
    const sessionId = unique("sess-refresh");
    createdSessionIds.push(sessionId);

    await upsertSession({
      sessionId,
      userId,
      userAgent: "test/1.0",
      clientInfo: { name: "test", version: "1.0" },
      ipAddress: null,
    });

    const [first] = await db
      .select()
      .from(mcpSessions)
      .where(eq(mcpSessions.sessionId, sessionId));
    expect(first.clientName).toBe("test");
    expect(first.clientVersion).toBe("1.0");

    // Small sleep so last_seen_at can advance past started_at.
    await new Promise((r) => setTimeout(r, 10));

    await upsertSession({
      sessionId,
      userId,
      userAgent: "test/1.0",
      clientInfo: { name: "test", version: "1.0" },
      ipAddress: null,
    });

    const [second] = await db
      .select()
      .from(mcpSessions)
      .where(eq(mcpSessions.sessionId, sessionId));
    expect(second.lastSeenAt.getTime()).toBeGreaterThan(
      first.lastSeenAt.getTime(),
    );
    expect(second.startedAt.getTime()).toBe(first.startedAt.getTime());
  });

  it("COALESCEs client_info — a later NULL does NOT overwrite a known value", async () => {
    // Mirrors the real ordering: SSE GET (no clientInfo) lands first, then
    // initialize POST (with clientInfo). Then a normal tool call (no
    // clientInfo). The initialize blob must survive the later call.
    const userId = await seedUser();
    const sessionId = unique("sess-coalesce");
    createdSessionIds.push(sessionId);

    // 1. SSE-GET-shaped first request — no clientInfo yet.
    await upsertSession({
      sessionId,
      userId,
      userAgent: "claude-code/2.1.145",
      clientInfo: null,
      ipAddress: null,
    });

    // 2. initialize POST lands with clientInfo.
    await upsertSession({
      sessionId,
      userId,
      userAgent: "claude-code/2.1.145",
      clientInfo: { name: "claude-code", version: "2.1.145", host: "vscode" },
      ipAddress: null,
    });

    // 3. follow-up tool/call — clientInfo back to null. Must NOT clobber.
    await upsertSession({
      sessionId,
      userId,
      userAgent: "claude-code/2.1.145",
      clientInfo: null,
      ipAddress: null,
    });

    const [row] = await db
      .select()
      .from(mcpSessions)
      .where(eq(mcpSessions.sessionId, sessionId));
    expect(row.clientInfo).toEqual({
      name: "claude-code",
      version: "2.1.145",
      host: "vscode",
    });
  });
});

describe("logToolCall", () => {
  beforeEach(() => {
    // Most tests want dev-mode (so result_text capture works). The prod-gate
    // test flips this back.
    delete process.env.NODE_ENV;
    delete process.env.GOOGLE_CLIENT_ID;
  });

  async function seedSessionFor(userId: string): Promise<string> {
    const sessionId = unique("sess");
    createdSessionIds.push(sessionId);
    await upsertSession({
      sessionId,
      userId,
      userAgent: "test/1.0",
      clientInfo: null,
      ipAddress: null,
    });
    return sessionId;
  }

  it("derives org_id from memex_id (org-kind namespace)", async () => {
    const userId = await seedUser();
    const sessionId = await seedSessionFor(userId);
    const { memexId, orgId } = await seedOrgMemex();

    await logToolCall({
      sessionId,
      userId,
      memexId,
      toolName: "list_docs",
      args: { memex: "telemetry-test/main" },
      durationMs: 12,
    });

    const [row] = await db
      .select()
      .from(mcpToolCalls)
      .where(
        and(
          eq(mcpToolCalls.sessionId, sessionId),
          eq(mcpToolCalls.toolName, "list_docs"),
        ),
      );
    expect(row.memexId).toBe(memexId);
    expect(row.orgId).toBe(orgId);
  });

  it("leaves org_id NULL for personal-kind memexes (no owning org)", async () => {
    const userId = await seedUser();
    const sessionId = await seedSessionFor(userId);
    const memexId = await seedPersonalMemex();

    await logToolCall({
      sessionId,
      userId,
      memexId,
      toolName: "get_doc",
      args: { handle: "anything" },
      durationMs: 5,
    });

    const [row] = await db
      .select()
      .from(mcpToolCalls)
      .where(
        and(
          eq(mcpToolCalls.sessionId, sessionId),
          eq(mcpToolCalls.toolName, "get_doc"),
        ),
      );
    expect(row.memexId).toBe(memexId);
    expect(row.orgId).toBeNull();
  });

  it("leaves memex_id + org_id NULL when no memex was supplied", async () => {
    // list_memexes / get_information shape — the tool itself doesn't act
    // on a specific memex.
    const userId = await seedUser();
    const sessionId = await seedSessionFor(userId);

    await logToolCall({
      sessionId,
      userId,
      toolName: "list_memexes",
      args: {},
      durationMs: 3,
    });

    const [row] = await db
      .select()
      .from(mcpToolCalls)
      .where(
        and(
          eq(mcpToolCalls.sessionId, sessionId),
          eq(mcpToolCalls.toolName, "list_memexes"),
        ),
      );
    expect(row.memexId).toBeNull();
    expect(row.orgId).toBeNull();
  });

  it("captures result_text in dev mode, leaves it NULL in production", async () => {
    const userId = await seedUser();
    const sessionId = await seedSessionFor(userId);

    // Dev mode (GOOGLE_CLIENT_ID unset, NODE_ENV !== 'production').
    await logToolCall({
      sessionId,
      userId,
      toolName: "tool_dev",
      args: {},
      durationMs: 1,
      resultText: "dev-result-payload",
    });

    // Flip to production for the next call. isDevMode() throws if
    // GOOGLE_CLIENT_ID is unset in production, so set both. The throw
    // happens at the *fallback* path — we just want the gate to return
    // false here so result_text gets dropped.
    process.env.NODE_ENV = "production";
    process.env.GOOGLE_CLIENT_ID = "fake-client-for-test";

    await logToolCall({
      sessionId,
      userId,
      toolName: "tool_prod",
      args: {},
      durationMs: 1,
      resultText: "prod-result-payload-should-be-dropped",
    });

    const rows = await db
      .select()
      .from(mcpToolCalls)
      .where(eq(mcpToolCalls.sessionId, sessionId));
    const devRow = rows.find((r) => r.toolName === "tool_dev");
    const prodRow = rows.find((r) => r.toolName === "tool_prod");
    expect(devRow?.resultText).toBe("dev-result-payload");
    expect(prodRow?.resultText).toBeNull();
  });

  it("records the error column on failure", async () => {
    const userId = await seedUser();
    const sessionId = await seedSessionFor(userId);

    await logToolCall({
      sessionId,
      userId,
      toolName: "errored_tool",
      args: { x: 1 },
      durationMs: 2,
      error: "boom",
    });

    const [row] = await db
      .select()
      .from(mcpToolCalls)
      .where(
        and(
          eq(mcpToolCalls.sessionId, sessionId),
          eq(mcpToolCalls.toolName, "errored_tool"),
        ),
      );
    expect(row.error).toBe("boom");
  });

  it("preserves a full error envelope (name + message + multi-line stack) without truncation up to the 8KB cap", async () => {
    // Locks in the richer-error-capture behaviour: when the mcp/tools.ts
    // wrap calls logToolCall with `${err.name}: ${err.message}\n${err.stack}`,
    // we want the whole envelope persisted so debugging a failure doesn't
    // need a Cloud Run logs round-trip. The wrap formats; this test just
    // proves the column doesn't clip realistic stack-trace-sized strings.
    const userId = await seedUser();
    const sessionId = await seedSessionFor(userId);

    const stack = [
      "Error: ENOENT: no such file or directory, scandir '/app/packages/server/dist/guidance'",
      "    at async Object.readdir (node:internal/fs/promises:962:18)",
      "    at async listTopics (/app/packages/server/dist/services/guidance.js:42:21)",
      "    at async Object.handler (/app/packages/server/dist/agent/tool-specs.js:518:33)",
      "    at async withTelemetry (/app/packages/server/dist/mcp/tools.js:181:24)",
    ].join("\n");

    await logToolCall({
      sessionId,
      userId,
      toolName: "deep_error_tool",
      args: {},
      durationMs: 3,
      error: stack,
    });

    const [row] = await db
      .select()
      .from(mcpToolCalls)
      .where(
        and(
          eq(mcpToolCalls.sessionId, sessionId),
          eq(mcpToolCalls.toolName, "deep_error_tool"),
        ),
      );
    expect(row.error).toBe(stack);
    expect(row.error?.length).toBeGreaterThan(300); // sanity: not redacted to a short envelope
    expect(row.error).toContain("ENOENT");
    expect(row.error).toContain("at async listTopics");
  });
});
