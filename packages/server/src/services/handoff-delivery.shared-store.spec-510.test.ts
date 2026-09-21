// spec-510 t-4 (dec-7, dec-9 — ac-18, ac-19): handoff delivery on the SHARED store.
//
// THE DEFECT BEING FIXED IS LIVE IN PRODUCTION. handoff-delivery.ts promises the
// full ~1,500-word handoff rides the footer once per (user, session, spec, phase).
// Measured over 30 days to 2026-07-27 it delivers 2.672x — 1,151 of 1,659
// re-deliveries unexplained by its TTL, median gap 36 seconds. 2.672 is about the
// Cloud Run instance count: a process-local Map behind a load balancer.
//
// THE FAILURE TO GUARD AGAINST IS THE OPPOSITE ONE. The correct reading after this
// change is exactly 1.0 per group — NEVER 0. An agent that stops being primed at a
// phase transition is far worse than the over-delivery being fixed, and it fails
// silently: no error, no red test, no log line (dec-9). That is why ac-19 exists
// and why the flag's OFF path is tested here as carefully as the ON path.
//
// The spec-203 suite next door (handoff-delivery.test.ts) still owns the Map's
// contract with an injected clock. These tests own the migration: the shared-store
// path, the flag, and the equivalence between them.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  claimFullHandoffDelivery,
  _clearHandoffDeliveries,
  handoffSharedStoreEnabled,
  handoffClaimKey,
  HANDOFF_SHARED_STORE_FLAG,
  FULL_HANDOFF_TTL_MS,
} from "./handoff-delivery.js";
import { claimOnce } from "./session-claims.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-510/acs/ac-${n}`;

let n = 0;
/** Worker-unique [per std-37] — parallel workers own private DB clones but run the same file. */
function session(label = "hs"): string {
  const worker = process.env.VITEST_POOL_ID ?? "0";
  return `${label}-w${worker}-${n++}-${Math.random().toString(36).slice(2)}`;
}

const U = "user-1";
const SPEC = "spec-1";

let original: string | undefined;
beforeEach(() => {
  original = process.env[HANDOFF_SHARED_STORE_FLAG];
  _clearHandoffDeliveries();
});
afterEach(() => {
  // Restore the global stub rather than deleting it [per std-37] — another file
  // in this worker may legitimately have it set.
  if (original === undefined) delete process.env[HANDOFF_SHARED_STORE_FLAG];
  else process.env[HANDOFF_SHARED_STORE_FLAG] = original;
});

const on = () => (process.env[HANDOFF_SHARED_STORE_FLAG] = "true");
const off = () => delete process.env[HANDOFF_SHARED_STORE_FLAG];

async function rowsFor(sessionId: string): Promise<number> {
  const r = (await db.execute(sql`
    SELECT count(*)::int AS n FROM agent_session_claims WHERE session_id = ${sessionId}
  `)) as unknown as Array<{ n: number }>;
  return r[0]?.n ?? 0;
}

describe("the flag itself (dec-9)", () => {
  it("defaults OFF when unset, empty, or unrecognised — and is read live", () => {
    tagAc(AC(19));
    off();
    expect(handoffSharedStoreEnabled()).toBe(false);
    process.env[HANDOFF_SHARED_STORE_FLAG] = "";
    expect(handoffSharedStoreEnabled()).toBe(false);
    process.env[HANDOFF_SHARED_STORE_FLAG] = "maybe";
    expect(handoffSharedStoreEnabled()).toBe(false);
    // Read live, not cached at import: flipping it takes effect on the next call,
    // which is the whole point of a kill switch (no deploy).
    process.env[HANDOFF_SHARED_STORE_FLAG] = "true";
    expect(handoffSharedStoreEnabled()).toBe(true);
    process.env[HANDOFF_SHARED_STORE_FLAG] = "off";
    expect(handoffSharedStoreEnabled()).toBe(false);
  });
});

describe("ON — the corrected behaviour on the shared store (ac-18)", () => {
  it("delivers once per (user, session, spec, phase) and not again", async () => {
    tagAc(AC(18));
    on();
    const s = session();
    expect(await claimFullHandoffDelivery(U, s, SPEC, "build")).toBe(true);
    expect(await claimFullHandoffDelivery(U, s, SPEC, "build")).toBe(false);
    expect(await claimFullHandoffDelivery(U, s, SPEC, "build")).toBe(false);
  });

  it("ANOTHER INSTANCE's claim is honoured — the 2.672x defect, expressed as a test", async () => {
    tagAc(AC(18));
    on();
    const s = session();

    // ⚠ THIS is the assertion that distinguishes migrated from unmigrated, and a
    // same-process concurrency test is NOT it. A process-local Map is perfectly
    // atomic WITHIN one process, so `Promise.all` of twelve claims passes on the
    // BROKEN implementation — it cannot see the defect, because the defect only
    // exists ACROSS instances.
    //
    // What a second Cloud Run instance does is write the claim to the shared row
    // without going through this process's Map. So: stake the claim as instance A
    // would, then ask this process (instance B).
    expect(await claimOnce(s, handoffClaimKey(U, SPEC, "build"), { ttlMs: FULL_HANDOFF_TTL_MS })).toBe(true);

    // On the Map this reads `true` — instance B cannot see instance A, delivers
    // again, and that is the 2.672x. On the shared store it must read false.
    expect(await claimFullHandoffDelivery(U, s, SPEC, "build")).toBe(false);
  });

  it("writes the claim where another instance can SEE it", async () => {
    tagAc(AC(18));
    on();
    const s = session();
    expect(await rowsFor(s)).toBe(0);
    await claimFullHandoffDelivery(U, s, SPEC, "build");
    // The Map writes nothing to Postgres, so this reds on the unmigrated code.
    expect(await rowsFor(s)).toBe(1);
  });

  it("serialises concurrent claimants on the row lock", async () => {
    tagAc(AC(18));
    on();
    const s = session();
    // Weaker than the two above (it also passes on a Map — see the note there),
    // but it pins that moving to the shared store did not INTRODUCE a race that
    // the single-process Map never had.
    const results = await Promise.all(
      Array.from({ length: 12 }, () => claimFullHandoffDelivery(U, s, SPEC, "build")),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("KEEPS PHASE IN THE KEY — a phase change re-primes (ac-19)", async () => {
    tagAc(AC(19));
    on();
    const s = session();
    expect(await claimFullHandoffDelivery(U, s, SPEC, "specify")).toBe(true);
    expect(await claimFullHandoffDelivery(U, s, SPEC, "specify")).toBe(false);
    // spec-203 put phase in the key deliberately so a transition re-primes. The
    // dangerous reading for this Spec is 0 per group, not 2.672.
    expect(await claimFullHandoffDelivery(U, s, SPEC, "build")).toBe(true);
  });

  it("KEEPS USER IN THE KEY — two users on one session each get primed", async () => {
    tagAc(AC(19));
    on();
    const s = session();
    // dec-7 wrote the namespace as `handoff:{spec}:{phase}`, but the shipped key
    // is (user, session, spec, phase). Dropping user would silently under-deliver
    // for a second user on one session, and AC2 says only the STORAGE moves.
    expect(await claimFullHandoffDelivery("user-a", s, SPEC, "build")).toBe(true);
    expect(await claimFullHandoffDelivery("user-b", s, SPEC, "build")).toBe(true);
    expect(await claimFullHandoffDelivery("user-a", s, SPEC, "build")).toBe(false);
  });

  it("keys per spec", async () => {
    tagAc(AC(19));
    on();
    const s = session();
    expect(await claimFullHandoffDelivery(U, s, "spec-1", "build")).toBe(true);
    expect(await claimFullHandoffDelivery(U, s, "spec-2", "build")).toBe(true);
  });

  it("the idle TTL backstop still re-primes a returning session (ac-19)", async () => {
    tagAc(AC(19));
    on();
    const s = session();
    expect(await claimFullHandoffDelivery(U, s, SPEC, "build")).toBe(true);
    expect(await claimFullHandoffDelivery(U, s, SPEC, "build", Date.now(), FULL_HANDOFF_TTL_MS)).toBe(false);
    // A zero-length window stands in for "the idle interval has elapsed" without
    // a sleep — time is computed in-DB on this path, so the injected `now` that
    // drives the Map's tests cannot drive this one.
    expect(await claimFullHandoffDelivery(U, s, SPEC, "build", Date.now(), 0)).toBe(true);
  });
});

describe("OFF — the retreat path restores today's behaviour exactly (dec-9, ac-21-adjacent)", () => {
  it("claims against the Map and writes NOTHING to the shared store", async () => {
    tagAc(AC(19));
    off();
    const s = session();
    expect(await claimFullHandoffDelivery(U, s, SPEC, "build")).toBe(true);
    expect(await claimFullHandoffDelivery(U, s, SPEC, "build")).toBe(false);
    // The point of the kill switch: flipping it off must leave the shared store
    // untouched, not merely ignored. A row written here would mean the two stores
    // disagree the moment the flag flips back.
    expect(await rowsFor(s)).toBe(0);
  });

  it("keeps the injected clock working — the Map path is byte-for-byte the old one", async () => {
    tagAc(AC(19));
    off();
    const s = session();
    const T0 = 1_000_000;
    expect(await claimFullHandoffDelivery(U, s, SPEC, "build", T0)).toBe(true);
    expect(await claimFullHandoffDelivery(U, s, SPEC, "build", T0 + 60_000)).toBe(false);
    expect(await claimFullHandoffDelivery(U, s, SPEC, "build", T0 + FULL_HANDOFF_TTL_MS)).toBe(true);
  });

  it("the two paths agree on the once-per-group contract", async () => {
    tagAc(AC(18));
    // Same sequence, both paths, same answers — which is what "only the storage
    // moved" has to mean if it means anything.
    for (const mode of ["off", "on"] as const) {
      if (mode === "on") on();
      else off();
      const s = session(mode);
      expect(await claimFullHandoffDelivery(U, s, SPEC, "build")).toBe(true);
      expect(await claimFullHandoffDelivery(U, s, SPEC, "build")).toBe(false);
      expect(await claimFullHandoffDelivery(U, s, SPEC, "verify")).toBe(true);
    }
  });
});
