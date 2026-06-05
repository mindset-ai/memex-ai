// HTTP route tests for the Emission Keys settings endpoints (spec-129 t-3).
//
// Exercises the real app + DB: generate / list / revoke through
// /api/:namespace/:memex/emission-keys, plus the at-rest guarantees (only the
// SHA-256 hash is stored; the raw key is returned exactly once).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { app } from "../app.js";
import { users, memexEmissionKeys } from "../db/schema.js";
import { signSessionToken } from "../services/auth-jwt.js";
import { createOrgWithMemexAndOwner } from "../services/__test__/seed-org.js";
import { hashKey, verifyEmissionKey } from "../services/emission-keys.js";

const AC_14 = "mindset-prod/memex-building-itself/specs/spec-129/acs/ac-14"; // only the hash is stored
const AC_15 = "mindset-prod/memex-building-itself/specs/spec-129/acs/ac-15"; // raw key shown once; list omits secret
const AC_13 = "mindset-prod/memex-building-itself/specs/spec-129/acs/ac-13"; // soft-revoke; revoked key stops verifying
const AC_2 = "mindset-prod/memex-building-itself/specs/spec-129/acs/ac-2"; // SCOPE: owner generate/name/list/revoke; shown once; multiple live

const createdUserIds: string[] = [];
const createdMemexIds: string[] = [];

afterAll(async () => {
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
      email: `emit-keys-${crypto.randomUUID()}@example.com`,
      emailVerifiedAt: new Date(),
    } as typeof users.$inferInsert)
    .returning();
  createdUserIds.push(u.id);
  return u.id;
}

async function authedRequest(
  path: string,
  bearer: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  headers.set("Authorization", `Bearer ${bearer}`);
  headers.set("Host", "memex.ai");
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return app.request(path, { ...init, headers });
}

describe("emission-keys routes [/api/:namespace/:memex/emission-keys]", () => {
  beforeEach(() => {
    if (!process.env.GOOGLE_CLIENT_ID) {
      process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
    }
  });

  let bearer: string;
  let namespace: string;
  let memex: string;
  let memexId: string;
  let base: string;

  beforeAll(async () => {
    const userId = await seedUser();
    bearer = signSessionToken(userId);
    const seeded = await createOrgWithMemexAndOwner({
      slug: `emit-${Date.now().toString(36)}`,
      ownerUserId: userId,
    });
    namespace = seeded.namespace.slug;
    memex = seeded.memex.slug;
    memexId = seeded.memex.id;
    createdMemexIds.push(memexId);
    base = `/api/${namespace}/${memex}/emission-keys`;
  });

  it("POST / returns the raw key exactly once and never echoes the hash (ac-15)", async () => {
    tagAc(AC_15);
    tagAc(AC_2); // scope outcome: owner generates a named key, raw shown once
    const res = await authedRequest(base, bearer, {
      method: "POST",
      body: JSON.stringify({ name: "pythonia CI" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;

    expect(typeof body.key).toBe("string");
    expect((body.key as string).startsWith("mxk_")).toBe(true);
    expect(body.name).toBe("pythonia CI");
    expect(typeof body.prefix).toBe("string");
    expect(body.lastUsedAt ?? null).toBeNull();
    // The at-rest secret is never serialised.
    expect(body).not.toHaveProperty("hashedKey");
    expect(body).not.toHaveProperty("hashed_key");
  });

  it("stores only the SHA-256 hash of the raw key, never the raw value (ac-14)", async () => {
    tagAc(AC_14);
    const res = await authedRequest(base, bearer, {
      method: "POST",
      body: JSON.stringify({ name: "hash check" }),
    });
    const body = (await res.json()) as { id: string; key: string };

    const row = await db.query.memexEmissionKeys.findFirst({
      where: eq(memexEmissionKeys.id, body.id),
    });
    expect(row, "row should exist").toBeTruthy();
    // hashed_key is exactly the SHA-256 of the raw key…
    expect(row!.hashedKey).toBe(hashKey(body.key));
    // …and the raw key is nowhere in the persisted row.
    expect(JSON.stringify(row)).not.toContain(body.key);
    // The auth path can resolve the active key by hashing the presented value.
    const verified = await verifyEmissionKey(body.key);
    expect(verified?.id).toBe(body.id);
  });

  it("GET / lists keys with prefix metadata only — no key, no hash (ac-15)", async () => {
    tagAc(AC_15);
    const res = await authedRequest(base, bearer, { method: "GET" });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(typeof r.prefix).toBe("string");
      expect((r.prefix as string).startsWith("mxk_")).toBe(true);
      expect(r).not.toHaveProperty("key");
      expect(r).not.toHaveProperty("hashedKey");
      expect(r).not.toHaveProperty("hashed_key");
    }
  });

  it("POST /:id/revoke soft-revokes: row persists, key stops verifying, siblings keep working (ac-13)", async () => {
    tagAc(AC_13);
    tagAc(AC_2); // scope outcome: list + revoke + multiple live keys at once
    // Two live keys on the same Memex.
    const mk = async (name: string) => {
      const r = await authedRequest(base, bearer, {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      return (await r.json()) as { id: string; key: string };
    };
    const victim = await mk("to-revoke");
    const survivor = await mk("stays-live");

    // Both verify before revoke.
    expect(await verifyEmissionKey(victim.key)).toBeTruthy();
    expect(await verifyEmissionKey(survivor.key)).toBeTruthy();

    const res = await authedRequest(`${base}/${victim.id}/revoke`, bearer, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; revokedAt: string | null };
    expect(body.id).toBe(victim.id);
    expect(body.revokedAt).not.toBeNull();

    // Row is NOT deleted — it still appears in the list, now marked revoked.
    const listRes = await authedRequest(base, bearer, { method: "GET" });
    const rows = (await listRes.json()) as Array<{ id: string; revokedAt: string | null }>;
    const stillThere = rows.find((r) => r.id === victim.id);
    expect(stillThere, "revoked row must remain in the list").toBeTruthy();
    expect(stillThere!.revokedAt).not.toBeNull();

    // The revoked key no longer verifies; the sibling still does.
    expect(await verifyEmissionKey(victim.key)).toBeNull();
    expect(await verifyEmissionKey(survivor.key)).toBeTruthy();
  });

  it("rejects unauthenticated callers (no key minted)", async () => {
    const res = await app.request(base, {
      method: "POST",
      headers: { Host: "memex.ai", "Content-Type": "application/json" },
      body: JSON.stringify({ name: "should not work" }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});
