// Integration tests for the Pulse activity-log sink (b-60, t-3).
//
// Hard rule: the persistence boundary is tested against REAL Postgres — no
// mocks. We create a real Memex + user + Spec (so the FKs resolve), drive the
// sink, and read rows back. Everything inserted is cleaned up in afterAll by
// deleting the namespace (cascades to memex → activity_log) and the users.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { activityLog, documents, memexes, namespaces, users } from "../db/schema.js";
import { makeTestMemex } from "./test-helpers.js";
import { upsertUserByEmail } from "./users.js";
import {
  bus,
  type ChangeEvent,
} from "./bus.js";
import {
  listActivity,
  mapEventToRow,
  persistEvent,
  startActivityLogSink,
  _stopActivityLogSink,
} from "./activity-log.js";

// ── Fixtures ────────────────────────────────────────────────────────────────
let memexId: string;
let otherMemexId: string;
let briefId: string;
let userId: string;
const createdUserIds: string[] = [];

// Track every namespace we make so cleanup cascades cover both memexes.
const createdMemexIds: string[] = [];

async function makeSpec(memex: string): Promise<string> {
  const [doc] = await db
    .insert(documents)
    .values({
      memexId: memex,
      handle: `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      title: "Pulse test spec",
      docType: "spec",
    })
    .returning();
  return doc.id;
}

beforeAll(async () => {
  memexId = await makeTestMemex("actlog");
  otherMemexId = await makeTestMemex("actlog2");
  createdMemexIds.push(memexId, otherMemexId);
  briefId = await makeSpec(memexId);
  const u = await upsertUserByEmail(`actlog-${Date.now()}@memex.ai`);
  userId = u.id;
  createdUserIds.push(u.id);
});

afterAll(async () => {
  // Tear down everything we inserted. activity_log + documents cascade off the
  // memex, and the memex cascades off its namespace — but we delete each layer
  // explicitly (deepest first) so cleanup is robust even if a cascade is ever
  // relaxed. Then drop the namespaces the memexes belong to, and our users.
  await db.delete(activityLog).where(inArray(activityLog.memexId, createdMemexIds)).catch(() => {});
  await db.delete(documents).where(inArray(documents.memexId, createdMemexIds)).catch(() => {});

  // Collect the namespaces backing our memexes, then delete memexes →
  // namespaces (namespace delete cascades to its org + memberships).
  const memexRows = await db
    .select({ namespaceId: memexes.namespaceId })
    .from(memexes)
    .where(inArray(memexes.id, createdMemexIds))
    .catch(() => [] as { namespaceId: string }[]);
  await db.delete(memexes).where(inArray(memexes.id, createdMemexIds)).catch(() => {});
  const namespaceIds = memexRows.map((r) => r.namespaceId);
  if (namespaceIds.length) {
    await db.delete(namespaces).where(inArray(namespaces.id, namespaceIds)).catch(() => {});
  }
  if (createdUserIds.length) {
    await db.delete(users).where(inArray(users.id, createdUserIds)).catch(() => {});
  }
});

// Each test starts from a clean activity_log slice for our memexes so row-count
// assertions are exact and order is deterministic.
beforeEach(async () => {
  await db.delete(activityLog).where(inArray(activityLog.memexId, createdMemexIds));
});

function baseEvent(overrides: Partial<ChangeEvent> = {}): ChangeEvent {
  return {
    memexId,
    entity: "document",
    action: "created",
    ...overrides,
  };
}

describe("mapEventToRow — ChangeEvent → activity_log mapping", () => {
  it("maps all fields and channel→actor_kind for each channel", () => {
    expect(mapEventToRow(baseEvent({ channel: "rest_ui" })).actorKind).toBe("human");
    expect(mapEventToRow(baseEvent({ channel: "mcp" })).actorKind).toBe("mcp_agent");
    expect(mapEventToRow(baseEvent({ channel: "in_app_agent" })).actorKind).toBe("in_app_agent");
    expect(mapEventToRow(baseEvent({ channel: "server" })).actorKind).toBe("system");
  });

  it("defaults channel to 'server' (→ actor_kind 'system') when absent", () => {
    const row = mapEventToRow(baseEvent({ channel: undefined }));
    expect(row.channel).toBe("server");
    expect(row.actorKind).toBe("system");
  });

  it("uses the supplied narrative when present", () => {
    const row = mapEventToRow(baseEvent({ narrative: "Alice viewed the Spec" }));
    expect(row.narrative).toBe("Alice viewed the Spec");
  });

  it("falls back to `${action} ${entity}` when narrative is absent or blank", () => {
    expect(mapEventToRow(baseEvent({ entity: "task", action: "created" })).narrative).toBe(
      "created task",
    );
    expect(
      mapEventToRow(baseEvent({ entity: "query", action: "searched", narrative: "  " })).narrative,
    ).toBe("searched query");
  });

  it("maps optional ids and payload, nulling absent ones", () => {
    const full = mapEventToRow(
      baseEvent({
        docId: briefId,
        userId,
        clientId: "conn-7",
        payload: { q: "auth" },
      }),
    );
    expect(full.briefId).toBe(briefId);
    expect(full.actorUserId).toBe(userId);
    expect(full.clientId).toBe("conn-7");
    expect(full.payload).toEqual({ q: "auth" });

    const sparse = mapEventToRow(baseEvent());
    expect(sparse.briefId).toBeNull();
    expect(sparse.actorUserId).toBeNull();
    expect(sparse.clientId).toBeNull();
    expect(sparse.payload).toBeNull();
  });
});

describe("persistEvent — real Postgres write", () => {
  it("writes exactly one row with the correct mapping + derived fields", async () => {
    const row = await persistEvent(
      baseEvent({
        docId: briefId,
        userId,
        clientId: "conn-9",
        channel: "rest_ui",
        action: "viewed",
        narrative: "Bob viewed the Spec",
        payload: { ref: "spec-1" },
      }),
    );
    expect(row).not.toBeNull();

    const rows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.memexId, memexId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      memexId,
      briefId,
      actorUserId: userId,
      clientId: "conn-9",
      channel: "rest_ui",
      actorKind: "human",
      entity: "document",
      action: "viewed",
      narrative: "Bob viewed the Spec",
      payload: { ref: "spec-1" },
    });
  });

  it("persists the narrative fallback when the event omits it", async () => {
    await persistEvent(baseEvent({ entity: "task", action: "created", channel: "server" }));
    const rows = await db.select().from(activityLog).where(eq(activityLog.memexId, memexId));
    expect(rows).toHaveLength(1);
    expect(rows[0].narrative).toBe("created task");
    expect(rows[0].actorKind).toBe("system");
  });

  it("skips (writes no row, does not throw) when memexId is blank", async () => {
    const row = await persistEvent({ ...baseEvent(), memexId: "" });
    expect(row).toBeNull();
    const rows = await db.select().from(activityLog).where(inArray(activityLog.memexId, createdMemexIds));
    expect(rows).toHaveLength(0);
  });

  it("is advisory: a bad FK (non-existent memex) is swallowed, not thrown", async () => {
    // Random UUID that is not a real memex → FK violation. persistEvent must
    // swallow and return null rather than reject.
    const row = await persistEvent({
      ...baseEvent(),
      memexId: "00000000-0000-0000-0000-000000000000",
    });
    expect(row).toBeNull();
  });
});

describe("startActivityLogSink — end-to-end bus → DB wiring", () => {
  afterAll(() => {
    _stopActivityLogSink();
  });

  it("subscribes to the bus and persists one row per emitted event", async () => {
    const unsub = startActivityLogSink();
    try {
      bus.emit(
        baseEvent({
          docId: briefId,
          channel: "mcp",
          action: "called",
          entity: "tool_call",
          narrative: "Agent called search_memex",
        }),
      );
      // The sink persists on a detached promise — poll until the row lands.
      const rows = await waitForRows(memexId, 1);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        channel: "mcp",
        actorKind: "mcp_agent",
        entity: "tool_call",
        action: "called",
        narrative: "Agent called search_memex",
      });
    } finally {
      unsub();
      _stopActivityLogSink();
    }
  });

  it("is idempotent — calling twice does not double-write", async () => {
    const a = startActivityLogSink();
    const b = startActivityLogSink();
    expect(a).toBe(b);
    try {
      bus.emit(baseEvent({ channel: "server", action: "updated", entity: "document" }));
      const rows = await waitForRows(memexId, 1);
      expect(rows).toHaveLength(1);
    } finally {
      _stopActivityLogSink();
    }
  });
});

describe("listActivity — filters + pagination", () => {
  it("returns only the requested memex, newest first", async () => {
    await persistEvent(baseEvent({ action: "created", narrative: "first" }));
    await persistEvent(baseEvent({ action: "updated", narrative: "second" }));
    await persistEvent({ ...baseEvent(), memexId: otherMemexId, narrative: "other" });

    const rows = await listActivity({ memexId });
    expect(rows).toHaveLength(2);
    // Newest first: "second" was inserted last.
    expect(rows[0].narrative).toBe("second");
    expect(rows[1].narrative).toBe("first");
    expect(rows.every((r) => r.memexId === memexId)).toBe(true);
  });

  it("filters by briefId", async () => {
    await persistEvent(baseEvent({ docId: briefId, narrative: "on-spec" }));
    await persistEvent(baseEvent({ narrative: "no-spec" })); // briefId null

    const rows = await listActivity({ memexId, briefId });
    expect(rows).toHaveLength(1);
    expect(rows[0].narrative).toBe("on-spec");
    expect(rows[0].briefId).toBe(briefId);
  });

  it("filters by actorUserId", async () => {
    await persistEvent(baseEvent({ userId, narrative: "by-user" }));
    await persistEvent(baseEvent({ narrative: "anon" }));

    const rows = await listActivity({ memexId, actorUserId: userId });
    expect(rows).toHaveLength(1);
    expect(rows[0].narrative).toBe("by-user");
  });

  it("filters by clientId", async () => {
    await persistEvent(baseEvent({ clientId: "cli-A", narrative: "from-A" }));
    await persistEvent(baseEvent({ clientId: "cli-B", narrative: "from-B" }));

    const rows = await listActivity({ memexId, clientId: "cli-A" });
    expect(rows).toHaveLength(1);
    expect(rows[0].narrative).toBe("from-A");
  });

  it("respects limit and paginates with `since`", async () => {
    // Insert 3 rows with distinct, increasing created_at so ordering is stable.
    await insertAt(memexId, new Date("2026-01-01T00:00:00Z"), "oldest");
    await insertAt(memexId, new Date("2026-01-02T00:00:00Z"), "middle");
    await insertAt(memexId, new Date("2026-01-03T00:00:00Z"), "newest");

    const page1 = await listActivity({ memexId, limit: 2 });
    expect(page1.map((r) => r.narrative)).toEqual(["newest", "middle"]);

    // "Load older": pass the last row's createdAt as `since`.
    const page2 = await listActivity({ memexId, limit: 2, since: page1[1].createdAt });
    expect(page2.map((r) => r.narrative)).toEqual(["oldest"]);
  });

  it("clamps limit into [1, 200]", async () => {
    await persistEvent(baseEvent({ narrative: "only" }));
    const rows = await listActivity({ memexId, limit: 9999 });
    expect(rows).toHaveLength(1);
    const none = await listActivity({ memexId, limit: 0 });
    // limit floored to 1 → still returns the single row.
    expect(none).toHaveLength(1);
  });
});

// ── helpers ───────────────────────────────────────────────────────────────

// Poll until at least `expected` rows exist for `memex`, or time out. Needed
// because the sink writes on a detached promise off the synchronous emit path.
async function waitForRows(memex: string, expected: number, timeoutMs = 2000) {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const rows = await db.select().from(activityLog).where(eq(activityLog.memexId, memex));
    if (rows.length >= expected) return rows;
    if (Date.now() - start > timeoutMs) return rows;
    await new Promise((r) => setTimeout(r, 25));
  }
}

// Insert a row with an explicit created_at so pagination ordering is exact.
async function insertAt(memex: string, createdAt: Date, narrative: string) {
  await db.insert(activityLog).values({
    memexId: memex,
    actorKind: "system",
    channel: "server",
    entity: "document",
    action: "created",
    narrative,
    createdAt,
  });
}
