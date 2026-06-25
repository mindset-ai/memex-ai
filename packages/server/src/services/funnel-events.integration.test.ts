// Integration tests for the direct-path activation-funnel emitters (spec-297 dec-1)
// — REAL Postgres + REAL bus. account.created / mcp.connected / mcp.tool_called are
// emitted by a DIRECT recordUsageEvent() call, NOT the mutate() bus, so they must
// land a usage_events row WITHOUT a bus ChangeEvent or an activity_log row.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { and, count, eq, isNull } from "drizzle-orm";
import { db } from "../db/connection.js";
import { usageEvents, activityLog } from "../db/schema.js";
import { makeTestMemex } from "./test-helpers.js";
import { upsertUserByEmail, createUserWithPassword } from "./users.js";
import { bus, type ChangeEvent } from "./bus.js";
import {
  recordAccountCreated,
  recordMcpConnected,
  recordMcpToolCalled,
} from "./funnel-events.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-297/acs";

let memexId: string;
let userId: string;

beforeAll(async () => {
  memexId = await makeTestMemex("funnel");
  const u = await upsertUserByEmail(`funnel-${Date.now()}@example.com`);
  userId = u.id;
});

afterAll(async () => {
  // These rows mostly carry a NULL memex_id, so delete by actor instead.
  await db.delete(usageEvents).where(eq(usageEvents.actorUserId, userId));
});

describe("account.created + mcp.connected — NULL memex (ac-13)", () => {
  it("records account.created with memex_id NULL, keyed on the user", async () => {
    tagAc(`${AC}/ac-13`);
    const row = await recordAccountCreated(userId);
    expect(row).not.toBeNull();
    expect(row?.name).toBe("account.created");
    expect(row?.memexId).toBeNull();
    expect(row?.actorUserId).toBe(userId);
    expect(row?.source).toBe("backend");
  });

  it("records mcp.connected with memex_id NULL, keyed on the user", async () => {
    tagAc(`${AC}/ac-13`);
    tagAc(`${AC}/ac-2`); // scope: handshake → mcp.connected, keyed on the user UUID
    const row = await recordMcpConnected(userId);
    expect(row?.name).toBe("mcp.connected");
    expect(row?.memexId).toBeNull();
    expect(row?.actorUserId).toBe(userId);
  });

  it("records mcp.tool_called for a Memex-agnostic tool with memex_id NULL", async () => {
    tagAc(`${AC}/ac-13`);
    const row = await recordMcpToolCalled(userId, "list_memexes", undefined);
    expect(row?.name).toBe("mcp.tool_called");
    expect(row?.memexId).toBeNull();
    expect(row?.props).toEqual({ tool_name: "list_memexes" });
  });
});

describe("mcp.tool_called for a Memex-scoped tool carries the resolved memex_id (ac-14)", () => {
  it("records the resolved non-null memex_id", async () => {
    tagAc(`${AC}/ac-14`);
    const row = await recordMcpToolCalled(userId, "get_doc", memexId);
    expect(row?.name).toBe("mcp.tool_called");
    expect(row?.memexId).toBe(memexId);
    expect(row?.props).toEqual({ tool_name: "get_doc" });
  });
});

describe("mcp.tool_called carries tool_name as a low-cardinality non-PII prop (ac-19)", () => {
  it("sets props.tool_name to exactly the tool name", async () => {
    tagAc(`${AC}/ac-19`);
    const row = await recordMcpToolCalled(userId, "create_ac", memexId);
    expect(row?.props).toEqual({ tool_name: "create_ac" });
  });
});

describe("per-call cadence — not deduped to first-per-user (ac-18)", () => {
  it("each invocation produces its own mcp.tool_called row", async () => {
    tagAc(`${AC}/ac-18`);
    tagAc(`${AC}/ac-2`); // scope: each tool call → mcp.tool_called, keyed on the user
    const before = await db
      .select({ n: count() })
      .from(usageEvents)
      .where(and(eq(usageEvents.actorUserId, userId), eq(usageEvents.name, "mcp.tool_called")));
    await recordMcpToolCalled(userId, "get_doc", memexId);
    await recordMcpToolCalled(userId, "get_doc", memexId);
    await recordMcpToolCalled(userId, "get_doc", memexId);
    const after = await db
      .select({ n: count() })
      .from(usageEvents)
      .where(and(eq(usageEvents.actorUserId, userId), eq(usageEvents.name, "mcp.tool_called")));
    expect(after[0].n - before[0].n).toBe(3);
  });
});

describe("signup wiring — createUserWithPassword emits account.created (ac-1)", () => {
  async function accountCreatedRows(uid: string) {
    return db
      .select()
      .from(usageEvents)
      .where(and(eq(usageEvents.actorUserId, uid), eq(usageEvents.name, "account.created")));
  }

  it("fires account.created when a brand-new user row is created", async () => {
    tagAc(`${AC}/ac-1`);
    const email = `signup-new-${Date.now()}@example.com`;
    const u = await createUserWithPassword({ email, passwordHash: "x".repeat(60) });
    // createUserWithPassword fires recordAccountCreated() fire-and-forget (`void`)
    // by design — telemetry must never block or break signup. So the usage_events
    // row is eventually-consistent: poll for it rather than racing the async insert
    // (the SELECT would otherwise run before the insert commits under a slow/loaded
    // CI Postgres). The shape assertions below are unchanged — only the wait is added.
    let rows: Awaited<ReturnType<typeof accountCreatedRows>> = [];
    await vi.waitFor(
      async () => {
        rows = await accountCreatedRows(u.id);
        expect(rows).toHaveLength(1);
      },
      { timeout: 5000, interval: 25 },
    );
    expect(rows[0].memexId).toBeNull();
    expect(rows[0].actorUserId).toBe(u.id);
    await db.delete(usageEvents).where(eq(usageEvents.actorUserId, u.id));
  });

  it("does NOT fire account.created on the passwordless-upgrade branch", async () => {
    tagAc(`${AC}/ac-1`);
    // Pre-create a passwordless user (the SSO / magic-link shape), then add a password.
    const email = `upgrade-${Date.now()}@example.com`;
    const existing = await upsertUserByEmail(email);
    const upgraded = await createUserWithPassword({ email, passwordHash: "y".repeat(60) });
    expect(upgraded.id).toBe(existing.id); // same row, just a password added
    const rows = await accountCreatedRows(existing.id);
    expect(rows).toHaveLength(0); // upgrading an existing account is not a signup
  });
});

describe("direct path — no bus ChangeEvent, no activity_log row (ac-15)", () => {
  it("emits nothing on the bus and writes no activity_log row", async () => {
    tagAc(`${AC}/ac-15`);
    const seen: ChangeEvent[] = [];
    const unsubscribe = bus.subscribe({}, (e) => seen.push(e));
    const alBefore = await db.select({ n: count() }).from(activityLog);

    await recordAccountCreated(userId);
    await recordMcpConnected(userId);
    await recordMcpToolCalled(userId, "get_doc", memexId);

    // Give any (incorrectly) emitted bus event a tick to arrive.
    await new Promise((r) => setTimeout(r, 50));
    unsubscribe();

    const alAfter = await db.select({ n: count() }).from(activityLog);
    expect(seen, "direct-path funnel events must NOT touch the bus").toEqual([]);
    expect(alAfter[0].n, "direct-path funnel events must NOT write activity_log").toBe(
      alBefore[0].n,
    );

    // ...yet the usage_events rows DID land.
    const landed = await db
      .select({ n: count() })
      .from(usageEvents)
      .where(
        and(
          eq(usageEvents.actorUserId, userId),
          eq(usageEvents.name, "account.created"),
          isNull(usageEvents.memexId),
        ),
      );
    expect(landed[0].n).toBeGreaterThanOrEqual(1);
  });
});
