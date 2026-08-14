// spec-525 t-2 — the wait discipline: bounded wait, bounded waiter set, degradation.
//
// WHY THE WAIT EXISTS AT ALL (dec-4). A cap with no wait is a LOSS SYSTEM: it refuses
// whenever every slot happens to be busy at the same instant, which happens often even at
// low average utilisation. At today's load Erlang-B refuses 26.9 % on one instance — and
// raising the ceiling cannot fix it (10.4 % at three quarters of the pool, 3.3 % even if
// emission is handed the WHOLE pool and protects nothing). Only a queue discipline gets
// there, which is why "wait briefly, then refuse" is not a tuning of "refuse now" but a
// different outcome.
//
// WHY THE WAITERS ARE BOUNDED (ac-19). The same property inverts under a flood. Cloud Run
// runs --concurrency 80 × 8 instances = 640 request slots service-wide, past which Cloud
// Run itself 429s ALL traffic. A waiting request occupies one of those for the interval
// instead of ~1 ms, so unbounded waiting lets a flood fill the service with ~250× less
// traffic. Bounding the waiter set is what makes the gate switch between the two regimes
// by itself.

import { describe, it, expect } from "vitest";
import {
  tagAc,
  PER_REQUEST_TIMEOUT_MS,
  FALLBACK_START_DEADLINE_MS,
} from "@memex-ai-ac/vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EmissionGate,
  deriveMaxWaiters,
  resolveWaitConfig,
  DEFAULT_WAIT_MS,
  DEFAULT_SERVICE_MS,
} from "./emission-gate.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-525/acs";
const AC_WAIT = `${SPEC}/ac-15`; // waits for a slot, refused only when the interval expires
const AC_CLIENT_BOUNDS = `${SPEC}/ac-18`; // the interval stays inside the client's bounds
const AC_WAITERS = `${SPEC}/ac-19`; // the waiter set is bounded; past it, hard shed

/** Fill the gate to its ceiling, returning the releases. */
function saturate(gate: EmissionGate): Array<() => void> {
  const held: Array<() => void> = [];
  for (let i = 0; i < gate.ceiling; i++) {
    const a = gate.tryAcquire(`filler-${i}`);
    if (a.ok) held.push(a.release);
  }
  return held;
}

describe("spec-525 ac-15: a full cap makes the caller wait, it does not refuse on arrival", () => {
  it("serves a waiter when a slot frees part-way through the interval", async () => {
    tagAc(AC_WAIT);
    const gate = new EmissionGate({ mode: "enforcing", poolMax: 4, waitMs: 200 });
    const held = saturate(gate);

    const pending = gate.acquire("late-arrival");
    setTimeout(() => held[0]!(), 30); // a slot frees well inside the interval

    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.waited).toBe(true); // it genuinely queued rather than walking straight in
    held.slice(1).forEach((r) => r());
  });

  it("refuses only once the interval has elapsed, and says which bound blocked it", async () => {
    tagAc(AC_WAIT);
    const gate = new EmissionGate({ mode: "enforcing", poolMax: 4, waitMs: 60 });
    const held = saturate(gate); // nothing will free

    const startedAt = Date.now();
    const result = await gate.acquire("never-served");
    const elapsed = Date.now() - startedAt;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.cause).toBe("instance_ceiling_full");
      expect(result.waited).toBe(true);
    }
    // It WAITED. A gate that refused on arrival would return in ~0ms and fail this.
    expect(elapsed).toBeGreaterThanOrEqual(50);
    held.forEach((r) => r());
  });

  it("does not wait at all when there is room — the fast path stays fast", async () => {
    tagAc(AC_WAIT);
    const gate = new EmissionGate({ mode: "enforcing", poolMax: 8, waitMs: 5_000 });
    const startedAt = Date.now();
    const result = await gate.acquire("uncontended");
    expect(result.ok).toBe(true);
    expect(result.waited).toBe(false);
    // A 5s interval must cost nothing when nothing is contended, or every emission pays
    // for the worst case.
    expect(Date.now() - startedAt).toBeLessThan(50);
  });

  it("hands a freed slot to a waiter whose OWN slice has room, not blindly to the front", async () => {
    tagAc(AC_WAIT);
    // Waiting must respect both bounds. If the freed slot went to the longest-waiting
    // caller regardless of its per-key slice, a loud credential could be handed slots it
    // is not entitled to simply by queueing first — ac-10's fairness undone by the wait.
    const gate = new EmissionGate({ mode: "enforcing", poolMax: 4, waitMs: 300 }); // ceiling 2, slice 1
    const loudFirst = gate.tryAcquire("loud");
    const other = gate.tryAcquire("other");
    expect(loudFirst.ok && other.ok).toBe(true);

    const loudWaiter = gate.acquire("loud"); // queued, but its slice is full
    const quietWaiter = gate.acquire("quiet"); // queued behind it, and entitled

    // Free the slot held by "other". "loud" still cannot take it (slice full), so it must
    // go to "quiet" even though "loud" queued first.
    if (other.ok) other.release();

    const quiet = await quietWaiter;
    expect(quiet.ok).toBe(true);

    if (loudFirst.ok) loudFirst.release();
    await loudWaiter;
  });

  it("the waiting path holds no database connection and issues no statement", () => {
    tagAc(AC_WAIT);
    // Structural, because the claim is about what the module CANNOT do. A waiter is a
    // pending promise, not a pool slot — so ac-7's zero-SQL property extends across the
    // whole time a request spends queued, not just the moment it is refused.
    const source = readFileSync(join(__dirname, "emission-gate.ts"), "utf-8");
    expect(source).not.toMatch(/from "\.\.\/\.\.\/db\/connection/);
    expect(source).not.toMatch(/\bdrizzle\b|\bpostgres\b|\bdb\.(query|execute|transaction)\b/);
    // The only db import it may carry is the zero-import pool-size declaration.
    const dbImports = source.match(/from "\.\.\/\.\.\/db\/[^"]+"/g) ?? [];
    expect(dbImports).toEqual(['from "../../db/pool-size.js"']);
  });
});

describe("spec-525 ac-19: the waiter set is bounded, and past it the gate hard-sheds", () => {
  it("derives the bound from what can actually be served inside the interval", () => {
    tagAc(AC_WAITERS);
    // Queueing deeper than the gate can drain in `waitMs` guarantees the tail times out —
    // requests holding Cloud Run concurrency slots for a refusal they were always going to
    // get. The bound is that drain capacity, not a number someone liked.
    expect(deriveMaxWaiters(2, 250, 30)).toBe(16); // prod shape: 2 slots, 250ms, ~30ms/write
    expect(deriveMaxWaiters(4, 250, 30)).toBe(33);
    expect(deriveMaxWaiters(2, 60, 30)).toBe(4);
    // Never zero: a gate that refuses to queue anyone is the loss system dec-4 rejected.
    expect(deriveMaxWaiters(1, 1, 1000)).toBeGreaterThanOrEqual(1);
  });

  it("refuses the excess PROMPTLY rather than holding it", async () => {
    tagAc(AC_WAITERS);
    const gate = new EmissionGate({ mode: "enforcing", poolMax: 4, waitMs: 400, maxWaiters: 3 });
    const held = saturate(gate);

    const queued = [0, 1, 2].map((i) => gate.acquire(`waiter-${i}`));

    const startedAt = Date.now();
    const overflow = await gate.acquire("one-too-many");
    const elapsed = Date.now() - startedAt;

    expect(overflow.ok).toBe(false);
    if (!overflow.ok) {
      // Refused WITHOUT waiting — that is the whole point of the bound under a flood.
      expect(overflow.waited).toBe(false);
    }
    expect(elapsed).toBeLessThan(100); // nowhere near the 400ms interval

    held.forEach((r) => r());
    await Promise.all(queued);
  });

  it("stops counting a waiter once it has been served or refused", async () => {
    tagAc(AC_WAITERS);
    // A leaked waiter slot would ratchet the gate into permanent flood mode: the bound
    // fills with ghosts and every later caller is hard-shed while the instance is idle.
    const gate = new EmissionGate({ mode: "enforcing", poolMax: 4, waitMs: 40, maxWaiters: 2 });
    const held = saturate(gate);
    await Promise.all([gate.acquire("a"), gate.acquire("b")]); // both time out
    expect(gate.waiting).toBe(0);
    held.forEach((r) => r());
    // The gate is usable again, and a fresh caller is served rather than hard-shed.
    const after = await gate.acquire("c");
    expect(after.ok).toBe(true);
  });

  it("reports how many are waiting, so the flood regime is observable", () => {
    tagAc(AC_WAITERS);
    const gate = new EmissionGate({ mode: "enforcing", poolMax: 4, waitMs: 5_000, maxWaiters: 4 });
    const held = saturate(gate);
    expect(gate.waiting).toBe(0);
    const queued = [gate.acquire("x"), gate.acquire("y")];
    expect(gate.waiting).toBe(2);
    held.forEach((r) => r());
    return Promise.all(queued);
  });
});

describe("spec-525 ac-18: the interval stays inside the CLIENT's own bounds", () => {
  it("is an order of magnitude under both published emitter constants", () => {
    tagAc(AC_CLIENT_BOUNDS);
    // Pinned against the emitter's exported symbols, not copies of 5000/4000, so this
    // stays true if the emitter ever retunes them.
    expect(DEFAULT_WAIT_MS * 10).toBeLessThanOrEqual(PER_REQUEST_TIMEOUT_MS);
    expect(DEFAULT_WAIT_MS * 10).toBeLessThanOrEqual(FALLBACK_START_DEADLINE_MS);
  });

  it("the interval and the waiter bound are configurable without a code change", () => {
    tagAc(AC_CLIENT_BOUNDS);
    // ac-2 requires both set from shadow-mode data; a value compiled in as a literal
    // would make the second deploy a code change rather than a config one.
    expect(resolveWaitConfig({ MEMEX_EMISSION_WAIT_MS: "120" }).waitMs).toBe(120);
    expect(resolveWaitConfig({ MEMEX_EMISSION_MAX_WAITERS: "9" }).maxWaiters).toBe(9);
    expect(resolveWaitConfig({}).waitMs).toBe(DEFAULT_WAIT_MS);
    expect(resolveWaitConfig({}).maxWaiters).toBeUndefined(); // unset → derived
    expect(resolveWaitConfig({ MEMEX_EMISSION_SERVICE_MS: "45" }).serviceMs).toBe(45);
    expect(resolveWaitConfig({}).serviceMs).toBe(DEFAULT_SERVICE_MS);
  });

  it("refuses a configured interval that would breach the client's bounds", () => {
    tagAc(AC_CLIENT_BOUNDS);
    // Misconfiguration must not silently turn a server-side wait into client-side
    // truncation. Clamp rather than obey — the caller's contract outranks our setting.
    const gate = new EmissionGate({ mode: "enforcing", poolMax: 4, waitMs: 30_000 });
    expect(gate.waitMs).toBeLessThan(FALLBACK_START_DEADLINE_MS);
  });
});
