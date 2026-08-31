// spec-520 t-6 / ac-28 — the last_used_at bump updates ZERO rows when the stored
// timestamp is already recent.
//
// THE COST BEING REMOVED. `bumpLastUsed` fires on every accepted emission with no
// predicate, so `memex_emission_keys` — a table of roughly 1,100 rows — takes one UPDATE
// per event. Measured on prod as a 600s delta 2026-08-28 (spec-520 c-9): **30.972
// calls/s, 0.0426 ms each**, against an event rate of 30.973. Lifetime counters put it at
// 23.6M updates and 613 autovacuums on those ~1,100 rows.
//
// Nothing consumes this timestamp at second-level freshness — it answers "is this key
// live", shown in the settings UI. A five-minute window keeps that answer true and turns
// almost every one of those UPDATEs into a no-op that writes nothing and creates no dead
// tuple. The statement still runs; it just stops costing a row version.
//
// WHY THIS IS DB-BACKED AND POLLS. `bumpLastUsed` is deliberately fire-and-forget — it
// returns void, wraps its mutate() in `void … .catch()`, and is `silent: true` so a missed
// bump can never fail or delay an emission. There is nothing to await, so the test polls
// for the write [per std-37] rather than assuming it has landed. Asserting against a mock
// would prove only that we called a function.

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { memexEmissionKeys } from "../db/schema.js";
import { bumpLastUsed, mintEmissionKey } from "./emission-keys.js";
import { makeTestMemex } from "./test-helpers.js";
import { upsertUserByEmail } from "./users.js";

const AC_THROTTLE = "mindset-prod/memex-building-itself/specs/spec-520/acs/ac-28";

let memexId: string;
let userId: string;
const createdKeyIds: string[] = [];

async function readLastUsed(keyId: string): Promise<Date | null> {
  const [row] = await db
    .select({ lastUsedAt: memexEmissionKeys.lastUsedAt })
    .from(memexEmissionKeys)
    .where(eq(memexEmissionKeys.id, keyId))
    .limit(1);
  return row?.lastUsedAt ?? null;
}

/** Poll until `lastUsedAt` differs from `from`, or give up. Returns the observed value. */
async function pollForBump(keyId: string, from: Date | null, tries = 40): Promise<Date | null> {
  for (let i = 0; i < tries; i++) {
    const now = await readLastUsed(keyId);
    if (now?.getTime() !== from?.getTime()) return now;
    await new Promise((r) => setTimeout(r, 25));
  }
  return readLastUsed(keyId);
}

async function newKey(name: string): Promise<string> {
  // mintEmissionKey returns { raw, row } — the id is on `row`, not the top level.
  const minted = await mintEmissionKey(memexId, name, userId);
  createdKeyIds.push(minted.row.id);
  return minted.row.id;
}

beforeAll(async () => {
  memexId = await makeTestMemex("t6k");
  const user = await upsertUserByEmail(`spec520-t6-${process.pid}@example.com`);
  userId = user.id;
});

afterAll(async () => {
  if (createdKeyIds.length) {
    await db
      .delete(memexEmissionKeys)
      .where(inArray(memexEmissionKeys.id, createdKeyIds))
      .catch(() => {});
  }
});

describe("spec-520 ac-28: last_used_at is bumped at most once per window", () => {
  it("writes the timestamp on the first use, when it is still NULL", async () => {
    tagAc(AC_THROTTLE);
    const keyId = await newKey("first-use");
    expect(await readLastUsed(keyId)).toBeNull();

    bumpLastUsed(keyId);
    const after = await pollForBump(keyId, null);
    // The NULL arm of the predicate must fire, or a brand-new key would never record a
    // first use at all — the throttle would have turned "cheap" into "broken".
    expect(after).not.toBeNull();
  });

  it("updates ZERO rows on an immediate second use — the row version is not rewritten", async () => {
    tagAc(AC_THROTTLE);
    const keyId = await newKey("within-window");

    bumpLastUsed(keyId);
    const first = await pollForBump(keyId, null);
    expect(first).not.toBeNull();

    // The whole point: a key emitting continuously must stop rewriting its row. This is
    // the ~31 updates/s case measured on prod.
    bumpLastUsed(keyId);
    await new Promise((r) => setTimeout(r, 250));
    expect((await readLastUsed(keyId))?.getTime()).toBe(first!.getTime());
  });

  it("updates the row again once the window has elapsed", async () => {
    tagAc(AC_THROTTLE);
    const keyId = await newKey("past-window");

    bumpLastUsed(keyId);
    const first = await pollForBump(keyId, null);
    expect(first).not.toBeNull();

    // Backdate rather than sleep five minutes. The predicate compares against the
    // DATABASE's now(), so the fixture moves the stored value, not the clock.
    await db
      .update(memexEmissionKeys)
      .set({ lastUsedAt: sql`now() - interval '10 minutes'` })
      .where(eq(memexEmissionKeys.id, keyId));
    const backdated = await readLastUsed(keyId);

    bumpLastUsed(keyId);
    const bumped = await pollForBump(keyId, backdated);
    expect(bumped!.getTime()).toBeGreaterThan(backdated!.getTime());
  });

  it("touches only the key it was given", async () => {
    tagAc(AC_THROTTLE);
    // The predicate is an AND on top of the id match. Getting the boolean structure wrong
    // — an OR where an AND belongs — would update every stale key on the table at once,
    // which is worse than the cost being removed and would not show up in a single-key
    // assertion.
    const target = await newKey("target");
    const bystander = await newKey("bystander");

    bumpLastUsed(target);
    expect(await pollForBump(target, null)).not.toBeNull();
    await new Promise((r) => setTimeout(r, 100));
    expect(await readLastUsed(bystander)).toBeNull();
  });
});
