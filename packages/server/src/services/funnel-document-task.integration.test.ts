// spec-297 (ac-3 / ac-7): the two registry/payload funnel additions.
//  - task.created is now whitelisted, so creating a task mirrors into usage_events.
//  - document.created carries props.spec_index — the Nth-spec ordinal for the
//    acting user — so depth funnels come from one event via a property filter.
// REAL Postgres + REAL bus.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { usageEvents } from "../db/schema.js";
import { makeTestMemex } from "./test-helpers.js";
import { upsertUserByEmail } from "./users.js";
import { createDocDraft } from "./documents.js";
import { createTask } from "./tasks.js";
import { startUsageBackendSink, _stopUsageBackendSink } from "./usage-backend-sink.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-297/acs";

let memexId: string;
let userId: string;

beforeAll(async () => {
  memexId = await makeTestMemex("functask");
  const u = await upsertUserByEmail(`functask-${Date.now()}@example.com`);
  userId = u.id;
  startUsageBackendSink();
});

afterAll(async () => {
  _stopUsageBackendSink();
  await db.delete(usageEvents).where(eq(usageEvents.memexId, memexId));
});

async function waitForRows(name: string, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await db
      .select()
      .from(usageEvents)
      .where(and(eq(usageEvents.memexId, memexId), eq(usageEvents.name, name)));
    if (rows.length > 0) return rows;
    await new Promise((r) => setTimeout(r, 25));
  }
  return [];
}

describe("task.created mirrors into usage_events (ac-3, ac-7)", () => {
  it("creating a task lands a 'task.created' usage_events row", async () => {
    tagAc(`${AC}/ac-3`);
    tagAc(`${AC}/ac-7`);
    const doc = await createDocDraft(memexId, "Task funnel doc", "Purpose", "spec", undefined, undefined, userId, { actorUserId: userId });
    await createTask(memexId, doc.id, "First task", "Do the thing", undefined, undefined, {
      actorUserId: userId,
    });
    const rows = await waitForRows("task.created");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].source).toBe("backend");
    expect(rows[0].actorUserId).toBe(userId);
  });
});

describe("document.created carries spec_index = Nth spec for the user (ac-3)", () => {
  it("the index increments per spec the user creates", async () => {
    tagAc(`${AC}/ac-3`);
    // Fresh user → no prior specs, so the first spec is #1, the second #2.
    const u = await upsertUserByEmail(`specidx-${Date.now()}@example.com`);
    const m = await makeTestMemex("specidx");

    const first = await createDocDraft(m, "Spec one", "p", "spec", undefined, undefined, u.id, { actorUserId: u.id });
    const second = await createDocDraft(m, "Spec two", "p", "spec", undefined, undefined, u.id, { actorUserId: u.id });

    const firstRow = (
      await db
        .select()
        .from(usageEvents)
        .where(and(eq(usageEvents.memexId, m), eq(usageEvents.name, "document.created")))
    ).find((r) => r.props && (r.props as Record<string, unknown>).spec_index === 1);
    const secondRow = (
      await db
        .select()
        .from(usageEvents)
        .where(and(eq(usageEvents.memexId, m), eq(usageEvents.name, "document.created")))
    ).find((r) => r.props && (r.props as Record<string, unknown>).spec_index === 2);

    expect(firstRow, "first spec should carry spec_index 1").toBeDefined();
    expect(secondRow, "second spec should carry spec_index 2").toBeDefined();
    expect(firstRow?.actorUserId).toBe(u.id);

    void first;
    void second;
    await db.delete(usageEvents).where(eq(usageEvents.memexId, m));
  });

  it("a non-spec document carries no spec_index", async () => {
    tagAc(`${AC}/ac-3`);
    const u = await upsertUserByEmail(`nospecidx-${Date.now()}@example.com`);
    const doc = await createDocDraft(memexId, "A free doc", "p", "document", undefined, undefined, u.id, { actorUserId: u.id });
    const rows = await db
      .select()
      .from(usageEvents)
      .where(and(eq(usageEvents.memexId, memexId), eq(usageEvents.name, "document.created")));
    const mine = rows.find((r) => r.actorUserId === u.id && r.props !== null);
    // Either no props at all, or props without spec_index.
    if (mine?.props) {
      expect((mine.props as Record<string, unknown>).spec_index).toBeUndefined();
    }
    void doc;
  });
});
