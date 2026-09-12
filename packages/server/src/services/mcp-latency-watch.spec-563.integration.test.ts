// spec-563 t-6 (dec-2) — the tail watcher, exercised against seeded shapes.
//
// The decisive test is the LAST one: it replays the shape of the window this Spec was
// created by — a median that IMPROVED while the tail exploded — and asserts the watcher
// trips on it. A rule evaluated only against healthy data has not been tested, and an
// alert that would not have caught the incident it was built for is decoration.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import {
  users,
  namespaces,
  orgs,
  orgMemberships,
  memexes,
  mcpSessions,
  mcpToolCalls,
} from "../db/schema.js";
import { readLatencyTail, reportBreaches } from "./mcp-latency-watch.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-563/acs";
const TOOL = `s563_probe_${process.env.VITEST_WORKER_ID ?? "0"}`;

const created = { users: [] as string[], memexes: [] as string[], sessions: [] as string[] };
let noisyMemex: string;
let quietMemex: string;
let userId: string;

async function seedTenant(tag: string): Promise<string> {
  const sub = `s563t6${tag}-${process.env.VITEST_WORKER_ID ?? "0"}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}`.toLowerCase();
  const [ns] = await db.insert(namespaces).values({ slug: sub, kind: "org" }).returning();
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: `Test ${sub}` }).returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [mx] = await db
    .insert(memexes)
    .values({ namespaceId: ns.id, slug: "main", name: `Test ${sub}` })
    .returning();
  created.memexes.push(mx.id);
  await db.insert(orgMemberships).values({ userId, orgId: org.id, role: "administrator" });
  return mx.id;
}

/** Write N calls of the given durations under one tenant. */
async function seedCalls(memexId: string, durations: number[]) {
  const sessionId = `s563t6-${memexId}-${Math.random().toString(36).slice(2, 8)}`;
  await db.insert(mcpSessions).values({ sessionId, userId } as typeof mcpSessions.$inferInsert);
  created.sessions.push(sessionId);
  await db.insert(mcpToolCalls).values(
    durations.map((durationMs) => ({
      sessionId,
      userId,
      memexId,
      toolName: TOOL,
      argsJson: {},
      durationMs,
    })) as (typeof mcpToolCalls.$inferInsert)[],
  );
}

beforeAll(async () => {
  const sub = `s563t6u-${process.env.VITEST_WORKER_ID ?? "0"}-${Date.now().toString(36)}`;
  const [u] = await db
    .insert(users)
    .values({ email: `${sub}@memex.ai`, name: "Watch probe" } as typeof users.$inferInsert)
    .returning();
  userId = u.id;
  created.users.push(u.id);
  noisyMemex = await seedTenant("noisy");
  quietMemex = await seedTenant("quiet");
});

afterAll(async () => {
  if (created.sessions.length)
    await db.delete(mcpSessions).where(inArray(mcpSessions.sessionId, created.sessions)).catch(() => {});
  if (created.memexes.length)
    await db.delete(memexes).where(inArray(memexes.id, created.memexes)).catch(() => {});
  if (created.users.length)
    await db.delete(users).where(inArray(users.id, created.users)).catch(() => {});
});

describe("mcp latency tail watcher [spec-563 t-6]", () => {
  it("ac-9: reads per tool AND per tenant, so one noisy Memex is not diluted by healthy ones", async () => {
    tagAc(`${AC}/ac-9`);

    // The noisy tenant: a healthy body with a fat tail. The quiet one: uniformly fast.
    await seedCalls(noisyMemex, [...Array(38).fill(200), ...Array(4).fill(60_000)]);
    await seedCalls(quietMemex, Array(40).fill(180));

    const readings = await readLatencyTail({ tools: [TOOL], minCalls: 20 });

    // Vacuity guard — without both tenants present the isolation claim is untested.
    const byMemex = new Map(readings.map((r) => [r.memexId, r]));
    expect(byMemex.has(noisyMemex)).toBe(true);
    expect(byMemex.has(quietMemex)).toBe(true);

    // THE CLAIM: the tenants are distinguished. A fleet-wide percentile over these same
    // rows would be diluted — 4 slow calls in 82 — and is exactly what Cloud Run latency
    // was rejected for being.
    expect(byMemex.get(noisyMemex)!.breached).toBe(true);
    expect(byMemex.get(quietMemex)!.breached).toBe(false);
    expect(byMemex.get(quietMemex)!.slowCalls).toBe(0);
  });

  it("ac-10: a thin window is reported as nothing, not as a percentile of three calls", async () => {
    tagAc(`${AC}/ac-10`);

    const thin = await seedTenant("thin");
    await seedCalls(thin, [200, 200, 90_000]); // 1 catastrophic call out of 3

    const readings = await readLatencyTail({ tools: [TOOL], minCalls: 20 });
    // A p95 over three calls is "that call". Alerting on it teaches people to mute the
    // alert, which is how the next eleven-day window starts.
    expect(readings.find((r) => r.memexId === thin)).toBeUndefined();

    // And prove that suppression is the CALL COUNT and not the tenant being invisible:
    // drop the floor and the same rows do report.
    const unfiltered = await readLatencyTail({ tools: [TOOL], minCalls: 1 });
    expect(unfiltered.find((r) => r.memexId === thin)).toBeDefined();
  });

  it("ac-10: replaying the observed window trips it — a mean would have stayed green", async () => {
    tagAc(`${AC}/ac-10`);

    // The shape of the eleven days this Spec was created by: p50 IMPROVED (1 222 → 579 ms)
    // while p95 went 2 167 → 31 010 ms. Modelled as a fast body plus a heavy tail.
    const replay = await seedTenant("replay");
    const body = Array(95).fill(579); // the improving median
    const tail = Array(5).fill(31_010); // the tail nobody watched
    await seedCalls(replay, [...body, ...tail]);

    const readings = await readLatencyTail({ tools: [TOOL], minCalls: 20 });
    const r = readings.find((x) => x.memexId === replay);
    expect(r).toBeDefined();

    // THE POINT OF THIS ENTIRE SPEC. The mean of this window is ~2.1s and its median is
    // 579ms — BOTH look healthy, and both were watched for eleven days while a tenant
    // waited half a minute for a document.
    const mean = [...body, ...tail].reduce((a, b) => a + b, 0) / 100;
    expect(mean).toBeLessThan(10_000); // a mean-based alert: GREEN
    expect(r!.breached).toBe(true); // this watcher: BREACHED

    // ⚠ AND HERE IS WHY THE WATCHER CARRIES TWO SIGNALS RATHER THAN A PERCENTILE ALONE.
    // This fixture is exactly 5 slow calls in 100, so `percentile_disc(0.95)` lands on the
    // LAST FAST value and reports 579 ms — the p95 alone does NOT see this window. A
    // percentile is blind to a tail that is exactly its own width, and that blindness is a
    // knife edge: one more slow call and it fires, one fewer and it does not.
    expect(r!.p95Ms).toBe(579);
    // The slow-call count has no such edge. It is what actually catches this shape, and
    // the reason `breached` is an OR rather than a threshold on p95.
    expect(r!.slowCalls).toBe(5);

    // Prove the p95 arm is not dead either — widen the tail past its own width and the
    // percentile picks it up, so the OR is two live signals rather than one plus a prop.
    const wider = await seedTenant("wider");
    await seedCalls(wider, [...Array(90).fill(579), ...Array(10).fill(31_010)]);
    const widened = (await readLatencyTail({ tools: [TOOL], minCalls: 20 })).find(
      (x) => x.memexId === wider,
    );
    expect(widened!.p95Ms).toBe(31_010);
  });

  it("ac-9: what is reported carries aggregates only — never args, user, or row content", async () => {
    tagAc(`${AC}/ac-9`);

    const leaky = await seedTenant("leaky");
    await seedCalls(leaky, [...Array(30).fill(200), ...Array(3).fill(70_000)]);

    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(String(a[0]));
    });
    try {
      const readings = await readLatencyTail({ tools: [TOOL], minCalls: 20 });
      reportBreaches(readings);
    } finally {
      spy.mockRestore(); // std-37: restore global stubs
    }

    const ours = lines.filter((l) => l.includes(leaky));
    expect(ours.length).toBeGreaterThan(0);

    for (const line of ours) {
      // WHOLLY-JSON, no `[domain]` prefix: a prefixed line stays an opaque textPayload in
      // Cloud Logging and a log-based metric on field predicates matches NOTHING —
      // reporting silence, which reads as health. That is the failure this watcher
      // replaces, and it must not come back through the delivery mechanism.
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(parsed.event).toBe("mcp_latency_tail_breach");
      // Aggregates only. mcp_tool_calls also holds args_json and user_id; std-31 makes
      // this sharper than usual, since this Memex is publicly readable.
      expect(Object.keys(parsed).sort()).toEqual(
        ["calls", "event", "memexId", "p95Ms", "slowCalls", "tool"].sort(),
      );
      expect(line).not.toContain(userId);
    }
  });
});
