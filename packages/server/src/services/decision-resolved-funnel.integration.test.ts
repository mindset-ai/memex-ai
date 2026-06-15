// spec-297 dec-2 (ac-16 / ac-17): resolving a decision emits a DISTINCT
// 'decision.resolved' bus action, which the back-end sink mirrors into
// usage_events as a clean, unambiguous funnel step — separate from the generic
// 'decision.updated' that many decision mutations share. REAL Postgres + REAL bus.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { usageEvents } from "../db/schema.js";
import { makeTestMemex } from "./test-helpers.js";
import { upsertUserByEmail } from "./users.js";
import { createDocDraft } from "./documents.js";
import { createDecision, resolveDecision } from "./decisions.js";
import { startUsageBackendSink, _stopUsageBackendSink, isWhitelistedOutcome } from "./usage-backend-sink.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-297/acs";

let memexId: string;
let userId: string;

beforeAll(async () => {
  memexId = await makeTestMemex("decres");
  const u = await upsertUserByEmail(`decres-${Date.now()}@example.com`);
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

describe("decision.resolved — distinct funnel step (spec-297 dec-2)", () => {
  it("'decision.resolved' is whitelisted; 'decision.updated' is not (ac-17)", () => {
    tagAc(`${AC}/ac-17`);
    expect(isWhitelistedOutcome({ memexId, entity: "decision", action: "resolved" })).toBe(true);
    expect(isWhitelistedOutcome({ memexId, entity: "decision", action: "updated" })).toBe(false);
  });

  it("resolving a decision lands a usage_events row named exactly 'decision.resolved' (ac-16, ac-17)", async () => {
    tagAc(`${AC}/ac-16`);
    tagAc(`${AC}/ac-17`);
    const doc = await createDocDraft(memexId, "Decision funnel doc", "Purpose");
    const dec = await createDecision(memexId, doc.id, "Ship it?");
    await resolveDecision(memexId, dec.id, "Yes — ship it.", undefined, { actorUserId: userId });

    const resolvedRows = await waitForRows("decision.resolved");
    expect(resolvedRows.length).toBe(1);
    expect(resolvedRows[0].name).toBe("decision.resolved");
    expect(resolvedRows[0].source).toBe("backend");
    expect(resolvedRows[0].actorUserId).toBe(userId);

    // The shared 'decision.updated' is NOT mirrored (not whitelisted), so the
    // funnel step is unambiguous — exactly the point of dec-2.
    const updatedRows = await db
      .select()
      .from(usageEvents)
      .where(and(eq(usageEvents.memexId, memexId), eq(usageEvents.name, "decision.updated")));
    expect(updatedRows.length).toBe(0);
  });
});
