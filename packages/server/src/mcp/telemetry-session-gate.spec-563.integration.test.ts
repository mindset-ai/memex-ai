// spec-563 t-5 (ac-12) — the tail watcher's blind spot, measured rather than inherited.
//
// dec-2 puts the watcher on `mcp_tool_calls`. That table is written inside
// `if (sessionId)` (mcp/tools.ts), so the obvious worry is that calls arriving WITHOUT an
// MCP session record nothing and are invisible to the signal.
//
// GROUNDING SAYS THE GATE NEVER CLOSES IN PRODUCTION. `app.ts` derives it as
//
//     const sessionId = incomingSession ?? randomUUID();
//
// so a client that sends no `Mcp-Session-Id` gets a server-minted one. `createMcpServer`
// has exactly ONE production call site and it always passes that value; `undefined` is
// reachable only from tests. `git log -S incomingSession` dates the line to the initial
// commit, so the behaviour has not changed across the window issue-1 wants to read.
//
// ⚠ BUT A SOURCE READ IS A SHAPE ANSWER, AND THE AC ASKS A RUNTIME ONE. "The code cannot
// reach undefined" and "no production call is missing a row" are different claims, and the
// second is the one the watcher depends on. This test drives the REAL /mcp endpoint with
// NO session header and asserts a row lands — the claim, exercised, not inspected.
//
// The remaining hole is a different one, and it is recorded on t-5 rather than hidden
// here: `logToolCall` swallows its errors, and `mcp_tool_calls` has an FK to
// `mcp_sessions`, whose upsert also swallows. A failed session upsert therefore drops
// every tool-call row for that session, silently. Prod logs show ZERO `logToolCall failed`
// lines in 7 days (search instrument verified capable), so it is not currently firing —
// but it is unguarded, and no test can assert an absence that lives in a catch block.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { inArray, eq, and } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  memexes,
  namespaces,
  orgs,
  orgMemberships,
  users,
  mcpToolCalls,
  mcpSessions,
} from "../db/schema.js";
import { mintMcpToken } from "../services/mcp-tokens.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-563/acs";

// /mcp does not use sessionMiddleware, but the app mounts routes that do.
const originalClientId = process.env.GOOGLE_CLIENT_ID;
beforeAll(() => {
  delete process.env.GOOGLE_CLIENT_ID;
  vi.resetModules();
});

const created = { users: [] as string[], memexes: [] as string[] };

let token: string;
let userId: string;

beforeAll(async () => {
  const sub = `s563t5-${process.env.VITEST_WORKER_ID ?? "0"}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}`.toLowerCase();
  const [u] = await db
    .insert(users)
    .values({ email: `${sub}@memex.ai`, name: "Gate probe" } as typeof users.$inferInsert)
    .returning();
  userId = u.id;
  created.users.push(u.id);
  const [ns] = await db.insert(namespaces).values({ slug: sub, kind: "org" }).returning();
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: `Test ${sub}` }).returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [mx] = await db
    .insert(memexes)
    .values({ name: sub, slug: "main", namespaceId: ns.id } as typeof memexes.$inferInsert)
    .returning();
  created.memexes.push(mx.id);
  await db.insert(orgMemberships).values({ userId: u.id, orgId: org.id, role: "administrator" });
  // mintMcpToken returns { raw, row } — `raw` is the Bearer value. Destructuring it
  // wrong produced a 401, which the vacuity guard caught as "the call failed" rather
  // than letting an absent telemetry row read as a blind spot.
  ({ raw: token } = await mintMcpToken(u.id, "spec-563 gate probe"));
});

afterAll(async () => {
  if (originalClientId !== undefined) process.env.GOOGLE_CLIENT_ID = originalClientId;
  if (created.memexes.length)
    await db.delete(memexes).where(inArray(memexes.id, created.memexes)).catch(() => {});
  if (created.users.length)
    await db.delete(users).where(inArray(users.id, created.users)).catch(() => {});
});

describe("mcp telemetry: the session gate never closes on a real call [spec-563 t-5]", () => {
  it("ac-12: a tool call carrying NO Mcp-Session-Id still records a row the watcher can see", async () => {
    tagAc(`${AC}/ac-12`);

    const { app } = await import("../app.js");

    // Deliberately NO Mcp-Session-Id header — the case the blind spot is about.
    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_memexes", arguments: {} },
      }),
    });

    // Vacuity guard: if the call did not succeed, an absent telemetry row would prove
    // nothing about the gate (std-45 cl-4).
    expect(res.status).toBe(200);

    // ⚠ POLL, do not read once. The telemetry write is fired as `void logToolCall(...)`
    // in mcp/tools.ts — deliberately not awaited, so the tool path never waits on
    // telemetry. A single read right after the response therefore races the insert and
    // returned 0 rows on the first run of this test. Read once and this would have looked
    // exactly like "the gate closed and the watcher is blind" — the finding the whole task
    // is about, arrived at for entirely the wrong reason [std-37: poll for async writes].
    const readRows = () =>
      db
        .select({ id: mcpToolCalls.id, sessionId: mcpToolCalls.sessionId, tool: mcpToolCalls.toolName })
        .from(mcpToolCalls)
        .where(and(eq(mcpToolCalls.userId, userId), eq(mcpToolCalls.toolName, "list_memexes")));

    // THE CLAIM: the row lands even though the client sent no session.
    await expect.poll(async () => (await readRows()).length, { timeout: 5000 }).toBeGreaterThan(0);

    const rows = await readRows();

    // And the session it was filed under is a real, server-minted one — not a placeholder
    // or an empty string that would collapse every sessionless caller into one bucket and
    // make per-session analysis quietly wrong.
    const sessionIds = rows.map((r) => r.sessionId);
    expect(sessionIds.every((s) => typeof s === "string" && s.length > 0)).toBe(true);

    const sessions = await db
      .select({ id: mcpSessions.sessionId })
      .from(mcpSessions)
      .where(inArray(mcpSessions.sessionId, sessionIds));
    expect(sessions.length).toBeGreaterThan(0);
  });
});
