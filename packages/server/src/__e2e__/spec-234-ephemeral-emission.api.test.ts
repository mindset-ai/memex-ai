// spec-234 t-1 — the ephemeral (agent) emission-key path: TTL expiry, spec-scoping,
// and non-exclusive minting, plus the regression that a permanent (CI) key is unchanged.
//
// Exercises the real app + DB: mintEphemeralEmissionKey, the verifyEmissionKey expiry
// gate, and the POST /api/test-events spec-scope gate. Mirrors the spec-129 emission-auth
// harness (seed a throwaway org/memex/user, post events through the real app).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { app } from "../app.js";
import { users, memexes, memexEmissionKeys, testEvents } from "../db/schema.js";
import { createOrgWithMemexAndOwner } from "../services/__test__/seed-org.js";
import {
  mintEmissionKey,
  mintEphemeralEmissionKey,
  verifyEmissionKey,
  ephemeralKeyName,
  EPHEMERAL_TTL_MS,
} from "../services/emission-keys.js";

const M = "mindset-prod/memex-building-itself/specs/spec-234/acs";
const AC_5 = `${M}/ac-5`; // spec-129 security guarantees preserved; new constraints additive
const AC_7 = `${M}/ac-7`; // agent key is short-lived + spec-scoped
const AC_10 = `${M}/ac-10`; // expires_at column + expiry check in verifyEmissionKey
const AC_11 = `${M}/ac-11`; // spec-scope check in the /api/test-events gate
const AC_12 = `${M}/ac-12`; // mint never revokes a prior key — coexisting keys
const AC_15 = `${M}/ac-15`; // ephemeral keys named agent · <spec> · <date>

const createdUserIds: string[] = [];
const createdMemexIds: string[] = [];
const createdAcUids: string[] = [];

afterAll(async () => {
  if (createdAcUids.length) {
    await db.delete(testEvents).where(inArray(testEvents.acUid, createdAcUids)).catch(() => {});
  }
  if (createdMemexIds.length) {
    await db
      .delete(memexEmissionKeys)
      .where(inArray(memexEmissionKeys.memexId, createdMemexIds))
      .catch(() => {});
  }
  for (const id of createdUserIds) {
    await db.delete(users).where(eq(users.id, id)).catch(() => {});
  }
});

async function seedUser(): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({
      email: `emit-eph-${crypto.randomUUID()}@example.com`,
      emailVerifiedAt: new Date(),
    } as typeof users.$inferInsert)
    .returning();
  createdUserIds.push(u.id);
  return u.id;
}

let ns: string;
let memexSlug: string;
let memexId: string;
let ownerUserId: string;
let acUidSpec1: string;
let acUidSpec2: string;

async function postEvent(acUid: string, bearer: string): Promise<Response> {
  return app.request("/api/test-events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Host: "memex.ai",
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({
      ac_uid: acUid,
      status: "pass",
      test_identifier: "tests/eph.test.ts::it works",
      duration_ms: 2,
    }),
  });
}

describe("spec-234 — ephemeral (agent) emission keys", () => {
  beforeEach(() => {
    if (!process.env.GOOGLE_CLIENT_ID) {
      process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
    }
  });

  beforeAll(async () => {
    ownerUserId = await seedUser();
    const seeded = await createOrgWithMemexAndOwner({
      slug: `emit-eph-${Date.now().toString(36)}`,
      ownerUserId,
    });
    ns = seeded.namespace.slug;
    memexSlug = seeded.memex.slug;
    memexId = seeded.memex.id;
    createdMemexIds.push(memexId);
    acUidSpec1 = `${ns}/${memexSlug}/specs/spec-1/acs/ac-1`;
    acUidSpec2 = `${ns}/${memexSlug}/specs/spec-2/acs/ac-1`;
    createdAcUids.push(acUidSpec1, acUidSpec2);
  });

  it("names an ephemeral key `agent · <spec> · <date>` and stamps a ~2h expiry + spec scope [ac-15]", async () => {
    tagAc(AC_15);
    tagAc(AC_7);
    const before = Date.now();
    const minted = await mintEphemeralEmissionKey(memexId, "spec-1", ownerUserId);
    expect(minted.row.name).toMatch(/^agent · spec-1 · \d{4}-\d{2}-\d{2}$/);
    expect(minted.row.scopedSpecHandle).toBe("spec-1");
    expect(minted.row.expiresAt).not.toBeNull();
    const ttl = minted.row.expiresAt!.getTime() - before;
    // ~2h, allowing generous slack for the test clock.
    expect(ttl).toBeGreaterThan(EPHEMERAL_TTL_MS - 60_000);
    expect(ttl).toBeLessThan(EPHEMERAL_TTL_MS + 60_000);
  });

  it("ephemeralKeyName is deterministic for a given handle + day [ac-15]", () => {
    tagAc(AC_15);
    const d = new Date("2026-06-11T09:30:00Z");
    expect(ephemeralKeyName("spec-234", d)).toBe("agent · spec-234 · 2026-06-11");
  });

  it("verifyEmissionKey accepts an unexpired ephemeral key and rejects an expired one [ac-10]", async () => {
    tagAc(AC_10);
    const live = await mintEphemeralEmissionKey(memexId, "spec-1", ownerUserId);
    expect(await verifyEmissionKey(live.raw)).not.toBeNull();

    // ttlMs in the past → already expired at mint.
    const dead = await mintEphemeralEmissionKey(memexId, "spec-1", ownerUserId, {
      ttlMs: -1000,
    });
    expect(await verifyEmissionKey(dead.raw)).toBeNull();
  });

  it("a spec-scoped key emits for its own Spec (201) but is rejected for another Spec (401) [ac-11]", async () => {
    tagAc(AC_11);
    const scoped = await mintEphemeralEmissionKey(memexId, "spec-1", ownerUserId);
    const inScope = await postEvent(acUidSpec1, scoped.raw);
    expect(inScope.status).toBe(201);
    const outOfScope = await postEvent(acUidSpec2, scoped.raw);
    expect(outOfScope.status).toBe(401);
  });

  it("minting an ephemeral key never revokes a prior one — both stay live [ac-12]", async () => {
    tagAc(AC_12);
    const first = await mintEphemeralEmissionKey(memexId, "spec-1", ownerUserId);
    const second = await mintEphemeralEmissionKey(memexId, "spec-1", ownerUserId);
    // Neither was revoked by the other's mint, and both authenticate.
    expect(first.row.revokedAt).toBeNull();
    expect(second.row.revokedAt).toBeNull();
    expect((await postEvent(acUidSpec1, first.raw)).status).toBe(201);
    expect((await postEvent(acUidSpec1, second.raw)).status).toBe(201);
  });

  it("a permanent (CI) key is unchanged: no expiry, whole-memex scope, emits across Specs [ac-5][ac-7]", async () => {
    tagAc(AC_5);
    tagAc(AC_7);
    const ci = await mintEmissionKey(memexId, "ci", ownerUserId);
    expect(ci.row.expiresAt).toBeNull();
    expect(ci.row.scopedSpecHandle).toBeNull();
    // A scopeless, non-expiring key authorises any Spec in its memex.
    expect((await postEvent(acUidSpec1, ci.raw)).status).toBe(201);
    expect((await postEvent(acUidSpec2, ci.raw)).status).toBe(201);
  });
});
