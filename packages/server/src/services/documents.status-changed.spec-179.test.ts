// spec-179 (ac-5): a Spec status flip writes an immutable document/status_changed
// activity row with `{from, to}` payload — the transition history that makes
// per-phase durations exactly computable (statusChangedAt only keeps the latest).
//
// Same hard rule as activity-log.test.ts: the persistence boundary runs against
// REAL Postgres — no mocks. Cleanup cascades off the namespace delete.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { activityLog, documents, memexes, namespaces } from "../db/schema.js";
import { makeTestMemex } from "./test-helpers.js";
import { updateDocStatus } from "./documents.js";
import { startActivityLogSink, _stopActivityLogSink } from "./activity-log.js";

const AC_STATUS_CHANGED = "mindset-prod/memex-building-itself/specs/spec-179/acs/ac-5";

let memexId: string;

async function makeDoc(docType: "spec" | "document", status = "draft"): Promise<{ id: string; handle: string }> {
  const handle = `${docType === "spec" ? "spec" : "doc"}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const [doc] = await db
    .insert(documents)
    .values({ memexId, handle, title: "status-changed test doc", docType, status })
    .returning();
  return { id: doc.id, handle: doc.handle };
}

beforeAll(async () => {
  memexId = await makeTestMemex("statchg");
  startActivityLogSink();
});

afterAll(async () => {
  _stopActivityLogSink();
  const [mx] = await db.select().from(memexes).where(eq(memexes.id, memexId));
  if (mx) {
    await db.delete(namespaces).where(eq(namespaces.id, mx.namespaceId));
  }
});

beforeEach(async () => {
  // Each test asserts on exact row sets — start clean.
  await db.delete(activityLog).where(eq(activityLog.memexId, memexId));
});

// Poll until at least `expected` matching rows land (the sink persists on a
// detached promise off the synchronous emit path), or time out.
async function waitForStatusRows(expected: number, timeoutMs = 2000) {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const rows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.memexId, memexId));
    const statusRows = rows.filter((r) => r.action === "status_changed");
    if (statusRows.length >= expected) return { rows, statusRows };
    if (Date.now() - start > timeoutMs) return { rows, statusRows };
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("updateDocStatus — document/status_changed emission (spec-179 ac-5)", () => {
  it("a Spec status flip persists an immutable status_changed row with {from, to} payload", async () => {
    tagAc(AC_STATUS_CHANGED);
    const spec = await makeDoc("spec", "draft");

    await updateDocStatus(memexId, spec.id, "specify");

    const { statusRows } = await waitForStatusRows(1);
    expect(statusRows).toHaveLength(1);
    expect(statusRows[0]).toMatchObject({
      memexId,
      briefId: spec.id,
      entity: "document",
      action: "status_changed",
      narrative: `moved ${spec.handle} draft → specify`,
      payload: { from: "draft", to: "specify" },
    });
  });

  it("the plain updated event still fires alongside status_changed (one event per logical change)", async () => {
    tagAc(AC_STATUS_CHANGED);
    const spec = await makeDoc("spec", "specify");

    await updateDocStatus(memexId, spec.id, "build");

    const { rows, statusRows } = await waitForStatusRows(1);
    expect(statusRows).toHaveLength(1);
    expect(statusRows[0].payload).toEqual({ from: "specify", to: "build" });
    expect(rows.filter((r) => r.action === "updated")).toHaveLength(1);
  });

  it("a non-spec docType status flip does NOT emit status_changed", async () => {
    tagAc(AC_STATUS_CHANGED);
    const doc = await makeDoc("document", "draft");

    await updateDocStatus(memexId, doc.id, "approved");

    // Wait for the guaranteed "updated" row, then confirm no status_changed.
    const start = Date.now();
    let rows: (typeof activityLog.$inferSelect)[] = [];
    while (Date.now() - start < 2000) {
      rows = await db.select().from(activityLog).where(eq(activityLog.memexId, memexId));
      if (rows.some((r) => r.action === "updated")) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(rows.some((r) => r.action === "updated")).toBe(true);
    expect(rows.filter((r) => r.action === "status_changed")).toHaveLength(0);
  });

  it("a same-status write does NOT emit status_changed", async () => {
    tagAc(AC_STATUS_CHANGED);
    const spec = await makeDoc("spec", "build");

    await updateDocStatus(memexId, spec.id, "build");

    const start = Date.now();
    let rows: (typeof activityLog.$inferSelect)[] = [];
    while (Date.now() - start < 2000) {
      rows = await db.select().from(activityLog).where(eq(activityLog.memexId, memexId));
      if (rows.some((r) => r.action === "updated")) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(rows.some((r) => r.action === "updated")).toBe(true);
    expect(rows.filter((r) => r.action === "status_changed")).toHaveLength(0);
  });
});
