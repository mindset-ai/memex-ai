// spec-156 W1 — Postgres LISTEN/NOTIFY cross-instance bus relay.
//
// These are deterministic unit tests driven by in-memory fake LISTEN/NOTIFY
// drivers: two ChangeBus + PgBusRelay pairs share one fake "channel" (an
// in-memory broker), so we exercise cross-delivery, origin dedup, advisory
// write-path failure, kill-and-recover reconnect + nudge, oversize trimming,
// and read/advisory relay WITHOUT a database. The companion
// bus-relay.integration.test.ts proves the same wiring against real Postgres.

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";
import { ChangeBus, type ChangeEvent } from "./bus.js";
import {
  PgBusRelay,
  bridgePgListen,
  encodeEnvelope,
  trimEvent,
  reconnectNudge,
  type ListenCallbacks,
  type ListenDriver,
  type NotifyDriver,
} from "./bus-relay.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-156/acs/ac-${n}`;

// ── In-memory broker simulating one Postgres NOTIFY channel ─────────────────
//
// notify(payload) fans the payload out to every currently-listening driver on
// the same channel — exactly like Postgres delivering a NOTIFY to all LISTENers.
class FakeBroker {
  private listeners = new Map<string, Set<(payload: string) => void>>();

  publish(channel: string, payload: string): void {
    for (const cb of this.listeners.get(channel) ?? []) cb(payload);
  }

  addListener(channel: string, cb: (payload: string) => void): () => void {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
    }
    set.add(cb);
    return () => set!.delete(cb);
  }
}

// A LISTEN driver wired to the broker. `failNextConnect` lets a test simulate
// an initial-LISTEN failure; `drop()` simulates the connection dropping (fires
// onError, which the relay routes into its capped-backoff reconnect loop).
class FakeListenDriver implements ListenDriver {
  private remove: (() => void) | null = null;
  private onErrorCb: ((err: unknown) => void) | null = null;
  failNextConnect = false;
  listenCalls = 0;

  constructor(private broker: FakeBroker) {}

  async listen(channel: string, { onNotify, onError }: ListenCallbacks): Promise<void> {
    this.listenCalls++;
    this.onErrorCb = onError;
    if (this.failNextConnect) {
      this.failNextConnect = false;
      throw new Error("simulated LISTEN connect failure");
    }
    this.remove = this.broker.addListener(channel, onNotify);
  }

  /** Simulate the underlying connection dropping. */
  drop(err: unknown = new Error("connection dropped")): void {
    if (this.remove) {
      this.remove();
      this.remove = null;
    }
    this.onErrorCb?.(err);
  }

  async close(): Promise<void> {
    if (this.remove) {
      this.remove();
      this.remove = null;
    }
  }
}

class FakeNotifyDriver implements NotifyDriver {
  fail = false;
  sent = 0;
  constructor(private broker: FakeBroker) {}
  async notify(channel: string, payload: string): Promise<void> {
    if (this.fail) throw new Error("simulated NOTIFY failure");
    this.sent++;
    // Deliver asynchronously to mirror real NOTIFY round-trip semantics.
    queueMicrotask(() => this.broker.publish(channel, payload));
  }
}

interface Pair {
  bus: ChangeBus;
  relay: PgBusRelay;
  listen: FakeListenDriver;
  notify: FakeNotifyDriver;
}

function makePair(broker: FakeBroker, opts?: { originId?: string }): Pair {
  const bus = new ChangeBus();
  const listen = new FakeListenDriver(broker);
  const notify = new FakeNotifyDriver(broker);
  const relay = new PgBusRelay({
    bus,
    listenDriver: listen,
    notifyDriver: notify,
    originId: opts?.originId,
    // Tight backoff so reconnect tests resolve fast under fake timers.
    backoffMs: [10, 20, 40],
  });
  bus.attachRelay(relay);
  return { bus, relay, listen, notify };
}

const baseEvent = (over: Partial<ChangeEvent> = {}): ChangeEvent => ({
  memexId: "m1",
  docId: "d1",
  entity: "task",
  action: "created",
  ...over,
});

// Let queued microtasks (the fake NOTIFY round-trip) flush.
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("spec-156 W1: cross-instance delivery (ac-6)", () => {
  it("an event emitted on one bus+relay is delivered to a subscriber on a different bus+relay sharing the channel", async () => {
    tagAc(AC(6));
    const broker = new FakeBroker();
    const a = makePair(broker, { originId: "origin-A" });
    const b = makePair(broker, { originId: "origin-B" });
    await a.relay.start();
    await b.relay.start();

    const onB: ChangeEvent[] = [];
    b.bus.subscribe({}, (e) => onB.push(e));

    // Emit on A — A's subscriber sees it locally and B sees it via the relay.
    a.bus.emit(baseEvent({ docId: "cross-1" }));
    await flush();

    expect(onB).toHaveLength(1);
    expect(onB[0]).toMatchObject({ memexId: "m1", docId: "cross-1", entity: "task", action: "created" });

    await a.relay.stop();
    await b.relay.stop();
  });
});

describe("spec-156 W1: origin-tag dedup — exactly one dispatch per local emit (ac-7)", () => {
  it("the relay never re-dispatches an event into the bus that originated it", async () => {
    tagAc(AC(7));
    const broker = new FakeBroker();
    const a = makePair(broker, { originId: "origin-A" });
    await a.relay.start();

    const onA: ChangeEvent[] = [];
    a.bus.subscribe({}, (e) => onA.push(e));

    // A's own NOTIFY round-trips back to A (it listens on the same channel it
    // notifies). It must be skipped — the local emit already dispatched once.
    a.bus.emit(baseEvent({ docId: "dedup-1" }));
    await flush();

    expect(onA).toHaveLength(1);
    expect(a.relay.health().skippedOwn).toBe(1);

    await a.relay.stop();
  });

  it("a foreign event dispatches exactly once on the receiving bus", async () => {
    tagAc(AC(7));
    const broker = new FakeBroker();
    const a = makePair(broker, { originId: "origin-A" });
    const b = makePair(broker, { originId: "origin-B" });
    await a.relay.start();
    await b.relay.start();

    const onB: ChangeEvent[] = [];
    b.bus.subscribe({}, (e) => onB.push(e));

    a.bus.emit(baseEvent({ docId: "once-1" }));
    a.bus.emit(baseEvent({ docId: "once-2" }));
    await flush();

    expect(onB.map((e) => e.docId)).toEqual(["once-1", "once-2"]);
    expect(b.relay.health().received).toBe(2);

    await a.relay.stop();
    await b.relay.stop();
  });
});

describe("spec-156 W1: relay emission is advisory on the write path (ac-8)", () => {
  it("a NOTIFY failure neither blocks nor throws out of emit()/publish()", async () => {
    tagAc(AC(8));
    const broker = new FakeBroker();
    const a = makePair(broker, { originId: "origin-A" });
    await a.relay.start();
    a.notify.fail = true; // NOTIFY channel is down

    const onA: ChangeEvent[] = [];
    a.bus.subscribe({}, (e) => onA.push(e));

    // emit() must complete and dispatch locally despite the down NOTIFY.
    expect(() => a.bus.emit(baseEvent({ docId: "advisory-1" }))).not.toThrow();
    await flush();

    expect(onA).toHaveLength(1); // local dispatch still happened
    expect(a.relay.health().publishErrors).toBeGreaterThanOrEqual(1);

    await a.relay.stop();
  });

  it("publish() with the LISTEN connection never established still does not throw", async () => {
    tagAc(AC(8));
    const broker = new FakeBroker();
    const a = makePair(broker, { originId: "origin-A" });
    a.listen.failNextConnect = true;
    // start() routes the failed LISTEN into reconnect; it must not reject.
    await expect(a.relay.start()).resolves.toBeUndefined();

    expect(() => a.relay.publish(baseEvent({ docId: "advisory-2" }))).not.toThrow();
    await a.relay.stop();
  });
});

describe("spec-156 W1: kill-and-recover reconnect + nudge (ac-9)", () => {
  it("auto-reconnects with capped backoff after a drop and nudges local subscribers on re-establish", async () => {
    tagAc(AC(9));
    vi.useFakeTimers();
    try {
      const broker = new FakeBroker();
      const a = makePair(broker, { originId: "origin-A" });
      await a.relay.start();
      expect(a.relay.health().listening).toBe(true);
      expect(a.relay.health().connects).toBe(1);

      // Subscribe the way REAL SSE routes do — filtered by memexId
      // (routes/doc-events.ts) — to prove the wildcard nudge bypasses the
      // identity filter and still arrives (finding 2). The nudge's own memexId
      // is "" and would never match this filter on the ordinary path.
      const nudges: ChangeEvent[] = [];
      a.bus.subscribe({ memexId: "some-real-memex" }, (e) => {
        if (e.payload?.__relayReconnect === true) nudges.push(e);
      });

      // Kill the connection.
      a.listen.drop();
      expect(a.relay.health().listening).toBe(false);
      expect(a.relay.health().reconnects).toBeGreaterThanOrEqual(1);

      // Advance past the first backoff step — relay reconnects.
      await vi.advanceTimersByTimeAsync(15);

      expect(a.relay.health().listening).toBe(true);
      expect(a.relay.health().connects).toBe(2);
      // On re-establish it nudged local subscribers (SSE reconnect-refetch contract).
      expect(nudges).toHaveLength(1);
      expect(nudges[0].narrative).toMatch(/reconnect/i);

      await a.relay.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a self-reconnecting driver (postgres-js shape) degrades status on drop and nudges on its onReconnect signal (finding 1/3)", async () => {
    tagAc(AC(9));
    // Model postgres-js: the driver owns reconnection. listen() captures the
    // relay callbacks; the test drives onError (drop) and onReconnect (recovery)
    // directly. selfReconnects=true tells the relay NOT to run its own backoff.
    const broker = new FakeBroker();
    const bus = new ChangeBus();
    let cbs: ListenCallbacks | null = null;
    const driver: ListenDriver = {
      selfReconnects: true,
      async listen(channel, callbacks) {
        cbs = callbacks;
        broker.addListener(channel, callbacks.onNotify);
      },
      async close() {},
    };
    const relay = new PgBusRelay({
      bus,
      listenDriver: driver,
      notifyDriver: new FakeNotifyDriver(broker),
      originId: "origin-self",
    });
    bus.attachRelay(relay);
    await relay.start();
    expect(relay.health().listening).toBe(true);
    expect(relay.health().status).toBe("listening");

    const nudges: ChangeEvent[] = [];
    bus.subscribe({ memexId: "real-memex" }, (e) => {
      if (e.payload?.__relayReconnect === true) nudges.push(e);
    });

    // Drop surfaced: status must leave "listening" (finding 3).
    cbs!.onError(new Error("socket dropped"));
    expect(relay.health().listening).toBe(false);
    expect(relay.health().status).toBe("reconnecting");
    // The relay did NOT schedule its own reconnect timer (driver owns it).
    expect(relay.health().reconnects).toBe(1);

    // Recovery: postgres-js re-invokes onlisten -> onReconnect.
    cbs!.onReconnect!();
    expect(relay.health().listening).toBe(true);
    expect(relay.health().status).toBe("listening");
    expect(relay.health().connects).toBe(2);
    expect(nudges).toHaveLength(1);

    await relay.stop();
  });

  it("a self-reconnecting driver that surfaces NO drop signal still degrades+nudges on onReconnect alone (finding 1/3)", async () => {
    tagAc(AC(9));
    // The real postgres-js case: only the recovery onlisten is observable. The
    // relay must still count the reconnect and nudge.
    const broker = new FakeBroker();
    const bus = new ChangeBus();
    let cbs: ListenCallbacks | null = null;
    const driver: ListenDriver = {
      selfReconnects: true,
      async listen(channel, callbacks) {
        cbs = callbacks;
        broker.addListener(channel, callbacks.onNotify);
      },
      async close() {},
    };
    const relay = new PgBusRelay({
      bus,
      listenDriver: driver,
      notifyDriver: new FakeNotifyDriver(broker),
      originId: "origin-self2",
    });
    bus.attachRelay(relay);
    await relay.start();

    const nudges: ChangeEvent[] = [];
    bus.subscribe({ memexId: "real-memex" }, (e) => {
      if (e.payload?.__relayReconnect === true) nudges.push(e);
    });

    // No onError — straight to recovery (only signal postgres-js gives us).
    cbs!.onReconnect!();
    expect(relay.health().status).toBe("listening");
    expect(relay.health().connects).toBe(2);
    expect(relay.health().reconnects).toBe(1);
    expect(nudges).toHaveLength(1);

    await relay.stop();
  });

  it("recovers from a REJECTED initial LISTEN when postgres-js later re-establishes (issue-1: status returns to listening + nudge fires exactly once)", async () => {
    tagAc(AC(28));
    // Issue-1, observed live on prod 2026-06-04: the instance boots while the
    // DB is restarting → the initial sql.listen() REJECTS → the relay routes it
    // through onConnectionError (selfReconnects: no own backoff). postgres-js
    // keeps the listener registered internally and re-establishes it, firing
    // onlisten — but that FIRST onlisten was swallowed as "initial connect" by
    // the driver bridge, so the relay stranded at status "connecting" with
    // connects=0 and no convergence nudge, while events flowed underneath
    // (health lying about a live relay).
    //
    // Model the real postgres-js shape through bridgePgListen: rawListen
    // rejects on the first call but RETAINS the onListen callback, which the
    // test later fires to simulate the driver's internal recovery.
    const bus = new ChangeBus();
    let recoveredOnListen: (() => void) | null = null;
    const rawListen = async (
      _channel: string,
      _onNotify: (payload: string) => void,
      onListen: () => void,
    ): Promise<void> => {
      recoveredOnListen = onListen;
      throw new Error("simulated: DB restarting during boot (53300)");
    };
    const driver: ListenDriver = {
      selfReconnects: true,
      listen: bridgePgListen(rawListen),
      async close() {},
    };
    const relay = new PgBusRelay({
      bus,
      listenDriver: driver,
      notifyDriver: { notify: async () => {} },
      originId: "origin-issue-1",
    });
    bus.attachRelay(relay);

    const nudges: ChangeEvent[] = [];
    bus.subscribe({ memexId: "real-memex" }, (e) => {
      if (e.payload?.__relayReconnect === true) nudges.push(e);
    });

    // Boot: initial LISTEN rejects. Non-fatal — relay degrades, no throw.
    await relay.start();
    expect(relay.health().listening).toBe(false);
    expect(relay.health().connects).toBe(0);

    // postgres-js internally re-establishes the LISTEN and fires onlisten.
    expect(recoveredOnListen).not.toBeNull();
    recoveredOnListen!();

    // The relay must treat that recovery as a reconnect: restore "listening",
    // count the connect, and fire the convergence nudge exactly once.
    expect(relay.health().listening).toBe(true);
    expect(relay.health().status).toBe("listening");
    expect(relay.health().connects).toBe(1);
    expect(nudges).toHaveLength(1);

    // A subsequent ordinary recovery still behaves like a regular reconnect.
    recoveredOnListen!();
    expect(relay.health().status).toBe("listening");
    expect(relay.health().connects).toBe(2);
    expect(nudges).toHaveLength(2);

    await relay.stop();
  });

  it("the first connect does NOT nudge (no gap to converge)", async () => {
    tagAc(AC(9));
    const broker = new FakeBroker();
    const a = makePair(broker, { originId: "origin-A" });
    const nudges: ChangeEvent[] = [];
    a.bus.subscribe({}, (e) => {
      if (e.payload?.__relayReconnect === true) nudges.push(e);
    });
    await a.relay.start();
    expect(nudges).toHaveLength(0);
    await a.relay.stop();
  });

  it("the reconnect nudge is NOT re-published across the wire (purely local convergence signal)", async () => {
    tagAc(AC(9));
    const broker = new FakeBroker();
    const a = makePair(broker, { originId: "origin-A" });
    await a.relay.start();
    const before = a.notify.sent;
    a.relay.publish(reconnectNudge());
    expect(a.notify.sent).toBe(before); // suppressed — no NOTIFY issued
    await a.relay.stop();
  });
});

describe("spec-156 W1: oversize events relayed trimmed (ac-10)", () => {
  it("an event whose JSON exceeds 8000 bytes is relayed with narrative/payload dropped, still dispatching remote subscribers", async () => {
    tagAc(AC(10));
    const broker = new FakeBroker();
    const a = makePair(broker, { originId: "origin-A" });
    const b = makePair(broker, { originId: "origin-B" });
    await a.relay.start();
    await b.relay.start();

    const onB: ChangeEvent[] = [];
    b.bus.subscribe({}, (e) => onB.push(e));

    const huge = "x".repeat(9000);
    a.bus.emit(
      baseEvent({
        docId: "oversize-1",
        narrative: huge,
        payload: { blob: huge },
      }),
    );
    await flush();

    // Delivered (not dropped) but trimmed: routing fields survive, heavy text gone.
    expect(onB).toHaveLength(1);
    expect(onB[0]).toMatchObject({ memexId: "m1", docId: "oversize-1", entity: "task", action: "created" });
    expect(onB[0].narrative).toBeUndefined();
    expect(onB[0].payload).toBeUndefined();
    expect(a.relay.health().trimmed).toBe(1);

    await a.relay.stop();
    await b.relay.stop();
  });

  it("encodeEnvelope trims only when over budget; small events pass through whole", () => {
    tagAc(AC(10));
    const small = encodeEnvelope("o", baseEvent({ narrative: "tiny" }));
    expect(small.trimmed).toBe(false);
    expect(JSON.parse(small.payload).e.narrative).toBe("tiny");

    const big = encodeEnvelope("o", baseEvent({ narrative: "y".repeat(9000) }));
    expect(big.trimmed).toBe(true);
    expect(JSON.parse(big.payload).e.narrative).toBeUndefined();
    // Trimmed payload is comfortably under the 8000-byte NOTIFY limit.
    expect(Buffer.byteLength(big.payload, "utf8")).toBeLessThan(8000);
  });

  it("a pathological identity field (huge docId/clientId) degrades to a minimal envelope still under budget (finding 4)", () => {
    tagAc(AC(10));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // A docId so large the TRIMMED envelope (which keeps docId/clientId) is
    // still over the NOTIFY budget. The encoder must degrade further, not emit
    // an over-budget payload that NOTIFY would reject.
    const pathological = encodeEnvelope(
      "o",
      baseEvent({ docId: "x".repeat(9000), clientId: "y".repeat(9000) }),
    );
    expect(pathological.trimmed).toBe(true);
    // Guaranteed under the hard 8000-byte NOTIFY limit.
    expect(Buffer.byteLength(pathological.payload, "utf8")).toBeLessThan(8000);
    // Minimal envelope keeps routing essentials + a truncation marker; the
    // pathological docId/clientId are gone.
    const decoded = JSON.parse(pathological.payload) as { e: ChangeEvent };
    expect(decoded.e.memexId).toBe("m1");
    expect(decoded.e.entity).toBe("task");
    expect(decoded.e.action).toBe("created");
    expect(decoded.e.docId).toBeUndefined();
    expect(decoded.e.clientId).toBeUndefined();
    expect(decoded.e.payload?.__relayTruncated).toBe(true);
    // The degradation is logged (not silently swallowed).
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("caps an oversize memexId so the minimal envelope can never exceed budget (finding 4)", () => {
    tagAc(AC(10));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Even if the memexId ITSELF is pathological, the minimal envelope caps it.
    const enc = encodeEnvelope("o", baseEvent({ memexId: "z".repeat(9000), docId: "d".repeat(9000) }));
    expect(Buffer.byteLength(enc.payload, "utf8")).toBeLessThan(8000);
    errSpy.mockRestore();
  });

  it("trimEvent preserves routing/identity fields and drops only narrative/payload", () => {
    tagAc(AC(10));
    const trimmed = trimEvent(
      baseEvent({ userId: "u1", clientId: "c1", channel: "mcp", narrative: "n", payload: { a: 1 } }),
    );
    expect(trimmed).toEqual({
      memexId: "m1",
      docId: "d1",
      userId: "u1",
      clientId: "c1",
      channel: "mcp",
      entity: "task",
      action: "created",
    });
  });
});

describe("spec-156 W1: ALL bus events relayed including read/advisory (ac-11)", () => {
  it("read/advisory interactions (viewed/searched/assessed/called) cross instances", async () => {
    tagAc(AC(11));
    const broker = new FakeBroker();
    const a = makePair(broker, { originId: "origin-A" });
    const b = makePair(broker, { originId: "origin-B" });
    await a.relay.start();
    await b.relay.start();

    // Pulse-style subscriber: ?include=all (no action filter).
    const pulse: ChangeEvent[] = [];
    b.bus.subscribe({}, (e) => pulse.push(e));
    // Mutation-only stream keeps its default filter — must NOT see reads.
    const mutationsOnly: ChangeEvent[] = [];
    b.bus.subscribe({ actions: ["created", "updated", "deleted"] }, (e) => mutationsOnly.push(e));

    a.bus.emit(baseEvent({ entity: "document", action: "viewed", narrative: "viewed" }));
    a.bus.emit(baseEvent({ docId: undefined, entity: "query", action: "searched", narrative: "searched" }));
    a.bus.emit(baseEvent({ entity: "document", action: "assessed" }));
    a.bus.emit(baseEvent({ entity: "tool_call", action: "called" }));
    a.bus.emit(baseEvent({ action: "created" }));
    await flush();

    expect(pulse.map((e) => e.action)).toEqual(["viewed", "searched", "assessed", "called", "created"]);
    // The mutation-only stream still filters reads out cross-instance.
    expect(mutationsOnly.map((e) => e.action)).toEqual(["created"]);

    await a.relay.stop();
    await b.relay.stop();
  });
});

describe("spec-156 W1: health reports relay LISTEN-connection status (ac-12)", () => {
  it("health().listening flips true when listening and false when stopped/dropped", async () => {
    tagAc(AC(12));
    const broker = new FakeBroker();
    const a = makePair(broker, { originId: "origin-A" });
    expect(a.relay.health().listening).toBe(false);
    expect(a.relay.health().status).toBe("stopped");

    await a.relay.start();
    expect(a.relay.health().listening).toBe(true);
    expect(a.relay.health().status).toBe("listening");
    expect(a.relay.health().originId).toBe("origin-A");

    await a.relay.stop();
    expect(a.relay.health().listening).toBe(false);
    expect(a.relay.health().status).toBe("stopped");
  });
});

describe("spec-156 W1 (dec-3): deploy.sh keeps --max-instances 3 (ac-27)", () => {
  it("deploy.sh still pins --max-instances 3 — no interim single-instance throttle", () => {
    tagAc(AC(27));
    tagAc(AC(5)); // scope ac-5: prod runs at full scale throughout (dec-3)
    const here = dirname(fileURLToPath(import.meta.url));
    // src/services/ -> packages/server/deploy.sh
    const deployPath = join(here, "..", "..", "deploy.sh");
    const deploy = readFileSync(deployPath, "utf8");
    expect(deploy).toMatch(/--max-instances\s+3\b/);
    expect(deploy).not.toMatch(/--max-instances\s+1\b/);
  });
});
