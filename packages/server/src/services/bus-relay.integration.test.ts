// spec-156 W1 — cross-instance bus relay, proven against REAL Postgres.
//
// Two independent ChangeBus + PgBusRelay pairs run against the one local
// Postgres (the prod topology: distinct Cloud Run instances, one database).
// Each pair opens its OWN dedicated LISTEN connection (createPgListenDriver,
// max:1) and NOTIFYs over its own pooled client. We assert true cross-delivery,
// origin dedup, and read/advisory relay over the wire — the property the
// in-memory bus-relay.test.ts fakes.
//
// Isolation from other agents working the same DB: each test uses a UNIQUE
// NOTIFY channel (random suffix), so no other relay on the standard 'memex_bus'
// channel can deliver into these buses and perturb the counts.

import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { tagAc } from "@memex-ai-ac/vitest";
import { ChangeBus, type ChangeEvent } from "./bus.js";
import {
  PgBusRelay,
  createPgListenDriver,
  createPgNotifyDriver,
} from "./bus-relay.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-156/acs/ac-${n}`;

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/memex";

interface Pair {
  bus: ChangeBus;
  relay: PgBusRelay;
  notifySql: postgres.Sql;
}

const teardown: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of teardown.splice(0).reverse()) {
    try {
      await fn();
    } catch {
      /* best-effort cleanup */
    }
  }
});

async function makePair(channel: string, originId: string): Promise<Pair> {
  const bus = new ChangeBus();
  // Dedicated NOTIFY client (mirrors the pooled client in prod; here a small
  // pool of its own so the test stays self-contained).
  const notifySql = postgres(DATABASE_URL, { max: 2 });
  const relay = new PgBusRelay({
    bus,
    listenDriver: createPgListenDriver({ connectionString: DATABASE_URL }),
    notifyDriver: createPgNotifyDriver(notifySql),
    channel,
    originId,
  });
  bus.attachRelay(relay);
  await relay.start();
  teardown.push(async () => {
    await relay.stop();
    await notifySql.end({ timeout: 5 });
  });
  return { bus, relay, notifySql };
}

// Wait until `cond` holds or a deadline passes — LISTEN/NOTIFY delivery is async.
async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond() && Date.now() - start < ms) {
    await new Promise((r) => setTimeout(r, 20));
  }
}

const baseEvent = (over: Partial<ChangeEvent> = {}): ChangeEvent => ({
  memexId: "spec156-relay",
  docId: "d1",
  entity: "task",
  action: "created",
  ...over,
});

describe("spec-156 W1 integration: real Postgres LISTEN/NOTIFY relay", () => {
  it("delivers an event emitted on instance A to a subscriber on instance B (ac-6)", async () => {
    tagAc(AC(6));
    // Scope ac-1: the cross-channel/cross-instance reflection guarantee — this
    // two-real-relay-instances-over-one-Postgres test is its broadest local proof.
    tagAc(AC(1));
    const channel = `memex_bus_test_${randomUUID().replace(/-/g, "")}`;
    const a = await makePair(channel, "origin-A");
    const b = await makePair(channel, "origin-B");

    const onB: ChangeEvent[] = [];
    b.bus.subscribe({}, (e) => onB.push(e));

    const marker = randomUUID();
    a.bus.emit(baseEvent({ docId: marker }));

    await waitFor(() => onB.some((e) => e.docId === marker));
    const got = onB.find((e) => e.docId === marker);
    expect(got).toBeDefined();
    expect(got).toMatchObject({ memexId: "spec156-relay", entity: "task", action: "created" });
  });

  it("does not re-dispatch an event into the origin bus — exactly one local dispatch (ac-7)", async () => {
    tagAc(AC(7));
    const channel = `memex_bus_test_${randomUUID().replace(/-/g, "")}`;
    const a = await makePair(channel, "origin-A");

    const onA: ChangeEvent[] = [];
    const marker = randomUUID();
    a.bus.subscribe({}, (e) => {
      if (e.docId === marker) onA.push(e);
    });

    a.bus.emit(baseEvent({ docId: marker }));

    // Wait long enough that the self-NOTIFY would have round-tripped if it were
    // going to double-deliver, then assert exactly one dispatch + a skip.
    await waitFor(() => a.relay.health().skippedOwn >= 1);
    await new Promise((r) => setTimeout(r, 100));

    expect(onA).toHaveLength(1);
    expect(a.relay.health().skippedOwn).toBeGreaterThanOrEqual(1);
  });

  it("relays read/advisory events (viewed/searched/assessed/called) cross-instance for Pulse (ac-11)", async () => {
    tagAc(AC(11));
    const channel = `memex_bus_test_${randomUUID().replace(/-/g, "")}`;
    const a = await makePair(channel, "origin-A");
    const b = await makePair(channel, "origin-B");

    const run = randomUUID();
    const pulse: ChangeEvent[] = [];
    b.bus.subscribe({}, (e) => {
      if (e.clientId === run) pulse.push(e);
    });
    const mutationsOnly: ChangeEvent[] = [];
    b.bus.subscribe({ actions: ["created", "updated", "deleted"] }, (e) => {
      if (e.clientId === run) mutationsOnly.push(e);
    });

    a.bus.emit(baseEvent({ entity: "document", action: "viewed", clientId: run, narrative: "v" }));
    a.bus.emit(baseEvent({ docId: undefined, entity: "query", action: "searched", clientId: run, narrative: "s" }));
    a.bus.emit(baseEvent({ entity: "document", action: "assessed", clientId: run }));
    a.bus.emit(baseEvent({ entity: "tool_call", action: "called", clientId: run }));
    a.bus.emit(baseEvent({ action: "created", clientId: run }));

    await waitFor(() => pulse.length >= 5);

    expect(pulse.map((e) => e.action).sort()).toEqual(
      ["assessed", "called", "created", "searched", "viewed"].sort(),
    );
    // Mutation-only stream filters reads out, cross-instance.
    expect(mutationsOnly.map((e) => e.action)).toEqual(["created"]);
  });
});
