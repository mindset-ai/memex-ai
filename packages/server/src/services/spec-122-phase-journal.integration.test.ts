// spec-122 t-4 (dec-3) — the status_changed journal carries the contract, and
// phase history rides those rows (no phase_transitions table).
//
//   ac-11  NO phase_transitions table; phase history is read from activity_log
//          status_changed rows (entity='document', action='status_changed',
//          payload={from,to}).
//   ac-12  the status_changed emission carries the contract columns
//          (actor_user_id, actor_name, channel) — a phase move records WHO moved
//          it and through WHICH surface.
//   ac-13  per-spec dwell-time and thrash (build↔verify bounces) are derivable
//          from the ordered sequence of that spec's status_changed rows.
//
// TAGGED → reports to the PROD memex. Run with MEMEX_EMIT_KEY set.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import {
  users,
  namespaces,
  orgs,
  orgMemberships,
  memexes,
  documents,
  activityLog,
} from "../db/schema.js";
import { createDocDraft, updateDocStatus } from "./documents.js";
import { startActivityLogSink, _stopActivityLogSink, mapEventToRow } from "./activity-log.js";
import { bus, type ChangeEvent } from "./bus.js";
import { getPhaseHistory, computePhaseMetrics, hasPhaseTransitionsTable } from "./phase-history.js";
import type { RequestCtx } from "./mutate.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-122/acs";

const created = { users: [] as string[], memexes: [] as string[], docs: [] as string[] };
let userId: string;
let memexId: string;
let sinkOff: (() => void) | undefined;

async function setup() {
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const [u] = await db.insert(users).values({ email: `pj-${tag}@memex.ai`, name: "Barrie" } as typeof users.$inferInsert).returning();
  userId = u.id; created.users.push(u.id);
  const [ns] = await db.insert(namespaces).values({ slug: `pj-${tag}`, kind: "org" }).returning();
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: `T ${tag}` }).returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [m] = await db.insert(memexes).values({ namespaceId: ns.id, slug: "main", name: `T ${tag}` }).returning();
  memexId = m.id; created.memexes.push(m.id);
  await db.insert(orgMemberships).values({ userId: u.id, orgId: org.id, role: "administrator" });
}

async function waitForStatusChangedRows(docId: string, n: number): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const rows = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(and(eq(activityLog.briefId, docId), eq(activityLog.action, "status_changed")));
    if (rows.length >= n) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeAll(async () => {
  await setup();
  // Arm the sink (production wires it in index.ts; the integration test owns its lifecycle).
  sinkOff = startActivityLogSink();
});

afterAll(async () => {
  if (sinkOff) _stopActivityLogSink();
  if (created.docs.length) {
    await db.delete(activityLog).where(inArray(activityLog.briefId, created.docs)).catch(() => {});
    await db.delete(documents).where(inArray(documents.id, created.docs)).catch(() => {});
  }
  if (created.memexes.length) await db.delete(memexes).where(inArray(memexes.id, created.memexes)).catch(() => {});
  if (created.users.length) await db.delete(users).where(inArray(users.id, created.users)).catch(() => {});
});

describe("phase journal: contract + history [spec-122 t-4]", () => {
  // ── ac-11 ───────────────────────────────────────────────────────────────
  it("ac-11: no phase_transitions table; history reads from activity_log status_changed rows", async () => {
    tagAc(`${AC}/ac-11`);
    expect(await hasPhaseTransitionsTable()).toBe(false);

    const doc = await createDocDraft(memexId, "AC11", "x", "spec");
    created.docs.push(doc.id);
    await updateDocStatus(memexId, doc.id, "specify", { ctx: { actorUserId: userId, actorName: "Barrie", channel: "rest_ui" } });
    await waitForStatusChangedRows(doc.id, 1);

    const history = await getPhaseHistory(memexId, doc.id);
    expect(history.length).toBe(1);
    expect(history[0]).toMatchObject({ from: "draft", to: "specify" });
  });

  // ── ac-12 ───────────────────────────────────────────────────────────────
  it("ac-12: the status_changed emission carries actor_user_id + actor_name + channel", async () => {
    tagAc(`${AC}/ac-12`);
    const ctx: RequestCtx = { actorUserId: userId, actorName: "Barrie", channel: "mcp" };

    // Capture the emitted events synchronously off the bus.
    const seen: ChangeEvent[] = [];
    const off = bus.subscribe({}, (e) => { seen.push(e); });
    const doc = await createDocDraft(memexId, "AC12", "x", "spec");
    created.docs.push(doc.id);
    await updateDocStatus(memexId, doc.id, "build", { ctx });
    off();

    const sc = seen.find((e) => e.action === "status_changed" && e.docId === doc.id);
    expect(sc, "a status_changed event was emitted").toBeTruthy();
    expect(sc!.actorUserId).toBe(userId);
    expect(sc!.actorName).toBe("Barrie");
    expect(sc!.channel).toBe("mcp");
    expect(sc!.payload).toMatchObject({ from: "draft", to: "build" });

    // The sink maps that event onto a fully-attributed activity_log row.
    const row = mapEventToRow(sc!);
    expect(row.actorUserId).toBe(userId);
    expect(row.actorName).toBe("Barrie");
    expect(row.channel).toBe("mcp");

    // And the persisted row carries it too.
    await waitForStatusChangedRows(doc.id, 1);
    const [persisted] = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.briefId, doc.id), eq(activityLog.action, "status_changed")));
    expect(persisted.actorUserId).toBe(userId);
    expect(persisted.actorName).toBe("Barrie");
    expect(persisted.channel).toBe("mcp");
  });

  // ── ac-13 ───────────────────────────────────────────────────────────────
  it("ac-13: dwell-time and thrash (a verify→build bounce) are derivable from the ordered rows", async () => {
    tagAc(`${AC}/ac-13`);
    const ctx: RequestCtx = { actorUserId: userId, actorName: "Barrie", channel: "rest_ui" };
    const doc = await createDocDraft(memexId, "AC13", "x", "spec");
    created.docs.push(doc.id);

    // draft → build → verify → build (the thrash) → verify
    for (const to of ["build", "verify", "build", "verify"]) {
      await updateDocStatus(memexId, doc.id, to, { ctx });
      await new Promise((r) => setTimeout(r, 5)); // distinct timestamps for dwell
    }
    await waitForStatusChangedRows(doc.id, 4);

    const history = await getPhaseHistory(memexId, doc.id);
    expect(history.length).toBe(4);
    expect(history.map((h) => h.to)).toEqual(["build", "verify", "build", "verify"]);

    const metrics = computePhaseMetrics(history, new Date());
    // One verify→build regression in the sequence.
    expect(metrics.thrashCount).toBe(1);
    expect(metrics.transitions).toBe(4);
    // Dwell is attributed per entered phase, derived from the ordered sequence.
    expect(Object.keys(metrics.dwellMsByPhase)).toEqual(expect.arrayContaining(["build", "verify"]));
  });
});
