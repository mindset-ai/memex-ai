// spec-371 — the hook-key mint must accept the credential the CLI installer
// actually holds. The plugin's device flow authenticates the user and yields an
// mxt_ MCP token (mintMcpToken), NOT a web-session JWT. The mint route originally
// ran the JWT-only sessionMiddleware, so checkout-setup's mxt_ bounced with a 401
// ("Invalid or expired token") and a key could never be planted. The unit test
// mocked fetch, so the auth mismatch only surfaced against the live int deploy.
//
// This exercises the REAL assembled app + DB through /api/:ns/:memex/hook-keys and
// pins the dec-6 boundary it sits on (ac-14): the mxt_ PAT only AUTHENTICATES the
// mint; the credential we PLANT is still a least-privilege mxh_. It also proves the
// opt-in is CONTAINED — a PAT still can't drive a sibling JWT-only session route.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { app } from "../app.js";
import { users, memexHookKeys, orgMemberships } from "../db/schema.js";
import { signSessionToken } from "../services/auth-jwt.js";
import { mintMcpToken } from "../services/mcp-tokens.js";
import { createOrgWithMemexAndOwner } from "../services/__test__/seed-org.js";

// ac-14 — the hook key is a least-privilege mxh_, never the user's mxt_/OAuth.
const AC_14 = "mindset-prod/memex-building-itself/specs/spec-371/acs/ac-14";

const createdUserIds: string[] = [];
const createdMemexIds: string[] = [];

afterAll(async () => {
  if (createdMemexIds.length) {
    await db
      .delete(memexHookKeys)
      .where(inArray(memexHookKeys.memexId, createdMemexIds))
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
      email: `hookkey-auth-${crypto.randomUUID()}@example.com`,
      emailVerifiedAt: new Date(),
    } as typeof users.$inferInsert)
    .returning();
  createdUserIds.push(u.id);
  return u.id;
}

async function authed(
  path: string,
  bearer: string | null,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  if (bearer) headers.set("Authorization", `Bearer ${bearer}`);
  headers.set("Host", "memex.ai");
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return app.request(path, { ...init, headers });
}

describe("hook-key mint accepts the device-flow mxt_ token (spec-371 ac-14)", () => {
  beforeEach(() => {
    if (!process.env.GOOGLE_CLIENT_ID) {
      process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
    }
  });

  let ownerUserId: string;
  let ownerMxt: string; // a real mxt_ PAT for the owner (what the device flow yields)
  let ownerJwt: string; // a real web-session JWT for the owner (the control)
  let memexId: string;
  let hookKeysBase: string;
  let emissionKeysBase: string;

  const mint = async (base: string, bearer: string | null, name = "checkout hook") => {
    const res = await authed(base, bearer, {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { res, body };
  };

  beforeAll(async () => {
    ownerUserId = await seedUser();
    ownerJwt = signSessionToken(ownerUserId);
    const { raw } = await mintMcpToken(ownerUserId, "test device");
    ownerMxt = raw;

    const seeded = await createOrgWithMemexAndOwner({
      slug: `hk-auth-${Date.now().toString(36)}`,
      ownerUserId,
    });
    memexId = seeded.memex.id;
    createdMemexIds.push(memexId);
    hookKeysBase = `/api/${seeded.namespace.slug}/${seeded.memex.slug}/hook-keys`;
    emissionKeysBase = `/api/${seeded.namespace.slug}/${seeded.memex.slug}/emission-keys`;
  });

  it("THE FIX — a valid mxt_ PAT mints a key; the PLANTED credential is a least-privilege mxh_ (ac-14)", async () => {
    tagAc(AC_14);
    const { res, body } = await mint(hookKeysBase, ownerMxt);
    expect(res.status).toBe(201);
    // dec-6: the mxt_ only AUTHENTICATES; what we hand back is the scoped mxh_.
    expect(typeof body.key).toBe("string");
    expect(body.key as string).toMatch(/^mxh_/);
    expect(body.key as string).not.toMatch(/^mxt_/);
    expect(body.createdByUserId).toBe(ownerUserId);

    // The mint persisted a real row for this memex, owned by the PAT's user.
    const row = await db.query.memexHookKeys.findFirst({
      where: eq(memexHookKeys.id, body.id as string),
    });
    expect(row?.memexId).toBe(memexId);
    expect(row?.createdByUserId).toBe(ownerUserId);
  });

  it("REGRESSION GUARD — a web-session JWT still mints (the original path is unchanged)", async () => {
    tagAc(AC_14);
    const { res, body } = await mint(hookKeysBase, ownerJwt);
    expect(res.status).toBe(201);
    expect(body.key as string).toMatch(/^mxh_/);
  });

  it("no Authorization header → 401 (strict session unchanged)", async () => {
    tagAc(AC_14);
    const { res } = await mint(hookKeysBase, null);
    expect(res.status).toBe(401);
  });

  it("an invalid mxt_-shaped bearer is NOT silently accepted → 401", async () => {
    tagAc(AC_14);
    const { res } = await mint(hookKeysBase, "mxt_not-a-real-token-deadbeef");
    expect(res.status).toBe(401);
  });

  it("a valid mxt_ for a NON-MEMBER cannot mint — membership is still enforced → 404 (std-7)", async () => {
    tagAc(AC_14);
    const strangerId = await seedUser();
    const { raw: strangerMxt } = await mintMcpToken(strangerId, "stranger device");
    const { res } = await mint(hookKeysBase, strangerMxt);
    expect(res.status).toBe(404);
    // Belt-and-braces: no membership was created as a side effect.
    const membership = await db.query.orgMemberships.findFirst({
      where: eq(orgMemberships.userId, strangerId),
    });
    expect(membership).toBeUndefined();
  });

  it("CONTAINMENT — the same mxt_ PAT still does NOT authorise a sibling JWT-only route (emission-keys) → 401", async () => {
    tagAc(AC_14);
    // emission-keys uses plain sessionMiddleware; the opt-in must not leak there.
    const { res } = await mint(emissionKeysBase, ownerMxt);
    expect(res.status).toBe(401);
  });
});
