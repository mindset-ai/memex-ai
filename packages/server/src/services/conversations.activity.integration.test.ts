import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { bus, type ChangeEvent } from "./bus.js";
import { emitInAppAgentActivity } from "./conversations.js";

// Pulse (b-60 t-6) — in-app agent read/call activity emission.
//
// These are DB-free: by omitting `docId` the helper skips the conversation-id
// lookup, so we can assert the bus contract without a database. The helper
// detaches its work on a microtask, so each test awaits a microtask flush
// (`await Promise.resolve()`) before asserting.

beforeEach(() => bus._reset());
afterEach(() => bus._reset());

describe("emitInAppAgentActivity", () => {
  it("emits an in_app_agent ChangeEvent with the supplied fields", async () => {
    const received: ChangeEvent[] = [];
    bus.subscribe({}, (e) => received.push(e));

    emitInAppAgentActivity({
      memexId: "m1",
      userId: "u1",
      action: "searched",
      entity: "query",
      narrative: 'searched "auth" in b-31',
      payload: { tool: "search_memex", query: "auth" },
    });

    await Promise.resolve();

    expect(received).toHaveLength(1);
    const e = received[0];
    expect(e.channel).toBe("in_app_agent");
    expect(e.memexId).toBe("m1");
    expect(e.userId).toBe("u1");
    expect(e.action).toBe("searched");
    expect(e.entity).toBe("query");
    expect(e.narrative).toBe('searched "auth" in b-31');
    expect(e.payload).toEqual({ tool: "search_memex", query: "auth" });
    // No docId given → no conversation lookup → clientId stays undefined.
    expect(e.docId).toBeUndefined();
    expect(e.clientId).toBeUndefined();
  });

  it("is advisory — never throws and never blocks the caller", async () => {
    // A throwing subscriber must not propagate out of the detached emit.
    bus.subscribe({}, () => {
      throw new Error("subscriber blew up");
    });

    // Synchronous call must return without throwing.
    expect(() =>
      emitInAppAgentActivity({
        memexId: "m1",
        userId: "u1",
        action: "called",
        entity: "tool_call",
        narrative: "ran a tool",
      }),
    ).not.toThrow();

    // And flushing the microtask must not produce an unhandled rejection.
    await Promise.resolve();
    await Promise.resolve();
  });
});
