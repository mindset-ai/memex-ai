// Integration tests for the usage-events store (spec-244 t-1) — REAL Postgres.
//
// The persistence boundary is tested against a real DB (no mocks): a real Memex +
// user (so the FKs resolve), then we record events and read them back, asserting
// the row lands in its own table, the outbox cursor starts NULL, and the rows are
// plain-SQL queryable (rollout step one: useful before any external sink exists).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { and, count, eq, isNull } from "drizzle-orm";
import { db } from "../db/connection.js";
import { usageEvents } from "../db/schema.js";
import { makeTestMemex } from "./test-helpers.js";
import { upsertUserByEmail } from "./users.js";
import { recordUsageEvent } from "./usage-events.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-244/acs";

let memexId: string;
let userId: string;

beforeAll(async () => {
  memexId = await makeTestMemex("usage");
  const u = await upsertUserByEmail(`usage-${Date.now()}@memex.ai`);
  userId = u.id;
});

afterAll(async () => {
  await db.delete(usageEvents).where(eq(usageEvents.memexId, memexId));
});

describe("recordUsageEvent — durable store, separate from the audit log (ac-1)", () => {
  it("persists a front-end event with the outbox cursor unset", async () => {
    tagAc(`${AC}/ac-1`);
    tagAc(`${AC}/ac-6`); // forwarded_at starts NULL — the outbox cursor underpins at-least-once
    const row = await recordUsageEvent({
      memexId,
      actorUserId: userId,
      name: "spec.create_clicked",
      source: "frontend",
      props: { surface: "header_cta" },
    });

    expect(row).not.toBeNull();
    expect(row?.name).toBe("spec.create_clicked");
    expect(row?.source).toBe("frontend");
    expect(row?.actorUserId).toBe(userId);
    expect(row?.env).toBe("test"); // resolveEnv() short-circuits under VITEST
    expect(row?.forwardedAt).toBeNull(); // not yet forwarded — the outbox cursor
    expect(row?.props).toEqual({ surface: "header_cta" });
  });

  it("persists a whitelisted back-end outcome event", async () => {
    tagAc(`${AC}/ac-1`);
    const row = await recordUsageEvent({
      memexId,
      actorUserId: userId,
      name: "document.created",
      source: "backend",
    });
    expect(row?.source).toBe("backend");
    expect(row?.name).toBe("document.created");
  });
});

describe("usage_events is plain-SQL queryable (ac-2)", () => {
  it("supports per-memex aggregate queries and an undrained-outbox scan", async () => {
    tagAc(`${AC}/ac-2`);
    // Rollout step one: an analyst can answer questions directly in SQL.
    const byMemex = await db
      .select({ n: count() })
      .from(usageEvents)
      .where(eq(usageEvents.memexId, memexId));
    expect(byMemex[0].n).toBeGreaterThanOrEqual(2);

    // The forwarder's outbox tail: undrained rows for this memex.
    const undrained = await db
      .select({ n: count() })
      .from(usageEvents)
      .where(and(eq(usageEvents.memexId, memexId), isNull(usageEvents.forwardedAt)));
    expect(undrained[0].n).toBeGreaterThanOrEqual(2);
  });
});
