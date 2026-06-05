// HTTP auth tests for POST /api/test-events (spec-129 t-2).
//
// Exercises the real app + DB: the Bearer-key gate, the memex-match, multi-key
// auth, revoked-key rejection, and the last_used_at heartbeat. The spec-115
// payload-shaping behaviour and the b-90 namespace guard are covered by their
// own (mock-DB) suites; this suite is the authentication layer in front of them.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { app } from "../app.js";
import { users, memexes, memexEmissionKeys, testEvents } from "../db/schema.js";
import { createOrgWithMemexAndOwner } from "../services/__test__/seed-org.js";
import { mintEmissionKey, revokeEmissionKey } from "../services/emission-keys.js";

const AC_8 = "mindset-prod/memex-building-itself/specs/spec-129/acs/ac-8"; // header-only extraction
const AC_9 = "mindset-prod/memex-building-itself/specs/spec-129/acs/ac-9"; // no/invalid key → 401, no row
const AC_10 = "mindset-prod/memex-building-itself/specs/spec-129/acs/ac-10"; // key/memex mismatch → 401
const AC_12 = "mindset-prod/memex-building-itself/specs/spec-129/acs/ac-12"; // multiple live keys authenticate
const AC_13 = "mindset-prod/memex-building-itself/specs/spec-129/acs/ac-13"; // revoked key → 401
const AC_17 = "mindset-prod/memex-building-itself/specs/spec-129/acs/ac-17"; // last_used_at bump
const AC_1 = "mindset-prod/memex-building-itself/specs/spec-129/acs/ac-1"; // SCOPE: enforcement — keyless/mismatched → 401, no row, no badge/audit impact

const createdUserIds: string[] = [];
const createdMemexIds: string[] = [];
const createdAcUids: string[] = [];
let priorOwn: string | undefined;

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
  if (priorOwn === undefined) delete process.env.MEMEX_OWN_NAMESPACE;
  else process.env.MEMEX_OWN_NAMESPACE = priorOwn;
});

async function seedUser(): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({
      email: `emit-auth-${crypto.randomUUID()}@example.com`,
      emailVerifiedAt: new Date(),
    } as typeof users.$inferInsert)
    .returning();
  createdUserIds.push(u.id);
  return u.id;
}

let ns: string;
let memexSlug: string;
let memexId: string;
let otherMemexId: string;
let ownerUserId: string;
let acUid: string;
let otherAcUid: string;

async function postEvent(
  acUidArg: string,
  opts: { bearer?: string; body?: Record<string, unknown> } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Host: "memex.ai",
  };
  if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`;
  return app.request("/api/test-events", {
    method: "POST",
    headers,
    body: JSON.stringify({
      ac_uid: acUidArg,
      status: "pass",
      test_identifier: "tests/emit.test.ts::it works",
      duration_ms: 3,
      ...opts.body,
    }),
  });
}

async function countEvents(acUidArg: string): Promise<number> {
  const rows = await db.query.testEvents.findMany({
    where: eq(testEvents.acUid, acUidArg),
  });
  return rows.length;
}

describe("POST /api/test-events — emission-key auth (spec-129)", () => {
  beforeEach(() => {
    if (!process.env.GOOGLE_CLIENT_ID) {
      process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
    }
  });

  let key: string;

  beforeAll(async () => {
    const userId = await seedUser();
    ownerUserId = userId;
    const seeded = await createOrgWithMemexAndOwner({
      slug: `emit-auth-${Date.now().toString(36)}`,
      ownerUserId: userId,
    });
    ns = seeded.namespace.slug;
    memexSlug = seeded.memex.slug;
    memexId = seeded.memex.id;
    createdMemexIds.push(memexId);

    // A second Memex in the SAME namespace, for the cross-Memex mismatch test (ac-10).
    const [other] = await db
      .insert(memexes)
      .values({ namespaceId: seeded.namespace.id, slug: "other", name: "Other" })
      .returning();
    otherMemexId = other.id;
    createdMemexIds.push(otherMemexId);

    acUid = `${ns}/${memexSlug}/specs/spec-1/acs/ac-1`;
    otherAcUid = `${ns}/other/specs/spec-1/acs/ac-1`;
    createdAcUids.push(acUid, otherAcUid);

    // The route's cross-namespace guard compares ac_uid's namespace to MEMEX_OWN_NAMESPACE.
    priorOwn = process.env.MEMEX_OWN_NAMESPACE;
    process.env.MEMEX_OWN_NAMESPACE = ns;

    const minted = await mintEmissionKey(memexId, "primary", ownerUserId);
    key = minted.raw;
  });

  it("rejects a request with NO key (401, no row written) [ac-9]", async () => {
    tagAc(AC_9);
    tagAc(AC_1); // scope outcome: keyless emission cannot land a row / move a badge
    const before = await countEvents(acUid);
    const res = await postEvent(acUid);
    expect(res.status).toBe(401);
    expect(await countEvents(acUid)).toBe(before);
  });

  it("rejects a request with an INVALID key (401) [ac-9]", async () => {
    tagAc(AC_9);
    const res = await postEvent(acUid, { bearer: "mxk_not_a_real_key" });
    expect(res.status).toBe(401);
  });

  it("accepts a request with a valid Bearer key (201) [ac-9]", async () => {
    tagAc(AC_9);
    const res = await postEvent(acUid, { bearer: key });
    expect(res.status).toBe(201);
  });

  it("extracts the key ONLY from the Authorization header — a key in the body does not authenticate [ac-8]", async () => {
    tagAc(AC_8);
    // Same valid key value, but supplied in the body / query rather than the header.
    const res = await postEvent(acUid, { body: { key, emission_key: key } });
    expect(res.status).toBe(401);
    const viaQuery = await app.request(
      `/api/test-events?key=${encodeURIComponent(key)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Host: "memex.ai" },
        body: JSON.stringify({
          ac_uid: acUid,
          status: "pass",
          test_identifier: "t.ts::x",
          duration_ms: 1,
        }),
      },
    );
    expect(viaQuery.status).toBe(401);
  });

  it("rejects a valid key whose Memex does not match the ac_uid (401) [ac-10]", async () => {
    tagAc(AC_10);
    tagAc(AC_1); // scope outcome: cross-Memex key also blocked
    // `key` belongs to memexId; otherAcUid names the OTHER memex in the same namespace.
    const before = await countEvents(otherAcUid);
    const res = await postEvent(otherAcUid, { bearer: key });
    expect(res.status).toBe(401);
    expect(await countEvents(otherAcUid)).toBe(before);
  });

  it("authenticates every non-revoked key on the Memex [ac-12]", async () => {
    tagAc(AC_12);
    const second = await mintEmissionKey(memexId, "secondary", ownerUserId);
    const r1 = await postEvent(acUid, { bearer: key });
    const r2 = await postEvent(acUid, { bearer: second.raw });
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
  });

  it("rejects a revoked key while siblings keep working (401) [ac-13]", async () => {
    tagAc(AC_13);
    const victim = await mintEmissionKey(memexId, "to-revoke", ownerUserId);
    expect((await postEvent(acUid, { bearer: victim.raw })).status).toBe(201);

    await revokeEmissionKey(victim.row.id, memexId);

    const afterRevoke = await postEvent(acUid, { bearer: victim.raw });
    expect(afterRevoke.status).toBe(401);
    // The original key is unaffected.
    expect((await postEvent(acUid, { bearer: key })).status).toBe(201);
  });

  it("bumps the key's last_used_at on a successful emission [ac-17]", async () => {
    tagAc(AC_17);
    const fresh = await mintEmissionKey(memexId, "heartbeat", ownerUserId);
    expect(fresh.row.lastUsedAt).toBeNull();

    expect((await postEvent(acUid, { bearer: fresh.raw })).status).toBe(201);

    // bumpLastUsed is fire-and-forget — poll briefly for the async write.
    let lastUsedAt: Date | null = null;
    for (let i = 0; i < 30 && !lastUsedAt; i++) {
      const row = await db.query.memexEmissionKeys.findFirst({
        where: eq(memexEmissionKeys.id, fresh.row.id),
      });
      lastUsedAt = row?.lastUsedAt ?? null;
      if (!lastUsedAt) await new Promise((r) => setTimeout(r, 50));
    }
    expect(lastUsedAt).not.toBeNull();
  });
});
