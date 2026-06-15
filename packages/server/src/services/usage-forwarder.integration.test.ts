// Integration tests for the outbox forwarder (spec-244 t-5 / dec-3) — REAL
// Postgres + a FakeSink (no network). Proves the pluggable interface, at-least-once
// delivery via the forwarded_at cursor, and no double-send.

import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { usageEvents } from "../db/schema.js";
import type { UsageEvent } from "../db/schema.js";
import { makeTestMemex } from "./test-helpers.js";
import { upsertUserByEmail } from "./users.js";
import { recordUsageEvent } from "./usage-events.js";
import type { AnalyticsSink } from "./analytics-sink.js";
import {
  drainOnce,
  configuredSink,
  startUsageForwarder,
  stopUsageForwarder,
} from "./usage-forwarder.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-244/acs";
const AC297 = "mindset-prod/memex-building-itself/specs/spec-297/acs";

let memexId: string;
let userId: string;

// A test double for the pluggable interface — proves a self-hoster can swap sinks.
class FakeSink implements AnalyticsSink {
  readonly name = "fake";
  readonly received: UsageEvent[] = [];
  failNext = false;
  async send(events: readonly UsageEvent[]): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("sink down");
    }
    this.received.push(...events);
  }
  mine(): UsageEvent[] {
    return this.received.filter((e) => e.memexId === memexId);
  }
}

beforeAll(async () => {
  memexId = await makeTestMemex("fwd");
  const u = await upsertUserByEmail(`fwd-${Date.now()}@memex.ai`);
  userId = u.id;
});

afterEach(async () => {
  await db.delete(usageEvents).where(eq(usageEvents.memexId, memexId));
});

afterAll(async () => {
  await db.delete(usageEvents).where(eq(usageEvents.memexId, memexId));
});

async function seed(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await recordUsageEvent({
      memexId,
      actorUserId: userId,
      name: "cta.clicked",
      source: "frontend",
      props: { i },
    });
  }
}

async function myRows(): Promise<UsageEvent[]> {
  return db.select().from(usageEvents).where(eq(usageEvents.memexId, memexId));
}

describe("configuredSink — Mixpanel default, capture-only when unset (ac-2 / ac-4)", () => {
  it("returns null with no token (forwarding off) and a Mixpanel sink with one", () => {
    tagAc(`${AC}/ac-2`);
    tagAc(`${AC}/ac-4`);
    expect(configuredSink({} as NodeJS.ProcessEnv)).toBeNull();
    const sink = configuredSink({ MIXPANEL_TOKEN: "tok" } as NodeJS.ProcessEnv);
    expect(sink?.name).toBe("mixpanel");
  });
});

describe("self-hosted instances never forward to Mindset's Mixpanel (spec-297 dec-5)", () => {
  it("no MIXPANEL_TOKEN → configuredSink null → forwarder capture-only, zero outbound /track (ac-21, ac-5)", async () => {
    tagAc(`${AC297}/ac-21`);
    tagAc(`${AC297}/ac-5`);
    const fetchSpy = vi.fn(async () => new Response("1", { status: 200 }));

    // The token is the SOLE gate (no hardcoded token, no phone-home default):
    // absent or blank → no sink is constructed at all, so nothing can call fetch.
    expect(
      configuredSink({} as NodeJS.ProcessEnv, fetchSpy as unknown as typeof fetch),
    ).toBeNull();
    expect(
      configuredSink({ MIXPANEL_TOKEN: "   " } as NodeJS.ProcessEnv, fetchSpy as unknown as typeof fetch),
    ).toBeNull();

    // With captured rows queued, starting the forwarder in the self-hosted config
    // forwards nothing and never touches the network — capture-only.
    await seed(3);
    try {
      startUsageForwarder({
        sink: configuredSink({} as NodeJS.ProcessEnv, fetchSpy as unknown as typeof fetch),
        intervalMs: 10,
      });
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      stopUsageForwarder();
    }
    expect(fetchSpy, "a tokenless instance must make zero outbound /track calls").not.toHaveBeenCalled();
    // ...yet the rows are still captured locally (undrained) — capture without forward.
    expect((await myRows()).every((r) => r.forwardedAt === null)).toBe(true);
  });
});

describe("drainOnce — DB-as-outbox, pluggable sink (ac-4 / ac-14)", () => {
  it("forwards undrained rows to the sink and stamps forwarded_at, never re-sending", async () => {
    tagAc(`${AC}/ac-4`);
    tagAc(`${AC}/ac-14`);
    tagAc(`${AC}/ac-15`); // dec-4: every captured row forwarded one-to-one, no per-event flag
    await seed(3);
    const sink = new FakeSink();

    await drainOnce(sink, 200, db);
    expect(sink.mine()).toHaveLength(3);
    // Every one of my rows is now stamped (outbox cursor advanced).
    expect((await myRows()).every((r) => r.forwardedAt !== null)).toBe(true);

    // Second drain ships nothing of mine — no double-send.
    await drainOnce(sink, 200, db);
    expect(sink.mine()).toHaveLength(3);
  });
});

describe("at-least-once — a failed send is retried, not lost (ac-6)", () => {
  it("leaves forwarded_at unset when the sink throws, then ships on the next drain", async () => {
    tagAc(`${AC}/ac-6`);
    await seed(2);
    const sink = new FakeSink();
    sink.failNext = true;

    await expect(drainOnce(sink, 200, db)).rejects.toThrow(/sink down/);
    // Nothing stamped — the batch survives for a retry (outbox intact).
    expect((await myRows()).every((r) => r.forwardedAt === null)).toBe(true);

    // Next drain (sink healthy) delivers them.
    await drainOnce(sink, 200, db);
    expect(sink.mine()).toHaveLength(2);
    expect((await myRows()).every((r) => r.forwardedAt !== null)).toBe(true);
  });
});
