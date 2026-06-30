// Integration tests for the per-spec Stats endpoints (spec-406).
//
// Real Postgres + real app routing, same shape as analytics.integration.test.ts:
// memexResolver parses `/api/<ns-slug>/main/...`, dev-mode auth lets
// app.request() through, and rows are seeded directly with controlled
// timestamps so every aggregate is exactly predictable.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { inArray } from "drizzle-orm";

vi.hoisted(() => {
  process.env.GOOGLE_CLIENT_ID = "";
  return undefined;
});

import { db } from "../db/connection.js";
import { acs, activityLog, documents, memexes, namespaces, tasks, testEvents, testEventLatest } from "../db/schema.js";
import { app } from "../app.js";
import { makeTestMemexWithDevAdmin } from "../services/test-helpers.js";

const A = (n: number) => `mindset-prod/memex-building-itself/specs/spec-406/acs/ac-${n}`;

function withApexHost(init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...(init.headers ?? {}), Host: "memex.ai" } };
}

let memexId: string;
let path: string;
let slug: string;
let phaseSpec: string; // has a full transition series + tasks + acs
let preSpec: string; // no transitions (pre-emission)
let auditSpec: string; // activity-audit fixture
const memexIds: string[] = [];

async function seedSpec(handle: string, over: { status?: string; createdAt?: string; statusChangedAt?: string }): Promise<string> {
  const [row] = await db
    .insert(documents)
    .values({
      memexId,
      handle,
      title: `stats fixture ${handle}`,
      docType: "spec",
      status: over.status ?? "build",
      createdAt: new Date(over.createdAt ?? "2026-06-01T00:00:00Z"),
      statusChangedAt: new Date(over.statusChangedAt ?? over.createdAt ?? "2026-06-01T00:00:00Z"),
    })
    .returning();
  return row.id;
}

async function seedTransition(docId: string, from: string, to: string, at: string) {
  await db.insert(activityLog).values({
    memexId,
    briefId: docId,
    actorKind: "human",
    actorName: "Alice",
    channel: "rest_ui",
    entity: "document",
    action: "status_changed",
    narrative: `moved ${from} → ${to}`,
    payload: { from, to, doc_id: docId, doc_type: "spec" },
    createdAt: new Date(at),
  });
}

beforeAll(async () => {
  const m = await makeTestMemexWithDevAdmin("spec-stats");
  memexId = m.memexId;
  slug = m.slug;
  path = `/api/${m.slug}/main`;
  memexIds.push(memexId);

  // ── phaseSpec: created Jun 1 (draft), walks draft→specify→build→verify, then
  // RE-ENTERS build (verify→build) where it now sits. Current status: build.
  phaseSpec = await seedSpec("spec-phase", {
    status: "build",
    createdAt: "2026-06-01T00:00:00Z",
    statusChangedAt: "2026-06-06T00:00:00Z",
  });
  await seedTransition(phaseSpec, "draft", "specify", "2026-06-02T00:00:00Z");
  await seedTransition(phaseSpec, "specify", "build", "2026-06-03T00:00:00Z");
  await seedTransition(phaseSpec, "build", "verify", "2026-06-05T00:00:00Z");
  await seedTransition(phaseSpec, "verify", "build", "2026-06-06T00:00:00Z"); // re-entry

  // Tasks for velocity + summary: 3 tasks, 1 complete, 1 in_progress, 1 not_started.
  await db.insert(tasks).values([
    { memexId, docId: phaseSpec, seq: 1, title: "t1", description: "d", status: "complete", createdAt: new Date("2026-06-03T00:00:00Z"), startedAt: new Date("2026-06-03T06:00:00Z"), completedAt: new Date("2026-06-04T00:00:00Z") },
    { memexId, docId: phaseSpec, seq: 2, title: "t2", description: "d", status: "in_progress", createdAt: new Date("2026-06-03T00:00:00Z"), startedAt: new Date("2026-06-05T00:00:00Z") },
    { memexId, docId: phaseSpec, seq: 3, title: "t3", description: "d", status: "not_started", createdAt: new Date("2026-06-03T00:00:00Z") },
  ]);

  // 3 active ACs; ac-1 verified, ac-2 failing, ac-3 untested (+1 superseded, ignored).
  await db.insert(acs).values([
    { memexId, briefId: phaseSpec, seq: 1, kind: "implementation", statement: "ac one", status: "active" },
    { memexId, briefId: phaseSpec, seq: 2, kind: "implementation", statement: "ac two", status: "active" },
    { memexId, briefId: phaseSpec, seq: 3, kind: "implementation", statement: "ac three", status: "active" },
    { memexId, briefId: phaseSpec, seq: 4, kind: "implementation", statement: "ac four", status: "superseded" },
  ]);
  const acPrefix = `${slug}/main/specs/spec-phase/acs`;
  await db.insert(testEventLatest).values([
    { memexId, subjectRef: `${acPrefix}/ac-1`, testIdentifier: "t1", latestStatus: "pass", latestRunAt: new Date(), runCount: 1 },
    { memexId, subjectRef: `${acPrefix}/ac-2`, testIdentifier: "t1", latestStatus: "pass", latestRunAt: new Date(), runCount: 1 },
    { memexId, subjectRef: `${acPrefix}/ac-2`, testIdentifier: "t2", latestStatus: "fail", latestRunAt: new Date(), runCount: 1 },
  ]);

  // ── preSpec: no transition events at all (pre-emission), sits in build.
  preSpec = await seedSpec("spec-pre", {
    status: "build",
    createdAt: "2026-06-01T00:00:00Z",
    statusChangedAt: "2026-06-10T00:00:00Z",
  });

  // ── auditSpec: a normal attributed edit (kept), a read (excluded), a system
  // sweep (excluded), and a test-event (excluded by default, shown with showAll).
  auditSpec = await seedSpec("spec-audit", { status: "build" });
  await db.insert(activityLog).values([
    { memexId, briefId: auditSpec, actorKind: "human", actorName: "Alice", channel: "rest_ui", entity: "document", action: "updated", narrative: "edited the spec", createdAt: new Date("2026-06-08T00:00:00Z") },
    { memexId, briefId: auditSpec, actorKind: "human", actorName: "Bob", channel: "rest_ui", entity: "document", action: "viewed", narrative: "viewed", createdAt: new Date("2026-06-08T01:00:00Z") },
    { memexId, briefId: auditSpec, actorKind: "system", actorUserId: null, actorName: null, channel: "server", entity: "document", action: "checkpoint", narrative: "sweep", createdAt: new Date("2026-06-08T02:00:00Z") },
  ]);
  await db.insert(testEvents).values({
    memexId,
    subjectRef: `${slug}/main/specs/spec-audit/acs/ac-1`,
    status: "pass",
    testIdentifier: "t-audit",
    hidden: false,
    createdAt: new Date("2026-06-08T03:00:00Z"),
  });
});

afterAll(async () => {
  const rows = await db.select().from(memexes).where(inArray(memexes.id, memexIds));
  await db.delete(namespaces).where(inArray(namespaces.id, rows.map((m) => m.namespaceId)));
});

describe("GET /analytics/spec/:id/phase-durations", () => {
  it("derives the segment series from status_changed events, seeded from created_at (ac-7)", async () => {
    tagAc(A(7));
    const res = await app.request(`${path}/analytics/spec/spec-phase/phase-durations`, withApexHost());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { segments: Array<{ phase: string; start: string; end: string | null }>; hasTransitionHistory: boolean };
    expect(body.hasTransitionHistory).toBe(true);
    // First segment is draft, seeded from the doc's created_at → first transition.
    expect(body.segments[0]).toMatchObject({ phase: "draft", start: "2026-06-01T00:00:00.000Z", end: "2026-06-02T00:00:00.000Z" });
    // Five segments: draft, specify, build, verify, build(re-entry).
    expect(body.segments.map((s) => s.phase)).toEqual(["draft", "specify", "build", "verify", "build"]);
  });

  it("sums re-entries into one per-phase total and runs the open phase to now (ac-8, ac-9)", async () => {
    tagAc(A(8));
    tagAc(A(9));
    tagAc(A(2)); // scope: the tab shows time spent in each phase, re-entry aware, open phase to now
    const res = await app.request(`${path}/analytics/spec/spec-phase/phase-durations`, withApexHost());
    const body = (await res.json()) as { totals: Array<{ phase: string; days: number }>; segments: Array<{ phase: string; end: string | null }> };
    const byPhase = Object.fromEntries(body.totals.map((t) => [t.phase, t.days]));
    expect(byPhase.draft).toBe(1);
    expect(byPhase.specify).toBe(1);
    expect(byPhase.verify).toBe(1);
    // build appears ONCE in totals (re-entries merged): the closed 2-day visit
    // PLUS the open visit (Jun 6 → now), so well over 2.
    expect(body.totals.filter((t) => t.phase === "build")).toHaveLength(1);
    expect(byPhase.build).toBeGreaterThan(2);
    // Exactly one open segment (end === null) — the current phase running to now.
    expect(body.segments.filter((s) => s.end === null)).toHaveLength(1);
  });

  it("falls back to a single caveated current-phase band for a pre-emission spec, no fabricated boundaries (ac-10)", async () => {
    tagAc(A(10));
    const res = await app.request(`${path}/analytics/spec/spec-pre/phase-durations`, withApexHost());
    const body = (await res.json()) as { segments: Array<{ phase: string; start: string; end: string | null }>; totals: unknown[]; hasTransitionHistory: boolean; caveat: string | null };
    expect(body.hasTransitionHistory).toBe(false);
    expect(body.caveat).toBeTruthy();
    expect(body.segments).toHaveLength(1);
    expect(body.segments[0]).toMatchObject({ phase: "build", start: "2026-06-10T00:00:00.000Z", end: null });
    expect(body.totals).toHaveLength(1);
  });
});

describe("GET /analytics/spec/:id/* — endpoint shape & read access", () => {
  it("resolves a spec by handle and returns shaped summary data, not raw rows (ac-11, ac-12)", async () => {
    tagAc(A(11));
    tagAc(A(12));
    tagAc(A(3)); // scope: every number is server-side SQL-derived, not raw rows
    const res = await app.request(`${path}/analytics/spec/spec-phase/summary`, withApexHost());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { currentPhase: string; ageDays: number; tasks: { total: number; complete: number }; acs: { total: number; verified: number } };
    // A chart-shaped summary object — not a dump of document/task rows.
    expect(body.currentPhase).toBe("build");
    expect(typeof body.ageDays).toBe("number");
    expect(body.tasks).toMatchObject({ total: 3, complete: 1 });
    expect(body.acs).toMatchObject({ total: 3, verified: 1 });
  });

  it("is ungated — reachable with no feature flag set (ac-22)", async () => {
    tagAc(A(22));
    const res = await app.request(`${path}/analytics/spec/spec-phase/ac-verification`, withApexHost());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ total: 3, verified: 1, failing: 1, untested: 1 });
  });

  it("404s an unknown namespace and a cross-tenant / unknown spec id (ac-23)", async () => {
    tagAc(A(23));
    const unknownNs = await app.request("/api/no-such-ns/main/analytics/spec/spec-phase/summary", withApexHost());
    expect(unknownNs.status).toBe(404);
    const unknownSpec = await app.request(`${path}/analytics/spec/spec-does-not-exist/summary`, withApexHost());
    expect(unknownSpec.status).toBe(404);
    tagAc(A(6)); // scope: endpoints are read-only and respect memex read access (404 on unknown/cross-tenant)
  });
});

describe("GET /analytics/spec/:id/task-velocity", () => {
  it("returns the daily created/started/completed series + status breakdown (ac-21 data)", async () => {
    tagAc(A(21));
    const res = await app.request(`${path}/analytics/spec/spec-phase/task-velocity`, withApexHost());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { points: Array<{ day: string; created: number; started: number; completed: number }>; statusBreakdown: Record<string, number> };
    expect(body.statusBreakdown).toMatchObject({ not_started: 1, in_progress: 1, complete: 1 });
    const jun3 = body.points.find((p) => p.day === "2026-06-03")!;
    expect(jun3).toMatchObject({ created: 3, started: 1 }); // all 3 created, t1 started Jun 3
    const jun4 = body.points.find((p) => p.day === "2026-06-04")!;
    expect(jun4.completed).toBe(1);
  });
});

describe("GET /analytics/spec/:id/activity — the who/what/when audit", () => {
  it("curates out reads, test-events and system sweeps by default (ac-13)", async () => {
    tagAc(A(13));
    const res = await app.request(`${path}/analytics/spec/spec-audit/activity`, withApexHost());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ action: string | null; kind: string; narrative: string | null }> };
    const actions = body.rows.map((r) => r.action);
    const kinds = body.rows.map((r) => r.kind);
    expect(body.rows.some((r) => r.narrative === "edited the spec")).toBe(true); // kept
    expect(actions).not.toContain("viewed"); // read excluded
    expect(actions).not.toContain("checkpoint"); // system sweep excluded
    expect(kinds).not.toContain("test_event"); // test-event excluded
  });

  it("re-admits the full slice with showAll (ac-14)", async () => {
    tagAc(A(14));
    const res = await app.request(`${path}/analytics/spec/spec-audit/activity?showAll=1`, withApexHost());
    const body = (await res.json()) as { rows: Array<{ action: string | null; kind: string }> };
    expect(body.rows.some((r) => r.action === "viewed")).toBe(true);
    expect(body.rows.some((r) => r.kind === "test_event")).toBe(true);
  });

  it("attributes each row with WHO, WHEN, HOW and WHAT (ac-15)", async () => {
    tagAc(A(15));
    tagAc(A(4)); // scope: the tab includes a who/what/when activity audit, per-row attributed
    const res = await app.request(`${path}/analytics/spec/spec-audit/activity`, withApexHost());
    const body = (await res.json()) as { rows: Array<{ at: string; actorName: string | null; channel: string | null; kind: string; action: string | null; narrative: string | null }> };
    const edit = body.rows.find((r) => r.narrative === "edited the spec")!;
    expect(edit.actorName).toBe("Alice"); // WHO
    expect(typeof edit.at).toBe("string"); // WHEN
    expect(edit.channel).toBe("rest_ui"); // HOW
    expect(edit.action).toBe("updated"); // WHAT
    expect(edit.kind).toBe("activity_log");
  });
});
