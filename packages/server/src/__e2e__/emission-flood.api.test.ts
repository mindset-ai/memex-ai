// spec-525 t-7 / ac-1 — user traffic keeps its connections while emission floods.
//
// THIS IS THE PROPERTY THE WHOLE SPEC EXISTS FOR. On 2026-08-11 a revision cutover
// under peak emission load exhausted Cloud SQL: the application was up and answering
// and could not obtain a connection, and 400+ user-visible 500s followed on
// /api/me/events, /presence, /docs/events, /api/auth/me and /mcp.
//
// So the claim is not "the gate refuses things". It is that **while emission is
// flooding, a connection remains obtainable for someone else.**
//
// WHY ENFORCING AND NOT THE DEFAULT. `inFlight` means different things per mode: in
// shadow it returns real occupancy, which "exceeds ceiling routinely, because nothing
// is held back" (the getter's own comment). A flood test left on the default would
// measure the wrong number and pass for the wrong reason. Do not "simplify" the
// explicit mode below.
//
// HOW USER TRAFFIC IS REPRESENTED. By a real query on the shared pool, issued from the
// test while the flood is in flight — not by an HTTP call to a user route. It is the
// stronger evidence: the incident was not "a route 500'd", it was "no connection was
// available", and a query that resolves mid-flood demonstrates exactly that. Most of
// the routes the incident named need a session, which would add auth setup that proves
// nothing extra about the pool.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { app } from "../app.js";
import { users, memexes, memexEmissionKeys, testEvents } from "../db/schema.js";
import { createOrgWithMemexAndOwner } from "../services/__test__/seed-org.js";
import { mintEmissionKey } from "../services/emission-keys.js";
import { __setEmissionGateForTest } from "../middleware/emission-admission.js";
import { EmissionGate } from "../services/admission/emission-gate.js";

const AC_USER_TRAFFIC = "mindset-prod/memex-building-itself/specs/spec-525/acs/ac-1";

const createdUserIds: string[] = [];
const createdMemexIds: string[] = [];
const createdAcUids: string[] = [];

let acUid: string;
let emissionKey: string;

beforeAll(async () => {
  const [u] = await db
    .insert(users)
    .values({
      email: `emit-flood-${crypto.randomUUID()}@example.com`,
      emailVerifiedAt: new Date(),
    } as typeof users.$inferInsert)
    .returning();
  createdUserIds.push(u.id);

  // [per std-37] cl-1: unique per call, so parallel workers cannot collide.
  const seeded = await createOrgWithMemexAndOwner({
    slug: `spec525-flood-${crypto.randomUUID().slice(0, 8)}`,
    ownerUserId: u.id,
  });
  createdMemexIds.push(seeded.memex.id);
  acUid = `${seeded.namespace.slug}/${seeded.memex.slug}/specs/spec-1/acs/ac-1`;
  createdAcUids.push(acUid);
  emissionKey = (await mintEmissionKey(seeded.memex.id, "spec525-flood", u.id)).raw;
});

afterAll(async () => {
  __setEmissionGateForTest(null);
  if (createdAcUids.length) {
    await db
      .delete(testEvents)
      .where(inArray(testEvents.subjectRef, createdAcUids))
      .catch(() => {});
  }
  if (createdMemexIds.length) {
    await db
      .delete(memexEmissionKeys)
      .where(inArray(memexEmissionKeys.memexId, createdMemexIds))
      .catch(() => {});
    await db.delete(memexes).where(inArray(memexes.id, createdMemexIds)).catch(() => {});
  }
  for (const id of createdUserIds) {
    await db.delete(users).where(eq(users.id, id)).catch(() => {});
  }
});

const emitOnce = (i: number) =>
  app.request("/api/test-events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${emissionKey}`,
    },
    body: JSON.stringify({
      ac_uid: acUid,
      status: "pass",
      test_identifier: `flood-${i}`,
      duration_ms: 1,
    }),
  });

describe("spec-525 ac-1: emission cannot starve user traffic of connections", () => {
  it("holds at most its stated fraction of the pool, and a user query is served throughout", async () => {
    tagAc(AC_USER_TRAFFIC);

    // A pool of 8 gives a ceiling strictly below it — that gap IS the guarantee: the
    // slots the gate can never occupy are the ones user traffic always retains.
    const gate = new EmissionGate({ poolMax: 8, mode: "enforcing", waitMs: 50 });
    __setEmissionGateForTest(gate);
    expect(gate.ceiling).toBeLessThan(8);

    try {
      // Start the flood WITHOUT awaiting, so occupancy can be sampled while it runs.
      // 120 concurrent emissions against a ceiling of ~4 is far past saturation — the
      // regime the 2026-08-11 incident happened in.
      const flood = Promise.all(Array.from({ length: 120 }, (_, i) => emitOnce(i)));

      let peakInFlight = 0;
      const userQueryResults: number[] = [];

      // Sample occupancy AND exercise the pool as a user would, repeatedly, while the
      // flood is genuinely in flight.
      for (let round = 0; round < 12; round++) {
        peakInFlight = Math.max(peakInFlight, gate.inFlight);
        const [row] = await db.execute(sql`select 1 as ok`);
        userQueryResults.push(Number((row as { ok: number }).ok));
        await new Promise((r) => setTimeout(r, 5));
      }

      const responses = await flood;
      peakInFlight = Math.max(peakInFlight, gate.inFlight);
      const statuses = responses.map((r) => r.status);

      // 1. Emission never held more than its stated fraction of the pool (ac-1).
      expect(peakInFlight).toBeLessThanOrEqual(gate.ceiling);

      // 2. A user query was served on EVERY sample, throughout the flood (ac-1). This
      //    is the property that failed on 2026-08-11: the app was answering and could
      //    not get a connection.
      expect(userQueryResults).toHaveLength(12);
      expect(userQueryResults.every((v) => v === 1)).toBe(true);

      // 3. A GUARD ON THE GUARD, and it is not optional. If the flood never saturated
      //    the gate, assertion 1 would hold vacuously — "occupancy stayed under the
      //    ceiling" is trivially true when occupancy never approached it. Saturation is
      //    therefore proven independently: at this concurrency against a ceiling of
      //    ~4, some requests MUST have been refused outright.
      const refused = statuses.filter((s) => s === 429).length;
      const served = statuses.filter((s) => s === 201).length;
      expect(refused).toBeGreaterThan(0); // the gate really was saturated
      expect(served).toBeGreaterThan(0); // …and it did not simply refuse everything
      expect(refused + served).toBe(120); // every request got a definite answer
      // NOT asserted: that the SAMPLED peak equals the ceiling. Sampling a counter
      // that fluctuates faster than the sample interval misses the true maximum — the
      // first run of this test observed 3 against a ceiling of 4 — so that assertion
      // would be flaky by construction while adding nothing. `refused > 0` already
      // proves the gate was full, because a refusal is only issued when it is.
    } finally {
      __setEmissionGateForTest(null);
    }
  }, 30_000);

  it("releases every slot afterwards — a flood leaves nothing held", async () => {
    tagAc(AC_USER_TRAFFIC);
    const gate = new EmissionGate({ poolMax: 8, mode: "enforcing", waitMs: 50 });
    __setEmissionGateForTest(gate);
    try {
      await Promise.all(Array.from({ length: 60 }, (_, i) => emitOnce(1000 + i)));
      // ac-8's concrete form under load: once every response is sent, the server is
      // responsible for nothing it has not persisted, and holds no slot for anyone.
      expect(gate.inFlight).toBe(0);
      expect(gate.trackedKeys).toBe(0);
    } finally {
      __setEmissionGateForTest(null);
    }
  }, 30_000);
});
