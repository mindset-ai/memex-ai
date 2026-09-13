// spec-562 — an MCP call must not outlive the client that made it.
//
// The 2026-09-10 incident: a create_task went silent for 305 seconds and wrote
// nothing. postgres-js queues on an exhausted pool with NO timeout (index.js:341),
// so nothing threw and nothing was logged — the only trace was a client giving up.
//
// These tests pin the deadline's PROPERTIES, not its implementation. `Promise.race`
// happens to give the "loser settles harmlessly" property for free; a bare
// setTimeout that abandons the promise does not. Asserting it means a future
// refactor that reintroduces the hazard goes red instead of shipping.
import { describe, it, expect, vi, afterEach } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  MCP_DISPATCH_DEADLINE_MS,
  withDispatchDeadline,
} from "./dispatch-deadline.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-562";
const AC = (n: number) => `${SPEC}/acs/ac-${n}`;

// std-37: restore replaced globals so the timer stub cannot leak across files.
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const never = () => new Promise<string>(() => {});

describe("spec-562 — the MCP dispatch deadline", () => {
  it("ac-9: a handler that never settles returns to its caller at the deadline", async () => {
    tagAc(AC(9));
    vi.useFakeTimers();

    const call = withDispatchDeadline(never(), { toolName: "create_task" });
    let settled = false;
    void call.then(() => {
      settled = true;
    });

    // Before the deadline the caller is still waiting — asserting this first is
    // what stops the test passing on an implementation that returns immediately.
    await vi.advanceTimersByTimeAsync(MCP_DISPATCH_DEADLINE_MS - 1);
    expect(settled, "returned BEFORE the deadline").toBe(false);

    await vi.advanceTimersByTimeAsync(2);
    const outcome = await call;

    // The symptom as reported: the caller is ANSWERED. Not merely "nothing threw" —
    // a hang does not throw either, which is the whole defect.
    expect(outcome.timedOut).toBe(true);
  });

  it("ac-9: a handler that finishes in time is untouched", async () => {
    tagAc(AC(9));
    const outcome = await withDispatchDeadline(Promise.resolve("done"), {
      toolName: "get_doc",
    });
    expect(outcome).toEqual({ timedOut: false, value: "done" });
  });

  it("ac-9: a handler that throws in time still throws — the deadline swallows nothing", async () => {
    tagAc(AC(9));
    const boom = new Error("handler failed");
    await expect(
      withDispatchDeadline(Promise.reject(boom), { toolName: "get_doc" }),
    ).rejects.toBe(boom);
  });

  it("ac-13: after the deadline fires, a late RESOLVE raises no unhandled rejection", async () => {
    tagAc(AC(13));
    vi.useFakeTimers();
    let finish!: (v: string) => void;
    const work = new Promise<string>((res) => {
      finish = res;
    });

    const call = withDispatchDeadline(work, { toolName: "create_task" });
    await vi.advanceTimersByTimeAsync(MCP_DISPATCH_DEADLINE_MS + 1);
    expect((await call).timedOut).toBe(true);

    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      finish("landed after the caller gave up");
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("ac-13: after the deadline fires, a late REJECT raises no unhandled rejection", async () => {
    tagAc(AC(13));
    vi.useFakeTimers();
    let fail!: (e: Error) => void;
    const work = new Promise<string>((_res, rej) => {
      fail = rej;
    });

    const call = withDispatchDeadline(work, { toolName: "create_task" });
    await vi.advanceTimersByTimeAsync(MCP_DISPATCH_DEADLINE_MS + 1);
    expect((await call).timedOut).toBe(true);

    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      fail(new Error("the query failed long after the client left"));
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("ac-7: one global value — no per-tool table", async () => {
    tagAc(AC(7));
    expect(MCP_DISPATCH_DEADLINE_MS).toBe(30_000);

    // A per-tool override would have to arrive through the options bag. The
    // signature carries `toolName` for LOGGING only: a new tool inherits the
    // deadline without wiring, and adding an exception must be a deliberate
    // change rather than the path of least resistance.
    vi.useFakeTimers();
    for (const toolName of ["get_doc", "create_task", "search_memex"]) {
      const call = withDispatchDeadline(never(), { toolName });
      await vi.advanceTimersByTimeAsync(MCP_DISPATCH_DEADLINE_MS - 1);
      let early = false;
      void call.then(() => {
        early = true;
      });
      await Promise.resolve();
      expect(early, `${toolName} timed out early — a per-tool value crept in`).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect((await call).timedOut).toBe(true);
    }
  });
});
