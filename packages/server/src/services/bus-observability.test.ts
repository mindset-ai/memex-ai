// Passive bus observability (doc-16 dec-3) — unit tests for the divergence
// check + the periodic logger. The logger uses real setInterval; the test
// drives it with a tight interval and clock-advancing.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { checkDivergence, startBusObservability, _resetBusObservability } from "./bus-observability.js";

// Helper: build a Delta with zeroed read fields (Pulse b-60). Most existing
// checkDivergence cases predate reads and assert pure write/emit behaviour, so
// they pass reads: 0 explicitly via this helper.
const noReads = { reads: 0, readsByAction: { viewed: 0, searched: 0, assessed: 0, called: 0 } } as const;

describe("checkDivergence", () => {
  it("returns ok when emits exactly equal writes - silentWrites", () => {
    const r = checkDivergence({
      windowMs: 60_000,
      writes: 10,
      silentWrites: 3,
      writesFailed: 0,
      emits: 7,
      ...noReads,
      subscriberErrors: 0,
      listenerCount: 5,
    });
    expect(r).toEqual({ ok: true });
  });

  it("returns ok when emits exceed writes - silentWrites (composite mutations)", () => {
    const r = checkDivergence({
      windowMs: 60_000,
      writes: 4,
      silentWrites: 0,
      writesFailed: 0,
      emits: 9, // composite emits 2+ per write
      ...noReads,
      subscriberErrors: 0,
      listenerCount: 5,
    });
    expect(r).toEqual({ ok: true });
  });

  it("reports missing count when emits fall below expected", () => {
    const r = checkDivergence({
      windowMs: 60_000,
      writes: 10,
      silentWrites: 2,
      writesFailed: 0,
      emits: 5, // expected ≥ 8
      ...noReads,
      subscriberErrors: 0,
      listenerCount: 3,
    });
    expect(r).toEqual({ ok: false, missing: 3 });
  });

  it("is ok in a quiet window with no activity", () => {
    const r = checkDivergence({
      windowMs: 60_000,
      writes: 0,
      silentWrites: 0,
      writesFailed: 0,
      emits: 0,
      ...noReads,
      subscriberErrors: 0,
      listenerCount: 0,
    });
    expect(r).toEqual({ ok: true });
  });

  // Pulse (b-60). Read emits ride the same bus and inflate `emits`. The
  // invariant must be checked against mutation emits only (emits - reads).
  it("excludes read emits from the divergence check (reads do not satisfy a write gap)", () => {
    // 10 non-silent writes expect ≥ 10 mutation emits. We saw 12 total emits but
    // 8 of those were reads — only 4 mutation emits, so this IS a divergence.
    const r = checkDivergence({
      windowMs: 60_000,
      writes: 10,
      silentWrites: 0,
      writesFailed: 0,
      emits: 12,
      reads: 8,
      readsByAction: { viewed: 5, searched: 2, assessed: 1, called: 0 },
      subscriberErrors: 0,
      listenerCount: 3,
    });
    // mutationEmits = 12 - 8 = 4, expected 10 → missing 6.
    expect(r).toEqual({ ok: false, missing: 6 });
  });

  it("ignores a wash of read emits when mutation emits are healthy", () => {
    const r = checkDivergence({
      windowMs: 60_000,
      writes: 4,
      silentWrites: 0,
      writesFailed: 0,
      emits: 1004, // 4 mutation + 1000 reads
      reads: 1000,
      readsByAction: { viewed: 1000, searched: 0, assessed: 0, called: 0 },
      subscriberErrors: 0,
      listenerCount: 3,
    });
    expect(r).toEqual({ ok: true });
  });

  it("is ok in a read-only window (reads alone never satisfy nor violate the write invariant)", () => {
    const r = checkDivergence({
      windowMs: 60_000,
      writes: 0,
      silentWrites: 0,
      writesFailed: 0,
      emits: 50,
      reads: 50,
      readsByAction: { viewed: 20, searched: 20, assessed: 5, called: 5 },
      subscriberErrors: 0,
      listenerCount: 3,
    });
    expect(r).toEqual({ ok: true });
  });

  it("clamps mutationEmits at zero so a snapshot skew can't trip a spurious WARN", () => {
    // reads momentarily exceeds emits (counter sampled between emit++ and tally).
    const r = checkDivergence({
      windowMs: 60_000,
      writes: 0,
      silentWrites: 0,
      writesFailed: 0,
      emits: 3,
      reads: 5,
      readsByAction: { viewed: 5, searched: 0, assessed: 0, called: 0 },
      subscriberErrors: 0,
      listenerCount: 3,
    });
    expect(r).toEqual({ ok: true });
  });
});

describe("startBusObservability lifecycle", () => {
  beforeEach(() => {
    _resetBusObservability();
    vi.useFakeTimers();
  });

  afterEach(() => {
    _resetBusObservability();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("is idempotent — calling start twice returns the same timer", () => {
    const first = startBusObservability({ intervalMs: 1000 });
    const second = startBusObservability({ intervalMs: 1000 });
    expect(first).toBe(second);
  });

  it("logs a [BUS METRICS] line on a non-quiet window", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    startBusObservability({ intervalMs: 1000 });

    // Generate some activity by invoking the real mutate() path.
    const { mutate } = await import("./mutate.js");
    await mutate(
      {},
      { memexId: "obs-test", entity: "task", action: "updated" },
      async () => 42,
    );

    vi.advanceTimersByTime(1100);

    // Allow the queued setInterval callback to run.
    await Promise.resolve();

    const calls = logSpy.mock.calls.flat().map(String);
    expect(calls.some((c) => c.includes("[BUS METRICS]"))).toBe(true);
  });

  // Pulse (b-60). A read-only window: emitting read actions onto the bus must
  // surface as `reads` in the log line and must NOT trigger a divergence WARN.
  it("counts read emits as `reads` and does not warn on a read-only window", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    startBusObservability({ intervalMs: 1000 });

    const { bus } = await import("./bus.js");
    bus.emit({ memexId: "obs-test", entity: "query", action: "searched", narrative: "q" });
    bus.emit({ memexId: "obs-test", entity: "document", action: "viewed", narrative: "v" });
    bus.emit({ memexId: "obs-test", entity: "tool_call", action: "called", narrative: "c" });

    vi.advanceTimersByTime(1100);
    await Promise.resolve();

    // No divergence WARN — reads were carved out, leaving zero mutation emits
    // against zero writes.
    expect(warnSpy.mock.calls.flat().map(String).some((c) => c.includes("divergence"))).toBe(false);

    const metricsLine = logSpy.mock.calls
      .flat()
      .map(String)
      .find((c) => c.includes("[BUS METRICS]"));
    expect(metricsLine).toBeDefined();
    // Additive fields present and correctly attributed.
    expect(metricsLine).toContain('"reads":3');
    expect(metricsLine).toContain('"searched":1');
    expect(metricsLine).toContain('"viewed":1');
    expect(metricsLine).toContain('"called":1');
    // Existing fields preserved (additive change — nothing renamed/removed).
    expect(metricsLine).toContain('"writes":0');
    expect(metricsLine).toContain('"emits":3');
  });
});
