import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  bus,
  isRelayReconnect,
  RELAY_RECONNECT_MARKER,
  type ChangeEvent,
} from "./bus.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-156/acs/ac-${n}`;

beforeEach(() => {
  bus._reset();
});

afterEach(() => {
  bus._reset();
});

describe("bus pub/sub fan-out", () => {
  it("delivers an event to every matching subscriber", () => {
    const received: ChangeEvent[][] = [[], [], []];
    const unsubs = [
      bus.subscribe({}, (e) => received[0].push(e)),
      bus.subscribe({}, (e) => received[1].push(e)),
      bus.subscribe({}, (e) => received[2].push(e)),
    ];
    bus.emit({ memexId: "m1", docId: "d1", entity: "task", action: "created" });
    expect(received[0]).toHaveLength(1);
    expect(received[1]).toHaveLength(1);
    expect(received[2]).toHaveLength(1);
    unsubs.forEach((u) => u());
  });

  it("delivers events in subscribe order to all listeners", () => {
    const order: number[] = [];
    bus.subscribe({}, () => order.push(1));
    bus.subscribe({}, () => order.push(2));
    bus.subscribe({}, () => order.push(3));
    bus.emit({ memexId: "m1", docId: "d1", entity: "task", action: "created" });
    expect(order).toEqual([1, 2, 3]);
  });
});

describe("bus filter correctness", () => {
  it("filters by memexId", () => {
    const received: ChangeEvent[] = [];
    bus.subscribe({ memexId: "m1" }, (e) => received.push(e));
    bus.emit({ memexId: "m1", docId: "d1", entity: "task", action: "created" });
    bus.emit({ memexId: "m2", docId: "d2", entity: "task", action: "created" });
    expect(received).toHaveLength(1);
    expect(received[0].memexId).toBe("m1");
  });

  it("filters by entity", () => {
    const received: ChangeEvent[] = [];
    bus.subscribe({ entity: "task" }, (e) => received.push(e));
    bus.emit({ memexId: "m1", docId: "d1", entity: "task", action: "created" });
    bus.emit({ memexId: "m1", docId: "d1", entity: "decision", action: "created" });
    bus.emit({ memexId: "m1", docId: "d1", entity: "task", action: "updated" });
    expect(received).toHaveLength(2);
    expect(received.every((e) => e.entity === "task")).toBe(true);
  });

  it("filters by docId", () => {
    const received: ChangeEvent[] = [];
    bus.subscribe({ docId: "d1" }, (e) => received.push(e));
    bus.emit({ memexId: "m1", docId: "d1", entity: "task", action: "created" });
    bus.emit({ memexId: "m1", docId: "d2", entity: "task", action: "created" });
    expect(received).toHaveLength(1);
    expect(received[0].docId).toBe("d1");
  });

  it("filters by combined memexId + entity + docId", () => {
    const received: ChangeEvent[] = [];
    bus.subscribe({ memexId: "m1", entity: "decision", docId: "d1" }, (e) => received.push(e));
    // misses on docId
    bus.emit({ memexId: "m1", docId: "d2", entity: "decision", action: "created" });
    // misses on entity
    bus.emit({ memexId: "m1", docId: "d1", entity: "task", action: "created" });
    // misses on memexId
    bus.emit({ memexId: "m2", docId: "d1", entity: "decision", action: "created" });
    // matches all three
    bus.emit({ memexId: "m1", docId: "d1", entity: "decision", action: "updated" });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ memexId: "m1", docId: "d1", entity: "decision", action: "updated" });
  });

  it("subscribers with non-doc-tree entities (no docId) match when filter has no docId constraint", () => {
    const received: ChangeEvent[] = [];
    bus.subscribe({ entity: "org_membership" }, (e) => received.push(e));
    bus.emit({ memexId: "m1", entity: "org_membership", action: "created" });
    expect(received).toHaveLength(1);
  });
});

describe("bus pulse actions + fields (b-60)", () => {
  it("emits and delivers events carrying the new read actions and fields", () => {
    const received: ChangeEvent[] = [];
    bus.subscribe({}, (e) => received.push(e));
    bus.emit({
      memexId: "m1",
      docId: "d1",
      entity: "document",
      action: "viewed",
      narrative: "Alice viewed the Spec",
      clientId: "conn-7",
      channel: "rest_ui",
      payload: { foo: "bar" },
    });
    bus.emit({
      memexId: "m1",
      entity: "query",
      action: "searched",
      narrative: "Searched for 'auth flow'",
      channel: "mcp",
      payload: { query: "auth flow" },
    });
    bus.emit({ memexId: "m1", entity: "tool_call", action: "called", channel: "in_app_agent" });
    bus.emit({ memexId: "m1", docId: "d1", entity: "document", action: "assessed", channel: "server" });
    expect(received).toHaveLength(4);
    expect(received[0]).toMatchObject({
      action: "viewed",
      narrative: "Alice viewed the Spec",
      clientId: "conn-7",
      channel: "rest_ui",
      payload: { foo: "bar" },
    });
    expect(received[1]).toMatchObject({ entity: "query", action: "searched", channel: "mcp" });
    expect(received[2]).toMatchObject({ entity: "tool_call", action: "called" });
    expect(received[3].action).toBe("assessed");
  });
});

describe("bus action-allowlist filter (b-60)", () => {
  it("delivers only events whose action is in the allowlist", () => {
    const received: ChangeEvent[] = [];
    bus.subscribe({ actions: ["viewed", "searched"] }, (e) => received.push(e));
    bus.emit({ memexId: "m1", docId: "d1", entity: "document", action: "viewed" });
    bus.emit({ memexId: "m1", entity: "query", action: "searched" });
    // excluded by allowlist
    bus.emit({ memexId: "m1", docId: "d1", entity: "task", action: "created" });
    bus.emit({ memexId: "m1", docId: "d1", entity: "task", action: "updated" });
    bus.emit({ memexId: "m1", entity: "tool_call", action: "called" });
    expect(received.map((e) => e.action)).toEqual(["viewed", "searched"]);
  });

  it("combines the action allowlist with other filters", () => {
    const received: ChangeEvent[] = [];
    bus.subscribe({ memexId: "m1", actions: ["created"] }, (e) => received.push(e));
    // right action, wrong memex
    bus.emit({ memexId: "m2", docId: "d1", entity: "task", action: "created" });
    // right memex, wrong action
    bus.emit({ memexId: "m1", docId: "d1", entity: "task", action: "updated" });
    // matches both
    bus.emit({ memexId: "m1", docId: "d1", entity: "task", action: "created" });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ memexId: "m1", action: "created" });
  });

  it("treats an empty allowlist as default-open (no filtering)", () => {
    const received: ChangeEvent[] = [];
    bus.subscribe({ actions: [] }, (e) => received.push(e));
    bus.emit({ memexId: "m1", docId: "d1", entity: "task", action: "created" });
    bus.emit({ memexId: "m1", docId: "d1", entity: "document", action: "viewed" });
    expect(received).toHaveLength(2);
  });

  it("a subscriber with no allowlist still receives every action (existing-consumer regression guard)", () => {
    const received: ChangeEvent[] = [];
    bus.subscribe({}, (e) => received.push(e));
    bus.emit({ memexId: "m1", docId: "d1", entity: "task", action: "created" });
    bus.emit({ memexId: "m1", docId: "d1", entity: "task", action: "updated" });
    bus.emit({ memexId: "m1", docId: "d1", entity: "task", action: "deleted" });
    bus.emit({ memexId: "m1", docId: "d1", entity: "document", action: "viewed" });
    bus.emit({ memexId: "m1", entity: "query", action: "searched" });
    bus.emit({ memexId: "m1", docId: "d1", entity: "document", action: "assessed" });
    bus.emit({ memexId: "m1", entity: "tool_call", action: "called" });
    expect(received).toHaveLength(7);
    expect(received.map((e) => e.action)).toEqual([
      "created",
      "updated",
      "deleted",
      "viewed",
      "searched",
      "assessed",
      "called",
    ]);
  });
});

describe("localOnly subscribers — single-writer persistence sinks (spec-122)", () => {
  it("a localOnly subscriber receives local emit() but NOT relayed emitRelayed()", () => {
    tagAc(AC(6));
    const local: ChangeEvent[] = [];
    const both: ChangeEvent[] = [];
    // The persistence sink: localOnly.
    bus.subscribe({}, (e) => local.push(e), { localOnly: true });
    // A live-delivery subscriber (SSE-style): default — sees relayed events too.
    bus.subscribe({}, (e) => both.push(e));

    // Foreign event fanned in from another instance via the relay.
    bus.emitRelayed({ memexId: "m1", entity: "task", action: "created" });
    // Locally-originated emit.
    bus.emit({ memexId: "m1", entity: "task", action: "updated" });

    // The localOnly sink saw ONLY the local emit — never the relayed one. This is
    // what keeps activity_log single-writer across the 3 Cloud Run instances the
    // spec-156 relay fans out to (the "duplicated 3×" Pulse report).
    expect(local.map((e) => e.action)).toEqual(["updated"]);
    // The live-delivery subscriber saw both — cross-instance delivery intact.
    expect(both.map((e) => e.action)).toEqual(["created", "updated"]);
  });

  it("unsubscribing a localOnly subscriber stops further local delivery", () => {
    const seen: ChangeEvent[] = [];
    const unsub = bus.subscribe({}, (e) => seen.push(e), { localOnly: true });
    bus.emit({ memexId: "m1", entity: "task", action: "created" });
    expect(seen).toHaveLength(1);
    unsub();
    bus.emit({ memexId: "m1", entity: "task", action: "updated" });
    expect(seen).toHaveLength(1);
  });
});

describe("bus subscriber cleanup", () => {
  it("returned unsubscribe removes the listener", () => {
    const received: ChangeEvent[] = [];
    const unsubscribe = bus.subscribe({}, (e) => received.push(e));
    bus.emit({ memexId: "m1", docId: "d1", entity: "task", action: "created" });
    expect(received).toHaveLength(1);
    unsubscribe();
    bus.emit({ memexId: "m1", docId: "d1", entity: "task", action: "updated" });
    expect(received).toHaveLength(1);
    expect(bus._listenerCount()).toBe(0);
  });

  it("does not leak listeners across many subscribe/unsubscribe cycles", () => {
    expect(bus._listenerCount()).toBe(0);
    for (let i = 0; i < 500; i++) {
      const u = bus.subscribe({}, () => {});
      u();
    }
    expect(bus._listenerCount()).toBe(0);
  });

  it("a listener that unsubscribes itself during dispatch does not affect other listeners", () => {
    const received1: ChangeEvent[] = [];
    const received2: ChangeEvent[] = [];
    let unsub1: (() => void) | null = null;
    unsub1 = bus.subscribe({}, (e) => {
      received1.push(e);
      unsub1?.();
    });
    bus.subscribe({}, (e) => received2.push(e));
    bus.emit({ memexId: "m1", docId: "d1", entity: "task", action: "created" });
    bus.emit({ memexId: "m1", docId: "d1", entity: "task", action: "updated" });
    expect(received1).toHaveLength(1);
    expect(received2).toHaveLength(2);
  });
});

describe("bus error isolation", () => {
  it("a throwing subscriber does not stop other subscribers from receiving the event", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const received: ChangeEvent[] = [];
    bus.subscribe({}, () => {
      throw new Error("boom");
    });
    bus.subscribe({}, (e) => received.push(e));
    bus.emit({ memexId: "m1", docId: "d1", entity: "task", action: "created" });
    expect(received).toHaveLength(1);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("a throwing subscriber does not poison subsequent emits", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const received: ChangeEvent[] = [];
    bus.subscribe({}, () => {
      throw new Error("boom");
    });
    bus.subscribe({}, (e) => received.push(e));
    bus.emit({ memexId: "m1", docId: "d1", entity: "task", action: "created" });
    bus.emit({ memexId: "m1", docId: "d1", entity: "task", action: "updated" });
    bus.emit({ memexId: "m1", docId: "d1", entity: "task", action: "deleted" });
    expect(received).toHaveLength(3);
    errSpy.mockRestore();
  });
});

describe("spec-156 W1: relay reconnect nudge is a wildcard that bypasses identity filters (ac-9)", () => {
  // The nudge carries memexId:"" and no userId/docId. Every real SSE stream
  // filters by memexId (routes/doc-events.ts) or userId (routes/me.ts), so an
  // ordinary event with those empty values would reach NOBODY. The reserved
  // marker makes the bus filter bypass memexId/userId/docId for the nudge so it
  // reaches every live subscriber and converges gaps after a relay reconnect.
  const nudge = (over: Partial<ChangeEvent> = {}): ChangeEvent => ({
    memexId: "",
    entity: "memex",
    action: "updated",
    payload: { [RELAY_RECONNECT_MARKER]: true },
    ...over,
  });

  it("reaches a per-memex subscriber (the doc-events SSE filter shape)", () => {
    tagAc(AC(9));
    const received: ChangeEvent[] = [];
    bus.subscribe({ memexId: "real-memex" }, (e) => received.push(e));
    bus.emit(nudge());
    expect(received).toHaveLength(1);
    expect(isRelayReconnect(received[0])).toBe(true);
  });

  it("reaches a per-user subscriber (the /api/me/events SSE filter shape)", () => {
    tagAc(AC(9));
    const received: ChangeEvent[] = [];
    // me.ts defaults to mutation-only actions; the nudge's action is "updated"
    // so it passes the allowlist AND bypasses the userId identity filter.
    bus.subscribe(
      { userId: "real-user", actions: ["created", "updated", "deleted"] },
      (e) => received.push(e),
    );
    bus.emit(nudge());
    expect(received).toHaveLength(1);
  });

  it("reaches a per-doc subscriber whose docId would never match the nudge", () => {
    tagAc(AC(9));
    const received: ChangeEvent[] = [];
    bus.subscribe({ memexId: "real-memex", docId: "real-doc" }, (e) => received.push(e));
    bus.emit(nudge());
    expect(received).toHaveLength(1);
  });

  it("still honours the actions allowlist — a read-only stream does NOT see the 'updated' nudge", () => {
    tagAc(AC(9));
    const received: ChangeEvent[] = [];
    bus.subscribe({ memexId: "real-memex", actions: ["viewed"] }, (e) => received.push(e));
    bus.emit(nudge());
    expect(received).toHaveLength(0);
  });

  it("an ordinary event with no marker is NOT treated as a wildcard", () => {
    tagAc(AC(9));
    const received: ChangeEvent[] = [];
    bus.subscribe({ memexId: "real-memex" }, (e) => received.push(e));
    // Same empty/foreign memexId, but NO reconnect marker → ordinary filtering.
    bus.emit({ memexId: "other-memex", entity: "memex", action: "updated" });
    expect(received).toHaveLength(0);
  });
});
