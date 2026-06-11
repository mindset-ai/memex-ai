// Integration tests for the back-end outcome sink (spec-244 t-3 / dec-8) — REAL
// Postgres + REAL bus. Emit ChangeEvents and assert which ones get mirrored into
// usage_events.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { usageEvents } from "../db/schema.js";
import { makeTestMemex } from "./test-helpers.js";
import { upsertUserByEmail } from "./users.js";
import { bus, type ChangeEvent } from "./bus.js";
import {
  startUsageBackendSink,
  _stopUsageBackendSink,
  isWhitelistedOutcome,
} from "./usage-backend-sink.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-244/acs";

let memexId: string;
let userId: string;

beforeAll(async () => {
  memexId = await makeTestMemex("ubsink");
  const u = await upsertUserByEmail(`ubsink-${Date.now()}@memex.ai`);
  userId = u.id;
  startUsageBackendSink();
});

afterAll(async () => {
  _stopUsageBackendSink();
  await db.delete(usageEvents).where(eq(usageEvents.memexId, memexId));
});

function emit(partial: Partial<ChangeEvent> & Pick<ChangeEvent, "entity" | "action">): void {
  bus.emit({ memexId, actorUserId: userId, ...partial });
}

async function waitForRows(name: string, timeoutMs = 1500) {
  const start = Date.now();
  for (;;) {
    const rows = await db
      .select()
      .from(usageEvents)
      .where(and(eq(usageEvents.memexId, memexId), eq(usageEvents.name, name)));
    if (rows.length > 0 || Date.now() - start > timeoutMs) return rows;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("isWhitelistedOutcome — derived from the registry (dec-8)", () => {
  it("accepts registered back-end outcomes, rejects everything else", () => {
    tagAc(`${AC}/ac-18`);
    expect(isWhitelistedOutcome({ memexId, entity: "document", action: "created" })).toBe(true);
    expect(isWhitelistedOutcome({ memexId, entity: "document", action: "status_changed" })).toBe(
      true,
    );
    // Not on the whitelist: a task create, or a read.
    expect(isWhitelistedOutcome({ memexId, entity: "task", action: "created" })).toBe(false);
    expect(isWhitelistedOutcome({ memexId, entity: "document", action: "viewed" })).toBe(false);
  });
});

describe("back-end sink — mirrors whitelisted outcomes into usage_events (ac-18 / ac-1)", () => {
  it("mirrors a whitelisted document.created, carrying the acting user", async () => {
    tagAc(`${AC}/ac-18`);
    tagAc(`${AC}/ac-1`);
    emit({ entity: "document", action: "created", docId: "spec-x" });
    const rows = await waitForRows("document.created");
    expect(rows.length).toBe(1);
    expect(rows[0].source).toBe("backend");
    expect(rows[0].actorUserId).toBe(userId);
  });

  it("carries structured payload (from/to) through sanitisation for status_changed", async () => {
    tagAc(`${AC}/ac-18`);
    emit({
      entity: "document",
      action: "status_changed",
      payload: { from: "draft", to: "specify" },
    });
    const rows = await waitForRows("document.status_changed");
    expect(rows.length).toBe(1);
    expect(rows[0].props).toEqual({ from: "draft", to: "specify" });
  });

  it("never mirrors a non-whitelisted event (a task create)", async () => {
    tagAc(`${AC}/ac-18`);
    emit({ entity: "task", action: "created", docId: "spec-x" });
    // Give the (would-be) async write time to land, then assert nothing did.
    await new Promise((r) => setTimeout(r, 250));
    const rows = await db
      .select()
      .from(usageEvents)
      .where(and(eq(usageEvents.memexId, memexId), eq(usageEvents.name, "task.created")));
    expect(rows.length).toBe(0);
  });
});
