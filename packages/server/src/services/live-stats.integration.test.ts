// Integration tests for the spec-458 live-stats aggregate (t-1).
//
// DB-backed because the load-bearing claims are about what reaches the public
// payload from real rows: the anonymized ticker projection (ac-2), the dec-3
// totals definitions (ac-11), the coalescing TTL cache (ac-16), and the
// env-tunable map window (ac-10).
//
// std-37: every assertion is a DELTA scoped to rows this file seeds (global
// aggregates can see sibling files' residue on the shared worker clone), and
// stubbed envs are restored in afterEach.

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { activityLog, mcpSessions, usageEvents, users } from "../db/schema.js";
import { makeTestMemex } from "./test-helpers.js";
import {
  getLiveStats,
  __resetLiveStatsCache,
  __liveStatsComputeCount,
  headcountFloor,
  mapWindowHours,
} from "./live-stats.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-458/acs";

const seededLogIds: string[] = [];
const seededUserIds: string[] = [];

async function seedActivity(input: {
  memexId: string;
  entity: string;
  action: string;
  actorKind?: string;
  channel?: string;
  narrative?: string;
  actorUserId?: string | null;
  createdAt?: Date;
}): Promise<void> {
  const [row] = await db
    .insert(activityLog)
    .values({
      memexId: input.memexId,
      actorUserId: input.actorUserId ?? null,
      actorKind: input.actorKind ?? "human",
      channel: input.channel ?? "rest_ui",
      entity: input.entity,
      action: input.action,
      narrative: input.narrative ?? "seed",
      createdAt: input.createdAt ?? new Date(),
    })
    .returning({ id: activityLog.id });
  seededLogIds.push(row.id);
}

async function makeUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      email: `live-stats-${process.env.VITEST_POOL_ID ?? 0}-${crypto.randomUUID()}@example.com`,
    } as typeof users.$inferInsert)
    .returning({ id: users.id });
  seededUserIds.push(user.id);
  return user.id;
}

beforeEach(() => {
  __resetLiveStatsCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  __resetLiveStatsCache();
});

afterAll(async () => {
  if (seededLogIds.length) {
    await db.delete(activityLog).where(inArray(activityLog.id, seededLogIds)).catch(() => {});
  }
  if (seededUserIds.length) {
    await db.delete(users).where(inArray(users.id, seededUserIds)).catch(() => {});
  }
});

describe("env knobs (dec-1/dec-2)", () => {
  it("defaults floor=25 and window=24h; env overrides both; junk falls back", () => {
    tagAc(`${AC}/ac-9`);
    tagAc(`${AC}/ac-10`);
    expect(headcountFloor({} as NodeJS.ProcessEnv)).toBe(25);
    expect(mapWindowHours({} as NodeJS.ProcessEnv)).toBe(24);
    expect(headcountFloor({ LIVE_HEADCOUNT_FLOOR: "10" } as NodeJS.ProcessEnv)).toBe(10);
    expect(mapWindowHours({ LIVE_MAP_WINDOW_HOURS: "1" } as NodeJS.ProcessEnv)).toBe(1);
    expect(headcountFloor({ LIVE_HEADCOUNT_FLOOR: "banana" } as NodeJS.ProcessEnv)).toBe(25);
    expect(mapWindowHours({ LIVE_MAP_WINDOW_HOURS: "-3" } as NodeJS.ProcessEnv)).toBe(24);
  });

  it("surfaces the live config in the payload so the page renders what the server enforces", async () => {
    tagAc(`${AC}/ac-9`);
    vi.stubEnv("LIVE_HEADCOUNT_FLOOR", "7");
    vi.stubEnv("LIVE_MAP_WINDOW_HOURS", "6");
    const stats = await getLiveStats();
    expect(stats.config).toEqual({ headcountFloor: 7, mapWindowHours: 6 });
  });

  it("reports humans and agents as separate counts derived from distinct sources (ac-13)", async () => {
    tagAc(`${AC}/ac-13`);
    tagAc(`${AC}/ac-5`);
    const memexId = await makeTestMemex("lvnw");
    const humanUser = await makeUser();
    const before = await getLiveStats();

    __resetLiveStatsCache();
    // A human acting right now moves ONLY the human figure — agent counting
    // keys on MCP sessions/tool calls, a disjoint source.
    await seedActivity({
      memexId,
      entity: "task",
      action: "updated",
      actorKind: "human",
      channel: "rest_ui",
      actorUserId: humanUser,
    });

    const after = await getLiveStats();
    expect(typeof after.now.humans).toBe("number");
    expect(typeof after.now.agents).toBe("number");
    // humans is MAX(activity-arm, usage-arm), so residue from sibling files can
    // absorb the +1 — the robust claims are: at least one human is now counted,
    // it never decreases, and the AGENT figure (disjoint sources) is untouched.
    expect(after.now.humans).toBeGreaterThanOrEqual(Math.max(before.now.humans, 1));
    expect(after.now.agents).toBe(before.now.agents);
  });
});

describe("anonymized ticker (ac-2)", () => {
  it("templated ticker never carries narrative content, names, or ids", async () => {
    tagAc(`${AC}/ac-2`);
    const memexId = await makeTestMemex("lvst");
    const SECRET = `SECRET-TITLE-${crypto.randomUUID()}`;
    await seedActivity({
      memexId,
      entity: "document",
      action: "created",
      actorKind: "mcp_agent",
      channel: "mcp",
      narrative: `created spec "${SECRET}"`,
    });

    const stats = await getLiveStats();
    const payload = JSON.stringify(stats);
    expect(payload).not.toContain(SECRET);
    expect(payload).not.toContain(memexId);
    // The seeded row IS represented — as the fixed template sentence.
    expect(stats.ticker.some((t) => t.text === "an agent just created a spec")).toBe(true);
    // Ticker timestamps are minute-rounded (no cadence fingerprinting).
    for (const t of stats.ticker) {
      expect(new Date(t.at).getSeconds()).toBe(0);
      expect(new Date(t.at).getMilliseconds()).toBe(0);
    }
  });
});

describe("dec-3 totals definitions (ac-11)", () => {
  it("counts decisions RESOLVED this week — resolved increments, updated does not", async () => {
    tagAc(`${AC}/ac-11`);
    const memexId = await makeTestMemex("lvst");
    const before = (await getLiveStats()).totals.decisionsResolvedThisWeek;

    __resetLiveStatsCache();
    await seedActivity({ memexId, entity: "decision", action: "resolved" });
    await seedActivity({ memexId, entity: "decision", action: "updated" });
    // Out-of-window resolved row must not count.
    await seedActivity({
      memexId,
      entity: "decision",
      action: "resolved",
      createdAt: new Date(Date.now() - 8 * 24 * 60 * 60_000),
    });

    const after = (await getLiveStats()).totals.decisionsResolvedThisWeek;
    expect(after - before).toBe(1);
  });

  it("counts specs created this week (entity=document, action=created)", async () => {
    tagAc(`${AC}/ac-11`);
    const memexId = await makeTestMemex("lvst");
    const before = (await getLiveStats()).totals.specsCreatedThisWeek;

    __resetLiveStatsCache();
    await seedActivity({ memexId, entity: "document", action: "created" });
    await seedActivity({ memexId, entity: "document", action: "updated" });

    const after = (await getLiveStats()).totals.specsCreatedThisWeek;
    expect(after - before).toBe(1);
  });
});

describe("TTL cache with coalesced misses (ac-16)", () => {
  it("parallel requests inside one TTL window trigger exactly one compute", async () => {
    tagAc(`${AC}/ac-16`);
    const before = __liveStatsComputeCount();
    const results = await Promise.all([getLiveStats(), getLiveStats(), getLiveStats()]);
    expect(__liveStatsComputeCount() - before).toBe(1);
    // Coalesced callers share the identical payload object.
    expect(results[0]).toBe(results[1]);
    expect(results[1]).toBe(results[2]);
    // A follow-up hit inside the TTL is served from cache — still one compute.
    await getLiveStats();
    expect(__liveStatsComputeCount() - before).toBe(1);
  });
});

describe("ac-6 exclusions — seed noise + staff tenants", () => {
  it("channel='server' rows (the seed burst) reach no counter, ticker entry, or dot", async () => {
    tagAc(`${AC}/ac-6`);
    const memexId = await makeTestMemex("lvex");
    const userId = await makeUser();
    const before = await getLiveStats();

    __resetLiveStatsCache();
    // The exact shape the handhold-demo/default-standards seeders write
    // (spec-406 ac-26: RequestCtx{channel:'server'}).
    await seedActivity({
      memexId,
      entity: "document",
      action: "created",
      actorKind: "system",
      channel: "server",
      actorUserId: userId,
    });
    await seedActivity({
      memexId,
      entity: "ac",
      action: "created",
      actorKind: "human",
      channel: "server",
      actorUserId: userId,
    });

    const after = await getLiveStats();
    expect(after.totals.specsCreatedThisWeek).toBe(before.totals.specsCreatedThisWeek);
    expect(after.totals.acsCreatedThisWeek).toBe(before.totals.acsCreatedThisWeek);
    expect(after.totals.eventsToday).toBe(before.totals.eventsToday);
    expect(after.lastHour.events).toBe(before.lastHour.events);
  });

  it("LIVE_EXCLUDED_MEMEX_IDS drops a staff tenant's activity from every aggregate", async () => {
    tagAc(`${AC}/ac-6`);
    const staffMemex = await makeTestMemex("lvex");
    const userId = await makeUser();

    vi.stubEnv("LIVE_EXCLUDED_MEMEX_IDS", ` ${staffMemex} , 00000000-0000-0000-0000-000000000000 `);
    const before = await getLiveStats();

    __resetLiveStatsCache();
    await seedActivity({
      memexId: staffMemex,
      entity: "decision",
      action: "resolved",
      actorUserId: userId,
    });

    const after = await getLiveStats();
    expect(after.totals.decisionsResolvedThisWeek).toBe(before.totals.decisionsResolvedThisWeek);
    expect(after.totals.eventsToday).toBe(before.totals.eventsToday);

    // Un-exclude → the same row counts (proves the filter, not a fluke).
    __resetLiveStatsCache();
    vi.stubEnv("LIVE_EXCLUDED_MEMEX_IDS", "");
    const unfiltered = await getLiveStats();
    expect(unfiltered.totals.decisionsResolvedThisWeek).toBe(
      before.totals.decisionsResolvedThisWeek + 1,
    );
  });
});

describe("real LB-derived geo takes over from dev-synth (ac-15, ac-19)", () => {
  const seededSessionIds: string[] = [];
  const seededEventIds: string[] = [];

  afterAll(async () => {
    if (seededSessionIds.length) {
      await db
        .delete(mcpSessions)
        .where(inArray(mcpSessions.sessionId, seededSessionIds))
        .catch(() => {});
    }
    if (seededEventIds.length) {
      await db.delete(usageEvents).where(inArray(usageEvents.id, seededEventIds)).catch(() => {});
    }
  });

  it("emits jittered city-blob points from stored rounded coords, per actor+kind, no ids", async () => {
    tagAc(`${AC}/ac-15`);
    tagAc(`${AC}/ac-19`);
    const agentUser = await makeUser();
    const humanUser = await makeUser();

    // Agent: an MCP session with LB-derived (already rounded) coords — plus a
    // SECOND session for the same user, which must dedupe to one dot (ac-19).
    for (const suffix of ["a", "b"]) {
      const sessionId = `live-geo-${process.env.VITEST_POOL_ID ?? 0}-${crypto.randomUUID()}-${suffix}`;
      seededSessionIds.push(sessionId);
      await db.insert(mcpSessions).values({
        sessionId,
        userId: agentUser,
        geoLat: 51.5,
        geoLng: -0.1,
      });
    }
    // Human: a located usage event.
    const [ev] = await db
      .insert(usageEvents)
      .values({
        memexId: null,
        actorUserId: humanUser,
        name: "nav.route_changed",
        source: "frontend",
        env: "test",
        geoLat: 40.7,
        geoLng: -74,
      })
      .returning({ id: usageEvents.id });
    seededEventIds.push(ev.id);

    const stats = await getLiveStats();
    expect(stats.geoSource).toBe("header");

    const agentDots = stats.points.filter(
      (p) => p.kind === "agent" && Math.abs(p.lat - 51.5) <= 0.2 && Math.abs(p.lng - -0.1) <= 0.2,
    );
    const humanDots = stats.points.filter(
      (p) => p.kind === "human" && Math.abs(p.lat - 40.7) <= 0.2 && Math.abs(p.lng - -74) <= 0.2,
    );
    // Exactly ONE agent dot despite two sessions (deduped per actor+kind)...
    expect(agentDots.length).toBe(1);
    expect(humanDots.length).toBe(1);
    // ...jittered off the stored value (read-side jitter is non-zero by construction)
    expect(agentDots[0].lat).not.toBe(51.5);
    // ...and carrying nothing but the four public fields.
    expect(Object.keys(agentDots[0]).sort()).toEqual(["kind", "lat", "lng", "weight"]);
    expect(JSON.stringify(stats)).not.toContain(agentUser);
  });
});

describe("map window honours LIVE_MAP_WINDOW_HOURS (ac-10, ac-19)", () => {
  it("an actor active 2h ago maps a dot at window=24 but not at window=1", async () => {
    tagAc(`${AC}/ac-10`);
    tagAc(`${AC}/ac-19`);
    const memexId = await makeTestMemex("lvst");
    const userId = await makeUser();
    await seedActivity({
      memexId,
      entity: "task",
      action: "updated",
      actorKind: "mcp_agent",
      channel: "mcp",
      actorUserId: userId,
      createdAt: new Date(Date.now() - 2 * 60 * 60_000),
    });

    vi.stubEnv("LIVE_MAP_WINDOW_HOURS", "24");
    const wide = await getLiveStats();
    // Dev-synth under test env unless a sibling test seeded real geo rows.
    expect(["demo", "header"]).toContain(wide.geoSource);
    const dotCountWide = wide.points.length;

    __resetLiveStatsCache();
    vi.stubEnv("LIVE_MAP_WINDOW_HOURS", "1");
    const narrow = await getLiveStats();
    expect(dotCountWide).toBeGreaterThan(narrow.points.length);
    // Weights are 0..1 recency, never leaking raw ages or ids.
    for (const p of wide.points) {
      expect(p.weight).toBeGreaterThan(0);
      expect(p.weight).toBeLessThanOrEqual(1);
      expect(Object.keys(p).sort()).toEqual(["kind", "lat", "lng", "weight"]);
    }
  });
});
