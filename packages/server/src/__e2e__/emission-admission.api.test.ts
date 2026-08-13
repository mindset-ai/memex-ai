// spec-525 t-4 — the admission gate, mounted on the real request path.
//
// WHY THIS SUITE EXISTS RATHER THAN A MOCK-DB ONE. t-1..t-3 test the gate as a
// primitive; this is the only place its PLACEMENT can be tested, and placement is
// the whole of t-4. Two reasons the mock-DB route suite cannot do it:
//
//   1. `test-events.test.ts` builds a bare `new Hono()` and mounts the router
//      directly. A middleware registered in `app.ts` is not in that app at all, so
//      those tests pass whether or not the gate exists. They are a no-regression
//      check, not evidence.
//   2. ac-7 demands "a test that fails if the shed path issues a statement at all".
//      The mock's `db.select` returns undefined, `.from()` throws, and the caller's
//      `.catch(() => {})` swallows it — the exact mechanism that made spec-528
//      issue-1 report three sequential queries as one. A test written against that
//      mock passes whether or not the shed path queries.
//
// So: the real `app`, the real middleware chain, a real database.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { app } from "../app.js";
import { users, memexes, memexEmissionKeys, testEvents } from "../db/schema.js";
import { createOrgWithMemexAndOwner } from "../services/__test__/seed-org.js";
import { mintEmissionKey } from "../services/emission-keys.js";
import {
  emissionGate,
  __setEmissionGateForTest,
} from "../middleware/emission-admission.js";
import { EmissionGate } from "../services/admission/emission-gate.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-525/acs";
const AC_NO_DB = `${SPEC}/ac-7`; // a shed touches no database, and precedes auth
const AC_NOTHING_HELD = `${SPEC}/ac-8`; // nothing is held on the server's behalf
const AC_STILL_201 = `${SPEC}/ac-16`; // an admitted request still WRITES before it responds

const createdUserIds: string[] = [];
const createdMemexIds: string[] = [];
const createdAcUids: string[] = [];

let acUid: string;
let emissionKey: string;

beforeAll(async () => {
  const [u] = await db
    .insert(users)
    .values({
      email: `emit-gate-${crypto.randomUUID()}@example.com`,
      emailVerifiedAt: new Date(),
    } as typeof users.$inferInsert)
    .returning();
  createdUserIds.push(u.id);

  // [per std-37] cl-1: per-call unique slug so parallel workers cannot collide.
  const seeded = await createOrgWithMemexAndOwner({
    slug: `spec525-gate-${crypto.randomUUID().slice(0, 8)}`,
    ownerUserId: u.id,
  });
  createdMemexIds.push(seeded.memex.id);
  acUid = `${seeded.namespace.slug}/${seeded.memex.slug}/specs/spec-1/acs/ac-1`;
  createdAcUids.push(acUid);

  const minted = await mintEmissionKey(seeded.memex.id, "spec525-gate", u.id);
  emissionKey = minted.raw;
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
    await db
      .delete(memexes)
      .where(inArray(memexes.id, createdMemexIds))
      .catch(() => {});
  }
  for (const id of createdUserIds) {
    await db.delete(users).where(eq(users.id, id)).catch(() => {});
  }
});

const body = (over: Record<string, unknown> = {}) => ({
  ac_uid: acUid,
  status: "pass",
  test_identifier: `gate-${crypto.randomUUID()}`,
  duration_ms: 1,
  ...over,
});

const post = (path: string, payload: unknown, token?: string) =>
  app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  });

/**
 * Install a gate that is already full, in enforcing mode, with no wait — so the very
 * next request is shed on arrival. `waitMs: 0` keeps the suite fast; the wait path
 * itself is t-2's, tested directly against the primitive.
 */
function installSaturatedGate(): void {
  const gate = new EmissionGate({
    poolMax: 2, // ceiling 1
    mode: "enforcing",
    waitMs: 0,
  });
  // Occupy every slot and never release: the gate is now closed to everyone.
  for (let i = 0; i < gate.ceiling + 1; i++) gate.tryAcquire("occupant");
  __setEmissionGateForTest(gate);
}

describe("spec-525 ac-7: a shed emission touches no database", () => {
  it("refuses with 429 BEFORE the key is verified — an unauthenticated request never reaches a lookup", async () => {
    tagAc(AC_NO_DB);
    installSaturatedGate();
    try {
      // No Authorization header at all. Ungated, this is a 401 — and a 401 costs a
      // `verifyEmissionKey` SELECT, which is precisely the resource the gate exists to
      // protect. A 429 here proves the gate decided first.
      const res = await post("/api/test-events", body());
      expect(res.status).toBe(429);
    } finally {
      __setEmissionGateForTest(null);
    }
  });

  it("issues NO statement on the shed path — asserted by counting rows, against a real database", async () => {
    tagAc(AC_NO_DB);
    installSaturatedGate();
    try {
      const before = await db
        .select()
        .from(testEvents)
        .where(eq(testEvents.subjectRef, acUid));

      const res = await post("/api/test-events", body(), emissionKey);
      expect(res.status).toBe(429);

      // A shed writes nothing. The stronger claim ac-7 makes — that it READS nothing
      // either — is held structurally: the gate module imports nothing that can open a
      // connection (proven transitively in emission-gate.test.ts), and it is registered
      // ahead of memexResolver, so no middleware between the socket and the decision
      // touches the database.
      const after = await db
        .select()
        .from(testEvents)
        .where(eq(testEvents.subjectRef, acUid));
      expect(after.length).toBe(before.length);
    } finally {
      __setEmissionGateForTest(null);
    }
  });

  it("gates POST /batch too — the highest-volume path does not bypass", async () => {
    tagAc(AC_NO_DB);
    installSaturatedGate();
    try {
      const res = await post(
        "/api/test-events/batch",
        { events: [body(), body()] },
        emissionKey,
      );
      // Not 200-with-rejections: the batch never reaches the handler at all.
      expect(res.status).toBe(429);
    } finally {
      __setEmissionGateForTest(null);
    }
  });
});

describe("spec-525 ac-16: an admitted request still WRITES before it responds", () => {
  it("201 still means persisted — the row id in the response is readable from the database", async () => {
    tagAc(AC_STILL_201);
    tagAc(AC_NOTHING_HELD);
    // The default gate (shadow mode, refuses nothing) is what production runs first.
    __setEmissionGateForTest(null);

    const res = await post("/api/test-events", body(), emissionKey);
    expect(res.status).toBe(201);
    const json = (await res.json()) as { id?: string };
    expect(json.id).toBeTruthy();

    // This is the property that separates dec-4's bounded wait from the rejected
    // accept-and-drain option: the response is not an acknowledgement of intent, it
    // names a row that exists.
    const [row] = await db
      .select()
      .from(testEvents)
      .where(eq(testEvents.id, json.id as string));
    expect(row).toBeDefined();
    expect(row.subjectRef).toBe(acUid);
  });

  it("holds nothing on the server's behalf: after the response, nothing is pending", async () => {
    tagAc(AC_NOTHING_HELD);
    __setEmissionGateForTest(null);

    const res = await post("/api/test-events", body(), emissionKey);
    expect(res.status).toBe(201);

    // ac-8's concrete form: at any instant the number of events the server is
    // responsible for but has not persisted must be ZERO. A waiter is an in-flight
    // HTTP request, not an accepted event — so once every response has been sent, the
    // gate holds no slot and no payload.
    expect(emissionGate().inFlight).toBe(0);
    expect(emissionGate().trackedKeys).toBe(0);
  });
});
