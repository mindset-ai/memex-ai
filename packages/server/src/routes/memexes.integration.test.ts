// Integration tests for /api/:namespace/:memex/memexes/* (spec-111 t-5).
//
// Covers the visibility PATCH route (owner/admin gated, routes through mutate()
// + bus) and the canReadMemex-gated GET read route:
//
//   ac-4 — owner toggles visibility, takes effect immediately (PATCH flips it,
//          the very next GET reflects the new value).
//   ac-5 — private memex → 404 for non-members AND anonymous on read routes
//          (std-7, indistinguishable from non-existent).
//
// These hit a REAL Postgres through the full Hono app + middleware stack, so we
// exercise memexResolver → publicSessionMiddleware/sessionMiddleware → adminGate
// → canReadMemex end-to-end.

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { inArray } from "drizzle-orm";

vi.hoisted(() => {
  // Force auth-mode session middleware so per-user Bearer tokens are honored.
  // Without this, dev-mode would resolve every request to dev@memex.ai and the
  // anonymous / non-member cases below would silently authenticate.
  process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
  process.env.AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET ?? "x".repeat(48);
  return undefined;
});

import { db } from "../db/connection.js";
import { app } from "../app.js";
import { and, eq } from "drizzle-orm";
import { namespaces, memexes, users, userMemexAccess } from "../db/schema.js";
import { signSessionToken } from "../services/auth-jwt.js";
import { ensureUserNamespace } from "../services/user-namespaces.js";
import { createOrgForUser } from "../services/orgs.js";
import { tagAc } from "@memex-ai-ac/vitest";

const AC_4 = "mindset-prod/memex-building-itself/specs/spec-111/acs/ac-4";
const AC_5 = "mindset-prod/memex-building-itself/specs/spec-111/acs/ac-5";
const AC_6 = "mindset-prod/memex-building-itself/specs/spec-111/acs/ac-6";
// spec-111 t-6 wiring (ac-9): the GET read path pins a public Memex onto a
// signed-in non-member's account via recordPublicMemexVisit.
const AC_9 = "mindset-prod/memex-building-itself/specs/spec-111/acs/ac-9";

async function pinRowCount(userId: string, memexId: string): Promise<number> {
  const rows = await db
    .select({ memexId: userMemexAccess.memexId })
    .from(userMemexAccess)
    .where(
      and(eq(userMemexAccess.userId, userId), eq(userMemexAccess.memexId, memexId)),
    );
  return rows.length;
}

const createdUserIds: string[] = [];
const createdNamespaceIds: string[] = [];

afterAll(async () => {
  if (createdUserIds.length) {
    await db.delete(users).where(inArray(users.id, createdUserIds)).catch(() => {});
  }
  if (createdNamespaceIds.length) {
    // Deleting a namespace cascades to org / memex / membership rows.
    await db
      .delete(namespaces)
      .where(inArray(namespaces.id, createdNamespaceIds))
      .catch(() => {});
  }
});

beforeEach(() => {
  if (!process.env.GOOGLE_CLIENT_ID) {
    process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
  }
});

async function seedUser(): Promise<{ userId: string; bearer: string }> {
  const email = `memexroute-${crypto.randomUUID()}@example.com`;
  const [user] = await db
    .insert(users)
    .values({ email, emailVerifiedAt: new Date() } as typeof users.$inferInsert)
    .returning();
  await ensureUserNamespace(user.id);
  createdUserIds.push(user.id);
  return { userId: user.id, bearer: signSessionToken(user.id) };
}

// Creates an org (owner = administrator) plus one memex inside it (default
// 'private'). Returns the slugs needed to build the tenant URL + the memex id.
async function seedOrgWithMemex(): Promise<{
  ownerBearer: string;
  nsSlug: string;
  memexSlug: string;
  memexId: string;
}> {
  const owner = await seedUser();
  const created = await createOrgForUser({
    slug: `mxvis-${owner.userId.slice(0, 6)}`,
    name: "Visibility Co",
    userId: owner.userId,
  });
  createdNamespaceIds.push(created.namespace.id);

  const [memex] = await db
    .insert(memexes)
    .values({ namespaceId: created.namespace.id, slug: "specs", name: "Specs" })
    .returning();

  return {
    ownerBearer: owner.bearer,
    nsSlug: created.namespace.slug,
    memexSlug: memex.slug,
    memexId: memex.id,
  };
}

function req(
  path: string,
  init: RequestInit & { bearer?: string } = {},
): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  if (init.bearer) headers.set("Authorization", `Bearer ${init.bearer}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  headers.set("Host", "memex.ai");
  return Promise.resolve(app.request(path, { ...init, headers }));
}

describe("PATCH /api/:ns/:mx/memexes/:id — visibility flip (ac-4)", () => {
  it("owner flips a private memex to public and the next read reflects it immediately", async () => {
    tagAc(AC_4);
    const { ownerBearer, nsSlug, memexSlug, memexId } = await seedOrgWithMemex();
    const base = `/api/${nsSlug}/${memexSlug}/memexes/${memexId}`;

    // Baseline: owner reads it, it's private.
    const before = await req(base, { method: "GET", bearer: ownerBearer });
    expect(before.status).toBe(200);
    expect((await before.json()).memex.visibility).toBe("private");

    // Owner (administrator) flips it to public.
    const patch = await req(base, {
      method: "PATCH",
      bearer: ownerBearer,
      body: JSON.stringify({ visibility: "public" }),
    });
    expect(patch.status).toBe(200);
    expect((await patch.json()).memex.visibility).toBe("public");

    // The very next read reflects the new value — no caching between write and read.
    const after = await req(base, { method: "GET", bearer: ownerBearer });
    expect(after.status).toBe(200);
    expect((await after.json()).memex.visibility).toBe("public");

    // And it persisted to the row.
    const row = await db.query.memexes.findFirst({
      where: (m, { eq }) => eq(m.id, memexId),
    });
    expect(row?.visibility).toBe("public");
  });

  it("flip back to private also takes effect on the next read", async () => {
    tagAc(AC_4);
    const { ownerBearer, nsSlug, memexSlug, memexId } = await seedOrgWithMemex();
    const base = `/api/${nsSlug}/${memexSlug}/memexes/${memexId}`;

    await req(base, {
      method: "PATCH",
      bearer: ownerBearer,
      body: JSON.stringify({ visibility: "public" }),
    });
    const toPrivate = await req(base, {
      method: "PATCH",
      bearer: ownerBearer,
      body: JSON.stringify({ visibility: "private" }),
    });
    expect(toPrivate.status).toBe(200);
    expect((await toPrivate.json()).memex.visibility).toBe("private");

    const after = await req(base, { method: "GET", bearer: ownerBearer });
    expect((await after.json()).memex.visibility).toBe("private");
  });

  it("rejects an invalid visibility value with 400", async () => {
    tagAc(AC_4);
    const { ownerBearer, nsSlug, memexSlug, memexId } = await seedOrgWithMemex();
    const res = await req(`/api/${nsSlug}/${memexSlug}/memexes/${memexId}`, {
      method: "PATCH",
      bearer: ownerBearer,
      body: JSON.stringify({ visibility: "secret" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a non-admin (non-member) PATCH", async () => {
    tagAc(AC_4);
    const { nsSlug, memexSlug, memexId } = await seedOrgWithMemex();
    const stranger = await seedUser();
    // A token-bearing non-member on a private path memex: sessionMiddleware
    // resolves the user but no membership, so adminGate sees no currentMemexId →
    // 400/403/404 (never a successful write). The point: it does NOT flip.
    const res = await req(`/api/${nsSlug}/${memexSlug}/memexes/${memexId}`, {
      method: "PATCH",
      bearer: stranger.bearer,
      body: JSON.stringify({ visibility: "public" }),
    });
    expect(res.status).not.toBe(200);
    const row = await db.query.memexes.findFirst({
      where: (m, { eq }) => eq(m.id, memexId),
    });
    expect(row?.visibility).toBe("private");
  });
});

describe("GET /api/:ns/:mx/memexes/:id — private → 404 for non-members (ac-5)", () => {
  it("returns 404 to an anonymous caller on a private memex (std-7)", async () => {
    tagAc(AC_5);
    const { nsSlug, memexSlug, memexId } = await seedOrgWithMemex();
    // No Authorization header — truly anonymous. Private memex → 404, identical
    // to a non-existent one (no enumeration leak).
    const res = await req(`/api/${nsSlug}/${memexSlug}/memexes/${memexId}`, {
      method: "GET",
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 to a signed-in NON-member on a private memex (std-7)", async () => {
    tagAc(AC_5);
    const { nsSlug, memexSlug, memexId } = await seedOrgWithMemex();
    const stranger = await seedUser();
    const res = await req(`/api/${nsSlug}/${memexSlug}/memexes/${memexId}`, {
      method: "GET",
      bearer: stranger.bearer,
    });
    expect(res.status).toBe(404);
  });

  it("after the owner flips to public, the SAME anonymous read now succeeds (read-only)", async () => {
    tagAc(AC_5);
    const { ownerBearer, nsSlug, memexSlug, memexId } = await seedOrgWithMemex();
    const base = `/api/${nsSlug}/${memexSlug}/memexes/${memexId}`;

    // Private: anonymous 404.
    expect((await req(base, { method: "GET" })).status).toBe(404);

    // Owner flips to public.
    await req(base, {
      method: "PATCH",
      bearer: ownerBearer,
      body: JSON.stringify({ visibility: "public" }),
    });

    // Same anonymous read now succeeds and shows the public visibility.
    const anon = await req(base, { method: "GET" });
    expect(anon.status).toBe(200);
    expect((await anon.json()).memex.visibility).toBe("public");
  });
});

describe("GET /api/:ns/:mx/memexes — slug-based readability probe (TenantLayout)", () => {
  // The React UI hits this (no :id — anonymous clients don't know the UUID) to
  // decide public-shell vs bounce-to-login for a visitor with no session.
  it("returns 404 to an anonymous caller on a private memex (std-7)", async () => {
    tagAc(AC_5);
    const { nsSlug, memexSlug } = await seedOrgWithMemex();
    const res = await req(`/api/${nsSlug}/${memexSlug}/memexes`, { method: "GET" });
    expect(res.status).toBe(404);
  });

  it("returns 404 to a signed-in NON-member on a private memex (std-7)", async () => {
    tagAc(AC_5);
    const { nsSlug, memexSlug } = await seedOrgWithMemex();
    const stranger = await seedUser();
    const res = await req(`/api/${nsSlug}/${memexSlug}/memexes`, {
      method: "GET",
      bearer: stranger.bearer,
    });
    expect(res.status).toBe(404);
  });

  it("returns 200 to an org member on their own (private) memex", async () => {
    tagAc(AC_5);
    const { ownerBearer, nsSlug, memexSlug } = await seedOrgWithMemex();
    const res = await req(`/api/${nsSlug}/${memexSlug}/memexes`, {
      method: "GET",
      bearer: ownerBearer,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).memex.visibility).toBe("private");
  });

  it("returns 200 + visibility to an ANONYMOUS caller once the memex is public (ac-6)", async () => {
    tagAc(AC_6);
    const { ownerBearer, nsSlug, memexSlug, memexId } = await seedOrgWithMemex();
    const probe = `/api/${nsSlug}/${memexSlug}/memexes`;

    // Private → anonymous probe 404 (bounce-to-login path).
    expect((await req(probe, { method: "GET" })).status).toBe(404);

    // Owner flips to public.
    await req(`/api/${nsSlug}/${memexSlug}/memexes/${memexId}`, {
      method: "PATCH",
      bearer: ownerBearer,
      body: JSON.stringify({ visibility: "public" }),
    });

    // Same anonymous probe now succeeds (public-shell path).
    const res = await req(probe, { method: "GET" });
    expect(res.status).toBe(200);
    expect((await res.json()).memex.visibility).toBe("public");
  });
});

describe("GET /api/:ns/:mx/memexes/:id — insert-on-visit pins public Memex (ac-9)", () => {
  it("pins the public Memex for a signed-in NON-member on read", async () => {
    tagAc(AC_9);
    const { ownerBearer, nsSlug, memexSlug, memexId } = await seedOrgWithMemex();
    const base = `/api/${nsSlug}/${memexSlug}/memexes/${memexId}`;

    // Make it public so a non-member can read it.
    await req(base, {
      method: "PATCH",
      bearer: ownerBearer,
      body: JSON.stringify({ visibility: "public" }),
    });

    const stranger = await seedUser();
    // No pin before the visit.
    expect(await pinRowCount(stranger.userId, memexId)).toBe(0);

    const res = await req(base, { method: "GET", bearer: stranger.bearer });
    expect(res.status).toBe(200);

    // The read recorded exactly one user_memex_access pin (read-only).
    expect(await pinRowCount(stranger.userId, memexId)).toBe(1);
    const [row] = await db
      .select()
      .from(userMemexAccess)
      .where(
        and(
          eq(userMemexAccess.userId, stranger.userId),
          eq(userMemexAccess.memexId, memexId),
        ),
      );
    expect(row.accessLevel).toBe("read");

    // A repeat read does not duplicate the pin (idempotent).
    await req(base, { method: "GET", bearer: stranger.bearer });
    expect(await pinRowCount(stranger.userId, memexId)).toBe(1);
  });

  it("does NOT pin for an anonymous reader of a public Memex", async () => {
    tagAc(AC_9);
    const { ownerBearer, nsSlug, memexSlug, memexId } = await seedOrgWithMemex();
    const base = `/api/${nsSlug}/${memexSlug}/memexes/${memexId}`;
    await req(base, {
      method: "PATCH",
      bearer: ownerBearer,
      body: JSON.stringify({ visibility: "public" }),
    });

    // Anonymous read succeeds but cannot pin (no user). No userMemexAccess rows
    // should reference this memex from an anonymous read.
    const res = await req(base, { method: "GET" });
    expect(res.status).toBe(200);
    const rows = await db
      .select({ memexId: userMemexAccess.memexId })
      .from(userMemexAccess)
      .where(eq(userMemexAccess.memexId, memexId));
    expect(rows).toHaveLength(0);
  });

  it("does NOT create a visited pin for an org MEMBER reading their own public Memex", async () => {
    tagAc(AC_9);
    const { ownerBearer, nsSlug, memexSlug, memexId } = await seedOrgWithMemex();
    const base = `/api/${nsSlug}/${memexSlug}/memexes/${memexId}`;
    await req(base, {
      method: "PATCH",
      bearer: ownerBearer,
      body: JSON.stringify({ visibility: "public" }),
    });

    // The owner is an org member (administrator). Reading their own public Memex
    // must NOT create a redundant read-only pin — canWriteMemex gates it out.
    const res = await req(base, { method: "GET", bearer: ownerBearer });
    expect(res.status).toBe(200);
    const rows = await db
      .select({ memexId: userMemexAccess.memexId })
      .from(userMemexAccess)
      .where(eq(userMemexAccess.memexId, memexId));
    expect(rows).toHaveLength(0);
  });
});
