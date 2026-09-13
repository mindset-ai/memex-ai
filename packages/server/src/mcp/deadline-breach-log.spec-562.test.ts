// spec-562 ac-12 — a deadline breach must be visible to an operator.
//
// Today this failure leaves NO trace in prod stderr: nothing throws, so nothing is
// logged, and the only evidence of the 2026-09-10 incident was a client giving up
// after 305 seconds. A breach that degrades silently is the defect wearing a fix's
// clothes.
//
// The log line is the ONLY future source for how often this happens: mcp_tool_calls
// cannot answer it, because a call that never settles writes no row at all.
import { describe, it, expect, vi, afterEach } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  MCP_DISPATCH_DEADLINE_MS,
  withDispatchDeadline,
} from "./dispatch-deadline.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-562/acs/ac-${n}`;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Drive a breach and hand back what onLateSettle received. */
async function breachThen(settle: (p: {
  resolve: (v: string) => void;
  reject: (e: unknown) => void;
}) => void) {
  vi.useFakeTimers();
  let resolve!: (v: string) => void;
  let reject!: (e: unknown) => void;
  const work = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const seen: unknown[] = [];
  const call = withDispatchDeadline(work, {
    toolName: "create_task",
    onLateSettle: (o) => seen.push(o),
  });
  await vi.advanceTimersByTimeAsync(MCP_DISPATCH_DEADLINE_MS + 1);
  expect((await call).timedOut).toBe(true);

  // The work lands well after the caller gave up — 305s, the real incident.
  await vi.advanceTimersByTimeAsync(275_000);
  settle({ resolve, reject });
  await vi.advanceTimersByTimeAsync(0);
  await Promise.resolve();
  return seen;
}

describe("spec-562 — a deadline breach is visible to an operator", () => {
  it("ac-12: the breach reports the tool and the work's TRUE elapsed time", async () => {
    tagAc(AC(12));
    const seen = (await breachThen(({ resolve }) => resolve("landed"))) as Array<{
      toolName: string;
      elapsedMs: number;
      error?: unknown;
    }>;

    expect(seen, "no breach was reported — the failure is silent again").toHaveLength(1);
    expect(seen[0].toolName).toBe("create_task");
    // Not the deadline. The whole point: the operator must see 305s, not 30s.
    expect(seen[0].elapsedMs).toBeGreaterThanOrEqual(MCP_DISPATCH_DEADLINE_MS + 275_000);
    expect(seen[0].error).toBeUndefined();
  });

  it("ac-12: a breach whose work later THREW carries the error OBJECT, not a string", async () => {
    tagAc(AC(12));
    const boom = new Error("connection terminated unexpectedly");
    const seen = (await breachThen(({ reject }) => reject(boom))) as Array<{
      error?: unknown;
    }>;

    expect(seen).toHaveLength(1);
    // std-14 / std-53: log the original error OBJECT so its stack survives.
    // `String(err)` does not satisfy this — a stack is what makes a 3am page
    // actionable, and it is gone the moment the error is stringified.
    expect(seen[0].error).toBe(boom);
    expect(seen[0].error).toBeInstanceOf(Error);
    expect((seen[0].error as Error).stack).toBeTruthy();
  });

  it("ac-12: a call that finishes in time reports nothing — no noise floor", async () => {
    tagAc(AC(12));
    const seen: unknown[] = [];
    const outcome = await withDispatchDeadline(Promise.resolve("fast"), {
      toolName: "get_doc",
      onLateSettle: (o) => seen.push(o),
    });
    expect(outcome.timedOut).toBe(false);
    // A breach log that also fires on healthy calls is a log nobody reads.
    expect(seen).toHaveLength(0);
  });
});
