// Integration tests for the spec-analytics endpoints (spec-179, t-3).
//
// Real Postgres + real app routing, same shape as activity.integration.test.ts:
// memexResolver parses `/api/<ns-slug>/main/...`, dev-mode auth lets
// app.request() through, and documents are seeded directly with controlled
// created_at / status_changed_at so every aggregate is exactly predictable.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { inArray } from "drizzle-orm";

// Force dev-mode auth so app.request() can hit session-gated routes without
// minting a JWT (same shape as activity.integration.test.ts).
vi.hoisted(() => {
  process.env.GOOGLE_CLIENT_ID = "";
  return undefined;
});

import { db } from "../db/connection.js";
import { acs, activityLog, documents, memexes, namespaces, testEventLatest, testEvents } from "../db/schema.js";
import { app } from "../app.js";
import { makeTestMemexWithDevAdmin } from "../services/test-helpers.js";

const AC_OVER_TIME = "mindset-prod/memex-building-itself/specs/spec-179/acs/ac-1";
const AC_BY_PHASE_AND_DURATIONS = "mindset-prod/memex-building-itself/specs/spec-179/acs/ac-2";

let memexA: string;
let pathA: string;
let memexB: string;
let pathB: string;
const memexIds: string[] = [];

function withApexHost(init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...(init.headers ?? {}), Host: "memex.ai" } };
}

let seq = 0;
async function seedDoc(over: {
  memexId: string;
  docType?: string;
  status?: string;
  createdAt: string; // ISO date
  statusChangedAt?: string;
  archivedAt?: string;
}): Promise<string> {
  const [row] = await db
    .insert(documents)
    .values({
      memexId: over.memexId,
      handle: `spec-seed-${++seq}`,
      title: `analytics seed ${seq}`,
      docType: over.docType ?? "spec",
      status: over.status ?? "draft",
      createdAt: new Date(over.createdAt),
      statusChangedAt: new Date(over.statusChangedAt ?? over.createdAt),
      ...(over.archivedAt ? { archivedAt: new Date(over.archivedAt) } : {}),
    })
    .returning();
  return row.id;
}

beforeAll(async () => {
  const a = await makeTestMemexWithDevAdmin("analyt-a");
  memexA = a.memexId;
  pathA = `/api/${a.slug}/main`;
  const b = await makeTestMemexWithDevAdmin("analyt-b");
  memexB = b.memexId;
  pathB = `/api/${b.slug}/main`;
  memexIds.push(memexA, memexB);

  // Memex A — the fixture the numeric assertions are written against:
  //   Jun 1: spec done (cycle Jun 1 → Jun 3 = 2.00 days), spec draft
  //   Jun 2: archived draft (counts for over-time/by-phase, excluded in-phase)
  //   Jun 3: spec build, spec done (cycle Jun 3 → Jun 4 = 1.00 days)
  await seedDoc({ memexId: memexA, status: "done", createdAt: "2026-06-01T00:00:00Z", statusChangedAt: "2026-06-03T00:00:00Z" });
  await seedDoc({ memexId: memexA, status: "draft", createdAt: "2026-06-01T06:00:00Z" });
  await seedDoc({ memexId: memexA, status: "draft", createdAt: "2026-06-02T00:00:00Z", archivedAt: "2026-06-04T00:00:00Z" });
  await seedDoc({ memexId: memexA, status: "build", createdAt: "2026-06-03T00:00:00Z", statusChangedAt: "2026-06-04T00:00:00Z" });
  await seedDoc({ memexId: memexA, status: "done", createdAt: "2026-06-03T12:00:00Z", statusChangedAt: "2026-06-04T12:00:00Z" });
  // Non-spec doc — must be invisible to every aggregate.
  await seedDoc({ memexId: memexA, docType: "document", status: "approved", createdAt: "2026-06-01T00:00:00Z" });

  // Memex B — one spec, to prove memex isolation.
  await seedDoc({ memexId: memexB, status: "draft", createdAt: "2026-06-01T00:00:00Z" });
});

afterAll(async () => {
  const rows = await db.select().from(memexes).where(inArray(memexes.id, memexIds));
  await db.delete(namespaces).where(
    inArray(
      namespaces.id,
      rows.map((m) => m.namespaceId),
    ),
  );
});

describe("GET /analytics/specs-over-time", () => {
  it("returns a gapless daily series with created + cumulative counts (specs only)", async () => {
    tagAc(AC_OVER_TIME);
    const res = await app.request(`${pathA}/analytics/specs-over-time`, withApexHost());
    expect(res.status).toBe(200);
    const { points } = (await res.json()) as { points: Array<{ day: string; created: number; cumulative: number }> };

    expect(points[0]).toEqual({ day: "2026-06-01", created: 2, cumulative: 2 });
    expect(points[1]).toEqual({ day: "2026-06-02", created: 1, cumulative: 3 });
    expect(points[2]).toEqual({ day: "2026-06-03", created: 2, cumulative: 5 });
    // Gapless through today: every later day contributes 0 new, cumulative stays 5.
    expect(points.at(-1)!.cumulative).toBe(5);
    expect(points.at(-1)!.created).toBe(0);
    // Consecutive days, no holes.
    for (let i = 1; i < points.length; i++) {
      const prev = new Date(points[i - 1].day).getTime();
      expect(new Date(points[i].day).getTime() - prev).toBe(86_400_000);
    }
  });

  it("is memex-isolated — memex B sees only its own spec", async () => {
    tagAc(AC_OVER_TIME);
    const res = await app.request(`${pathB}/analytics/specs-over-time`, withApexHost());
    const { points } = (await res.json()) as { points: Array<{ cumulative: number }> };
    expect(points.at(-1)!.cumulative).toBe(1);
  });
});

describe("GET /analytics/specs-by-phase", () => {
  it("returns cumulative counts per current phase, archived specs included", async () => {
    tagAc(AC_BY_PHASE_AND_DURATIONS);
    const res = await app.request(`${pathA}/analytics/specs-by-phase`, withApexHost());
    expect(res.status).toBe(200);
    const { points } = (await res.json()) as {
      points: Array<{ day: string; draft: number; specify: number; build: number; verify: number; done: number }>;
    };
    const last = points.at(-1)!;
    expect(last).toMatchObject({ draft: 2, specify: 0, build: 1, verify: 0, done: 2 });
    // Day 1 snapshot: the two Jun-1 specs (one now done, one draft).
    expect(points[0]).toMatchObject({ day: "2026-06-01", draft: 1, done: 1, build: 0 });
  });
});

describe("GET /analytics/phase-durations", () => {
  it("computes in-phase ages (non-archived only) and exact cycle times for done specs", async () => {
    tagAc(AC_BY_PHASE_AND_DURATIONS);
    const res = await app.request(`${pathA}/analytics/phase-durations`, withApexHost());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      inPhase: Array<{ phase: string; n: number; avgDays: number }>;
      cycleTime: { n: number; valuesDays: number[]; medianDays: number; avgDays: number; maxDays: number };
    };

    // Archived Jun-2 draft is excluded: draft n=1, build n=1, done n=2.
    const byPhase = Object.fromEntries(body.inPhase.map((r) => [r.phase, r]));
    expect(byPhase.draft.n).toBe(1);
    expect(byPhase.build.n).toBe(1);
    expect(byPhase.done.n).toBe(2);
    // Phase order is the lifecycle order.
    expect(body.inPhase.map((r) => r.phase)).toEqual(["draft", "build", "done"]);

    // Cycle times are exact: 2.00 and 1.00 days, sorted ascending.
    expect(body.cycleTime.n).toBe(2);
    expect(body.cycleTime.valuesDays).toEqual([1, 2]);
    expect(body.cycleTime.medianDays).toBe(1.5);
    expect(body.cycleTime.avgDays).toBe(1.5);
    expect(body.cycleTime.maxDays).toBe(2);
  });
});

describe("tenancy (std-7)", () => {
  it("an unknown namespace 404s", async () => {
    // ac-17: the Insights API surface returns 404 to outsiders per std-7.
    tagAc("mindset-prod/memex-building-itself/specs/spec-179/acs/ac-17");
    const res = await app.request("/api/no-such-ns/main/analytics/specs-over-time", withApexHost());
    expect(res.status).toBe(404);
  });
});

// ── Follow-on charts (ac-18): funnel, actor activity, AC verification ────────

const AC_FOLLOW_ON = "mindset-prod/memex-building-itself/specs/spec-179/acs/ac-18";

describe("GET /analytics/pipeline-funnel", () => {
  it("counts active specs at-or-beyond each phase (archived excluded)", async () => {
    tagAc(AC_FOLLOW_ON);
    const res = await app.request(`${pathA}/analytics/pipeline-funnel`, withApexHost());
    expect(res.status).toBe(200);
    const { stages } = (await res.json()) as {
      stages: Array<{ phase: string; count: number }>;
    };
    // Fixture (active only): 1 draft, 1 build, 2 done. At-or-beyond:
    // draft=4, specify=3 (build+done), build=3, verify=2, done=2.
    expect(stages).toEqual([
      { phase: "draft", count: 4 },
      { phase: "specify", count: 3 },
      { phase: "build", count: 3 },
      { phase: "verify", count: 2 },
      { phase: "done", count: 2 },
    ]);
  });
});

describe("GET /analytics/activity-by-actor", () => {
  it("splits per-day activity by actor kind, excluding reads and test events", async () => {
    tagAc(AC_FOLLOW_ON);
    const seed = async (over: { actorKind: string; action?: string; entity?: string; day: string }) =>
      db.insert(activityLog).values({
        memexId: memexA,
        actorKind: over.actorKind,
        channel: over.actorKind === "human" ? "rest_ui" : over.actorKind === "system" ? "server" : "mcp",
        entity: over.entity ?? "document",
        action: over.action ?? "updated",
        narrative: "seeded",
        createdAt: new Date(`${over.day}T10:00:00Z`),
      });
    await seed({ actorKind: "human", day: "2026-06-02" });
    await seed({ actorKind: "human", day: "2026-06-02" });
    await seed({ actorKind: "mcp_agent", day: "2026-06-02" });
    await seed({ actorKind: "mcp_agent", day: "2026-06-03" });
    // Noise — must be excluded:
    await seed({ actorKind: "human", day: "2026-06-02", action: "viewed" });
    await seed({ actorKind: "system", day: "2026-06-02", entity: "test_event", action: "created" });
    // System plumbing (sweeps, unattributed server writes) is excluded even
    // when it's a normal mutation — the chart measures people and agents.
    await seed({ actorKind: "system", day: "2026-06-02" });

    const res = await app.request(`${pathA}/analytics/activity-by-actor`, withApexHost());
    expect(res.status).toBe(200);
    const { points } = (await res.json()) as {
      points: Array<{ day: string; human: number; mcp_agent: number; in_app_agent: number }>;
    };
    const jun2 = points.find((p) => p.day === "2026-06-02")!;
    expect(jun2).toMatchObject({ human: 2, mcp_agent: 1, in_app_agent: 0 });
    expect(jun2).not.toHaveProperty("system");
    const jun3 = points.find((p) => p.day === "2026-06-03")!;
    expect(jun3).toMatchObject({ human: 0, mcp_agent: 1 });
    // Gapless between the two days regardless of how far today extends.
    expect(points.findIndex((p) => p.day === "2026-06-03")).toBe(
      points.findIndex((p) => p.day === "2026-06-02") + 1,
    );
  });
});

describe("GET /analytics/ac-verification", () => {
  it("rolls latest emissions up to verified / failing / untested per AC", async () => {
    tagAc(AC_FOLLOW_ON);
    // A spec carrying 4 active ACs (+1 superseded — must not count).
    const [spec] = await db
      .insert(documents)
      .values({ memexId: memexA, handle: "spec-vrf", title: "verification fixture", docType: "spec" })
      .returning();
    const mkAc = (seq: number, status = "active") =>
      db.insert(acs).values({
        memexId: memexA,
        briefId: spec.id,
        seq,
        kind: "implementation",
        statement: `ac ${seq}`,
        status,
      });
    await mkAc(1);
    await mkAc(2);
    await mkAc(3);
    await mkAc(4);
    await mkAc(5, "superseded");

    // Latest emissions, keyed by canonical ac_uid under THIS memex's slugs:
    // ac-1 all green (verified), ac-2 green+red (failing), ac-3/ac-4 silent.
    const a = await db.select().from(memexes).where(inArray(memexes.id, [memexA]));
    const ns = await db.select().from(namespaces).where(inArray(namespaces.id, [a[0].namespaceId]));
    const prefix = `${ns[0].slug}/main/specs/spec-vrf/acs`;
    const emit = (acN: number, test: string, status: string) =>
      db.insert(testEventLatest).values({
        acUid: `${prefix}/ac-${acN}`,
        testIdentifier: test,
        latestStatus: status,
        latestRunAt: new Date(),
        runCount: 1,
      });
    await emit(1, "t1", "pass");
    await emit(1, "t2", "pass");
    await emit(2, "t1", "pass");
    await emit(2, "t2", "fail");

    const res = await app.request(`${pathA}/analytics/ac-verification`, withApexHost());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ total: 4, verified: 1, failing: 1, untested: 2 });
  });
});

// ── Verification momentum (ac-19): ACs over time + test-run volume ──────────

const AC_MOMENTUM = "mindset-prod/memex-building-itself/specs/spec-179/acs/ac-19";

describe("GET /analytics/acs-over-time and /analytics/test-run-volume", () => {
  it("tracks cumulative created vs first-verified ACs and per-day run volume", async () => {
    tagAc(AC_MOMENTUM);
    const m = await makeTestMemexWithDevAdmin("analyt-acs");
    memexIds.push(m.memexId);
    const path = `/api/${m.slug}/main`;

    const [spec] = await db
      .insert(documents)
      .values({ memexId: m.memexId, handle: "spec-mom", title: "momentum fixture", docType: "spec" })
      .returning();
    const mkAc = (seqN: number, createdAt: string) =>
      db.insert(acs).values({
        memexId: m.memexId,
        briefId: spec.id,
        seq: seqN,
        kind: "implementation",
        statement: `ac ${seqN}`,
        createdAt: new Date(createdAt),
      });
    await mkAc(1, "2026-06-01T00:00:00Z");
    await mkAc(2, "2026-06-01T12:00:00Z");
    await mkAc(3, "2026-06-02T00:00:00Z");

    const prefix = `${m.slug}/main/specs/spec-mom/acs`;
    const emit = (acN: number, status: string, at: string, hidden = false) =>
      db.insert(testEvents).values({
        acUid: `${prefix}/ac-${acN}`,
        status,
        testIdentifier: `t-${acN}`,
        hidden,
        createdAt: new Date(at),
      });
    // ac-1: fails Jun 1, first PASSES Jun 2 (verified counts on Jun 2).
    await emit(1, "fail", "2026-06-01T10:00:00Z");
    await emit(1, "pass", "2026-06-02T10:00:00Z");
    await emit(1, "pass", "2026-06-03T10:00:00Z"); // later pass — not a new verification
    // ac-2: hidden pass only — never counts as verified, still counts as volume.
    await emit(2, "pass", "2026-06-02T11:00:00Z", true);
    // ac-3: error run — volume only.
    await emit(3, "error", "2026-06-02T12:00:00Z");

    const otRes = await app.request(`${path}/analytics/acs-over-time`, withApexHost());
    expect(otRes.status).toBe(200);
    const { points: ot } = (await otRes.json()) as {
      points: Array<{ day: string; created: number; verified: number }>;
    };
    expect(ot.find((p) => p.day === "2026-06-01")).toMatchObject({ created: 2, verified: 0 });
    expect(ot.find((p) => p.day === "2026-06-02")).toMatchObject({ created: 3, verified: 1 });
    expect(ot.at(-1)).toMatchObject({ created: 3, verified: 1 }); // hidden pass never verifies

    const volRes = await app.request(`${path}/analytics/test-run-volume`, withApexHost());
    expect(volRes.status).toBe(200);
    const { points: vol } = (await volRes.json()) as {
      points: Array<{ day: string; pass: number; fail: number; error: number }>;
    };
    expect(vol.find((p) => p.day === "2026-06-01")).toMatchObject({ pass: 0, fail: 1, error: 0 });
    // Jun 2: visible pass + hidden pass + error — hidden runs ARE volume.
    expect(vol.find((p) => p.day === "2026-06-02")).toMatchObject({ pass: 2, fail: 0, error: 1 });
    expect(vol.find((p) => p.day === "2026-06-03")).toMatchObject({ pass: 1, fail: 0, error: 0 });
  });
});

describe("GET /analytics/test-signal-pulse", () => {
  it("returns gapless minute buckets + window totals for recent test emissions", async () => {
    const m = await makeTestMemexWithDevAdmin("analyt-pulse");
    memexIds.push(m.memexId);
    const path = `/api/${m.slug}/main`;

    const prefix = `${m.slug}/main/specs/spec-pulse/acs`;
    // Emit a handful of recent events (default createdAt = now()), so they land
    // in the current minute bucket of the rolling window.
    const emitNow = (acN: number, status: string, hidden = false) =>
      db.insert(testEvents).values({
        acUid: `${prefix}/ac-${acN}`,
        status,
        testIdentifier: `t-${acN}`,
        hidden,
      });
    await emitNow(1, "pass");
    await emitNow(1, "pass");
    await emitNow(2, "fail");
    await emitNow(3, "error");
    await emitNow(4, "pass", true); // hidden pass — still counts as volume

    const res = await app.request(`${path}/analytics/test-signal-pulse?windowMinutes=15`, withApexHost());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      windowMinutes: number;
      buckets: Array<{ at: string; pass: number; fail: number; error: number }>;
      totals: { pass: number; fail: number; error: number; total: number };
    };
    expect(body.windowMinutes).toBe(15);
    expect(body.buckets).toHaveLength(15); // gapless, one per minute
    // Totals across the window: 3 pass (2 visible + 1 hidden), 1 fail, 1 error.
    expect(body.totals).toEqual({ pass: 3, fail: 1, error: 1, total: 5 });
    // The window sum of bucket columns matches the totals (no row dropped).
    const summed = body.buckets.reduce(
      (a, b) => ({ pass: a.pass + b.pass, fail: a.fail + b.fail, error: a.error + b.error }),
      { pass: 0, fail: 0, error: 0 },
    );
    expect(summed).toEqual({ pass: 3, fail: 1, error: 1 });
  });

  it("rejects a non-positive-integer windowMinutes with 400", async () => {
    const m = await makeTestMemexWithDevAdmin("analyt-pulse-bad");
    memexIds.push(m.memexId);
    const res = await app.request(
      `/api/${m.slug}/main/analytics/test-signal-pulse?windowMinutes=0`,
      withApexHost(),
    );
    expect(res.status).toBe(400);
  });
});
