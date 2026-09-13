// spec-562 ac-11 — a timed-out call must not be recorded as a fast success.
//
// logToolCall writes at the moment the CALLER is answered, which on a breach is the
// deadline. The work runs on; its real cost is known only later. Without the update
// this file pins, mcp_tool_calls says every breach took exactly the deadline — the
// caller's truth, but not the system's, and indistinguishable in aggregate from a
// call that genuinely completed in that time.
//
// DB-backed on purpose: this is a claim about a persisted row, and a mocked db
// would assert that we called a function, not that the row changed.
import { afterAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { mcpSessions, mcpToolCalls, users } from "../db/schema.js";
import { upsertSession, logToolCall, recordDeadlineElapsed } from "./mcp-telemetry.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-562/acs/ac-${n}`;

const createdUserIds: string[] = [];
const createdSessionIds: string[] = [];

// std-37: per-worker-unique identifiers so parallel shards cannot collide.
const unique = (p: string) =>
  `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toLowerCase();

async function seedSession(): Promise<{ sessionId: string; userId: string }> {
  const [u] = await db
    .insert(users)
    .values({ email: `${unique("dl-user")}@example.com` })
    .returning();
  createdUserIds.push(u.id);
  const sessionId = unique("dl-session");
  await upsertSession({
    sessionId,
    userId: u.id,
    userAgent: null,
    clientInfo: null,
    ipAddress: null,
  });
  createdSessionIds.push(sessionId);
  return { sessionId, userId: u.id };
}

afterAll(async () => {
  if (createdSessionIds.length)
    await db.delete(mcpSessions).where(inArray(mcpSessions.sessionId, createdSessionIds));
  if (createdUserIds.length)
    await db.delete(users).where(inArray(users.id, createdUserIds));
});

describe("spec-562 — a deadline breach carries the work's true elapsed time", () => {
  it("ac-11: the row's duration is updated from the deadline to the real cost", async () => {
    tagAc(AC(11));
    const { sessionId, userId } = await seedSession();

    // What withTelemetry writes at the deadline: the caller waited 30s.
    const rowId = await logToolCall({
      sessionId,
      userId,
      memexId: null,
      toolName: "create_task",
      args: {},
      durationMs: 30_000,
      error: "mcp-deadline: exceeded 30000ms; outcome UNKNOWN",
      resultText: null,
    });
    expect(rowId, "logToolCall must return the row id for the later update").toBeTruthy();

    const [atDeadline] = await db
      .select()
      .from(mcpToolCalls)
      .where(eq(mcpToolCalls.id, rowId!));
    expect(atDeadline.durationMs).toBe(30_000);

    // What the abandoned work reports when it finally lands, 305s in — the
    // duration of the 2026-09-10 incident.
    await recordDeadlineElapsed(rowId!, 305_000);

    const [after] = await db.select().from(mcpToolCalls).where(eq(mcpToolCalls.id, rowId!));
    expect(
      after.durationMs,
      "the row still reports the deadline — a breach reads as a fast success",
    ).toBe(305_000);
    expect(after.error).toContain("305000ms");
    expect(after.error).toContain("UNKNOWN");
  });

  it("ac-11: a breach whose work later FAILS keeps the failure on the row", async () => {
    tagAc(AC(11));
    const { sessionId, userId } = await seedSession();
    const rowId = await logToolCall({
      sessionId,
      userId,
      memexId: null,
      toolName: "update_task",
      args: {},
      durationMs: 30_000,
      error: "mcp-deadline: exceeded 30000ms; outcome UNKNOWN",
      resultText: null,
    });

    await recordDeadlineElapsed(rowId!, 91_000, new Error("connection terminated"));

    const [after] = await db.select().from(mcpToolCalls).where(eq(mcpToolCalls.id, rowId!));
    expect(after.durationMs).toBe(91_000);
    expect(after.error).toContain("connection terminated");
  });

  it("ac-11: a missing row is survivable — telemetry never bubbles into the tool path", async () => {
    tagAc(AC(11));
    // The id that logToolCall returns is null when its own insert was swallowed.
    // Updating a row that does not exist must be a no-op, not a throw: a telemetry
    // failure has to stay invisible to the caller.
    await expect(
      recordDeadlineElapsed("00000000-0000-0000-0000-0000000000ff", 1_000),
    ).resolves.toBeUndefined();
  });
});
