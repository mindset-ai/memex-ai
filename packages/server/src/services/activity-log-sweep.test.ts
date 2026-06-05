import { describe, it, expect, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { activityLog, memexes, namespaces } from "../db/schema.js";
import { sweepActivityLog, PULSE_RETENTION_DAYS } from "./activity-log-sweep.js";

// Real Postgres — no mocks for persistence. activity_log.memex_id is NOT NULL with
// a FK to memexes, so we seed a throwaway namespace + memex to anchor the rows.
const createdMemexIds: string[] = [];
const createdNamespaceIds: string[] = [];

afterAll(async () => {
  if (createdMemexIds.length) {
    // CASCADE from memex deletes any leftover activity_log rows anchored to it.
    await db.delete(memexes).where(inArray(memexes.id, createdMemexIds)).catch(() => {});
  }
  if (createdNamespaceIds.length) {
    await db.delete(namespaces).where(inArray(namespaces.id, createdNamespaceIds)).catch(() => {});
  }
});

function unique(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toLowerCase();
}

async function seedMemex(): Promise<string> {
  const [ns] = await db
    .insert(namespaces)
    .values({ slug: unique("als"), kind: "org" })
    .returning();
  createdNamespaceIds.push(ns.id);
  const [memex] = await db
    .insert(memexes)
    .values({ namespaceId: ns.id, slug: "main", name: "Activity Log Sweep Test" })
    .returning();
  createdMemexIds.push(memex.id);
  return memex.id;
}

function makeRow(memexId: string, createdAt: Date) {
  return {
    memexId,
    actorKind: "system" as const,
    channel: "server" as const,
    entity: "tool_call",
    action: "called",
    narrative: "sweep test row",
    createdAt,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

describe("sweepActivityLog", () => {
  it("deletes rows older than the retention window and keeps recent rows", async () => {
    const memexId = await seedMemex();
    const now = Date.now();

    // 3 old rows (well past the window) + 2 recent rows (inside the window).
    const old = Array.from({ length: 3 }, (_, i) =>
      makeRow(memexId, new Date(now - (PULSE_RETENTION_DAYS + 5 + i) * DAY_MS)),
    );
    const recent = [
      makeRow(memexId, new Date(now - 1 * DAY_MS)),
      makeRow(memexId, new Date(now)),
    ];
    await db.insert(activityLog).values([...old, ...recent]);

    const deleted = await sweepActivityLog();
    expect(deleted).toBeGreaterThanOrEqual(3);

    const remaining = await db.query.activityLog.findMany({
      where: eq(activityLog.memexId, memexId),
    });
    expect(remaining).toHaveLength(2);
    // Every surviving row is inside the retention window.
    const cutoff = now - PULSE_RETENTION_DAYS * DAY_MS;
    for (const row of remaining) {
      expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(cutoff);
    }
  });

  it("is idempotent — a second pass deletes nothing", async () => {
    const memexId = await seedMemex();
    const now = Date.now();
    await db.insert(activityLog).values([
      makeRow(memexId, new Date(now - (PULSE_RETENTION_DAYS + 10) * DAY_MS)),
      makeRow(memexId, new Date(now)),
    ]);

    const first = await sweepActivityLog();
    expect(first).toBeGreaterThanOrEqual(1);

    const second = await sweepActivityLog();
    expect(second).toBe(0);

    const remaining = await db.query.activityLog.findMany({
      where: eq(activityLog.memexId, memexId),
    });
    expect(remaining).toHaveLength(1);
  });

  it("bounds a single pass to the LIMIT and leaves the overflow for the next pass", async () => {
    const memexId = await seedMemex();
    const now = Date.now();

    // 5 old rows, all eligible for deletion. With limit=2 a single pass must
    // delete exactly 2 and leave 3 behind (proving the per-pass bound).
    const rows = Array.from({ length: 5 }, (_, i) =>
      makeRow(memexId, new Date(now - (PULSE_RETENTION_DAYS + 1 + i) * DAY_MS)),
    );
    await db.insert(activityLog).values(rows);

    const deleted = await sweepActivityLog(PULSE_RETENTION_DAYS, 2);
    expect(deleted).toBe(2);

    const remaining = await db.query.activityLog.findMany({
      where: eq(activityLog.memexId, memexId),
    });
    expect(remaining).toHaveLength(3);

    // Draining the rest with an unbounded-enough pass clears them.
    const drained = await sweepActivityLog(PULSE_RETENTION_DAYS, 10_000);
    expect(drained).toBe(3);
  });
});
