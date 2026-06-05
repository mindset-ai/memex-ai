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
import { documents, memexes, namespaces } from "../db/schema.js";
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
      points: Array<{ day: string; draft: number; plan: number; build: number; verify: number; done: number }>;
    };
    const last = points.at(-1)!;
    expect(last).toMatchObject({ draft: 2, plan: 0, build: 1, verify: 0, done: 2 });
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
