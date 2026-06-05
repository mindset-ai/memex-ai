import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { bus, type ChangeEvent } from "./bus.js";
import { mutate, type Mutated } from "./mutate.js";
import { testMutate } from "./__test__/mutate-helpers.js";

beforeEach(() => {
  bus._reset();
});

afterEach(() => {
  bus._reset();
});

function captureEmissions(): ChangeEvent[] {
  const events: ChangeEvent[] = [];
  bus.subscribe({}, (e) => events.push(e));
  return events;
}

describe("mutate() success path", () => {
  it("returns the resolved value as Mutated<T> and emits exactly one event", async () => {
    const events = captureEmissions();
    const result = await mutate(
      {},
      { memexId: "m1", docId: "d1", entity: "task", action: "created" },
      async () => ({ id: "t-1", title: "hello" }),
    );
    expect(result).toEqual({ id: "t-1", title: "hello" });
    expect(events).toHaveLength(1);
    // Pulse (b-60): the exact key shape is preserved and a human narrative is
    // layered on. No clientId/channel here — the ctx ({}) supplies neither.
    expect(events[0]).toEqual({
      memexId: "m1",
      docId: "d1",
      entity: "task",
      action: "created",
      narrative: 'created task d1 "hello"',
    });
  });

  it("preserves the structural type of T (Mutated<T> is assignable to T)", async () => {
    const result: Mutated<{ id: string }> = await mutate(
      {},
      { memexId: "m1", docId: "d1", entity: "task", action: "created" },
      async () => ({ id: "t-1" }),
    );
    // structural access should still work
    const t: { id: string } = result;
    expect(t.id).toBe("t-1");
  });

  it("emits with the exact key shape passed in", async () => {
    const events = captureEmissions();
    await mutate(
      {},
      { memexId: "m2", entity: "org_membership", action: "updated" },
      async () => undefined,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      memexId: "m2",
      entity: "org_membership",
      action: "updated",
      // No row / handle / docId available — narrative degrades to verb + noun.
      narrative: "updated org_membership",
    });
    // docId omitted for non-doc-tree entities
    expect(events[0].docId).toBeUndefined();
  });
});

describe("mutate() failure path", () => {
  it("propagates the thrown error and does NOT emit", async () => {
    const events = captureEmissions();
    await expect(
      mutate(
        {},
        { memexId: "m1", docId: "d1", entity: "task", action: "created" },
        async () => {
          throw new Error("DB went bang");
        },
      ),
    ).rejects.toThrow("DB went bang");
    expect(events).toHaveLength(0);
  });

  it("does not emit when fn throws synchronously inside an async closure", async () => {
    const events = captureEmissions();
    await expect(
      mutate(
        {},
        { memexId: "m1", docId: "d1", entity: "task", action: "created" },
        // eslint-disable-next-line @typescript-eslint/require-await
        async () => {
          throw new Error("sync throw");
        },
      ),
    ).rejects.toThrow("sync throw");
    expect(events).toHaveLength(0);
  });

  it("partial DB write followed by exception: emits nothing (emit happens AFTER fn resolves)", async () => {
    const events = captureEmissions();
    let writeHappened = false;
    await expect(
      mutate(
        {},
        { memexId: "m1", docId: "d1", entity: "task", action: "created" },
        async () => {
          // pretend the DB write succeeded...
          writeHappened = true;
          // ...but then a subsequent step inside the same closure blows up
          throw new Error("post-write failure");
        },
      ),
    ).rejects.toThrow("post-write failure");
    expect(writeHappened).toBe(true);
    expect(events).toHaveLength(0);
  });
});

describe("mutate() silent: true", () => {
  it("returns Mutated<T> with zero emissions", async () => {
    const events = captureEmissions();
    const result = await mutate(
      {},
      { memexId: "m1", entity: "mcp_token", action: "updated" },
      async () => ({ tokenId: "tok-1" }),
      { silent: true },
    );
    expect(result).toEqual({ tokenId: "tok-1" });
    expect(events).toHaveLength(0);
  });

  it("silent: false (explicit) still emits", async () => {
    const events = captureEmissions();
    await mutate(
      {},
      { memexId: "m1", docId: "d1", entity: "task", action: "created" },
      async () => undefined,
      { silent: false },
    );
    expect(events).toHaveLength(1);
  });
});

describe("mutate() key factory", () => {
  it("accepts a function as the key argument and resolves it against the fn() result", async () => {
    const events = captureEmissions();
    const result = await mutate(
      {},
      // The new row's id isn't known until after the insert returns.
      (created: { id: string }) => ({
        memexId: "m1",
        docId: created.id,
        entity: "document",
        action: "created",
      }),
      async () => ({ id: "doc-xyz" }),
    );
    expect(result.id).toBe("doc-xyz");
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      memexId: "m1",
      docId: "doc-xyz",
      entity: "document",
      action: "created",
      // Identifier falls back to the resolved docId; no title on the result.
      narrative: "created document doc-xyz",
    });
  });

  it("key factory is not invoked when silent: true", async () => {
    const events = captureEmissions();
    const factory = vi.fn((r: { id: string }) => ({
      memexId: "m1",
      docId: r.id,
      entity: "document" as const,
      action: "created" as const,
    }));
    await mutate({}, factory, async () => ({ id: "doc-xyz" }), { silent: true });
    expect(events).toHaveLength(0);
    expect(factory).not.toHaveBeenCalled();
  });

  it("key factory is not invoked when fn() throws (no emit on failure)", async () => {
    const events = captureEmissions();
    const factory = vi.fn();
    await expect(
      mutate({}, factory as never, async () => {
        throw new Error("DB blew up");
      }),
    ).rejects.toThrow("DB blew up");
    expect(events).toHaveLength(0);
    expect(factory).not.toHaveBeenCalled();
  });
});

describe("mutate() Pulse activity capture (b-60)", () => {
  it("stamps clientId and channel from ctx onto the emitted event", async () => {
    const events = captureEmissions();
    await mutate(
      { clientId: "conn-42", channel: "mcp" },
      { memexId: "m1", docId: "d1", entity: "task", action: "created" },
      async () => ({ id: "t-1", title: "hello" }),
    );
    expect(events).toHaveLength(1);
    expect(events[0].clientId).toBe("conn-42");
    expect(events[0].channel).toBe("mcp");
  });

  it("omits clientId/channel keys entirely when ctx supplies neither", async () => {
    const events = captureEmissions();
    await mutate(
      {},
      { memexId: "m1", docId: "d1", entity: "task", action: "created" },
      async () => ({ id: "t-1" }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).not.toHaveProperty("clientId");
    expect(events[0]).not.toHaveProperty("channel");
  });

  it("composes a narrative with an explicit handle when the written row carries one", async () => {
    const events = captureEmissions();
    await mutate(
      {},
      (created: { id: string }) => ({
        memexId: "m1",
        docId: created.id,
        entity: "document",
        action: "created",
      }),
      async () => ({ id: "uuid-1", handle: "b-60", title: "Pulse activity feed" }),
    );
    expect(events).toHaveLength(1);
    expect(events[0].narrative).toBe('created document b-60 "Pulse activity feed"');
  });

  it("renders <prefix><seq> for doc-tree children and appends the parent doc handle", async () => {
    const events = captureEmissions();
    await mutate(
      {},
      { memexId: "m1", docId: "uuid-doc", entity: "decision", action: "updated" },
      async () => ({ id: "uuid-dec", seq: 4, docHandle: "b-56" }),
    );
    expect(events).toHaveLength(1);
    expect(events[0].narrative).toBe("updated decision dec-4 on b-56");
  });

  it("truncates an over-long title in the narrative", async () => {
    const events = captureEmissions();
    const longTitle = "x".repeat(80);
    await mutate(
      {},
      { memexId: "m1", docId: "d1", entity: "task", action: "created" },
      async () => ({ id: "t-1", title: longTitle }),
    );
    expect(events).toHaveLength(1);
    expect(events[0].narrative).toBe(`created task d1 "${"x".repeat(57)}…"`);
  });

  it("degrades to verb + noun when no identifying fields are available", async () => {
    const events = captureEmissions();
    await mutate(
      {},
      { memexId: "m1", entity: "memex", action: "deleted" },
      async () => undefined,
    );
    expect(events).toHaveLength(1);
    expect(events[0].narrative).toBe("deleted memex");
  });
});

describe("testMutate() helper", () => {
  it("constructs a Mutated<T> for tests without touching the bus", () => {
    const events = captureEmissions();
    const stubTask = { id: "t-1", title: "stub" };
    const branded: Mutated<typeof stubTask> = testMutate(stubTask);
    expect(branded).toEqual(stubTask);
    expect(events).toHaveLength(0);
  });
});
