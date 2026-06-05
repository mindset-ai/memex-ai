// Integration tests for /api/namespaces/:namespaceId/* (doc-19 t-4, t-5, t-6).
// Covers the home payload (org + personal variants), Memex creation, and the
// per-namespace slug-availability check.

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";

vi.hoisted(() => {
  // Force auth-mode session middleware so per-user Bearer tokens are honored.
  // Without this, dev-mode would resolve every request to dev@memex.ai.
  process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
  process.env.AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET ?? "x".repeat(48);
  return undefined;
});

import { db } from "../db/connection.js";
import { app } from "../app.js";
import {
  namespaces,
  orgs,
  memexes,
  orgMemberships,
  users,
} from "../db/schema.js";
import { signSessionToken } from "../services/auth-jwt.js";
import { ensureUserNamespace } from "../services/user-namespaces.js";
import { createOrgForUser } from "../services/orgs.js";

const createdUserIds: string[] = [];
const createdNamespaceIds: string[] = [];

afterAll(async () => {
  if (createdUserIds.length) {
    await db.delete(users).where(inArray(users.id, createdUserIds)).catch(() => {});
  }
  if (createdNamespaceIds.length) {
    // Deleting namespace cascades to org / memex / membership rows.
    await db.delete(namespaces).where(inArray(namespaces.id, createdNamespaceIds)).catch(() => {});
  }
});

async function seedUser(): Promise<{ userId: string; bearer: string; email: string }> {
  const email = `nsroute-${crypto.randomUUID()}@example.com`;
  const [user] = await db
    .insert(users)
    .values({ email, emailVerifiedAt: new Date() } as typeof users.$inferInsert)
    .returning();
  await ensureUserNamespace(user.id);
  createdUserIds.push(user.id);
  return { userId: user.id, bearer: signSessionToken(user.id), email };
}

async function authedRequest(path: string, init: RequestInit, bearer: string): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  headers.set("Authorization", `Bearer ${bearer}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  headers.set("Host", "memex.ai");
  return app.request(path, { ...init, headers });
}

beforeEach(() => {
  // Defensive: another suite may have toggled this off. Auth mode is required
  // for these tests so each user's JWT routes to their own session.
  if (!process.env.GOOGLE_CLIENT_ID) {
    process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
  }
});

describe("GET /api/namespaces/:namespaceId/home", () => {
  it("returns the org variant with member count + sorted memex list", async () => {
    const owner = await seedUser();
    const created = await createOrgForUser({
      slug: `nshome-${owner.userId.slice(0, 6)}`,
      name: "Home Co",
      userId: owner.userId,
    });
    createdNamespaceIds.push(created.namespace.id);

    // Insert two memexes manually so we can assert alphabetical ordering.
    await db.insert(memexes).values([
      { namespaceId: created.namespace.id, slug: "beta", name: "Beta" },
      { namespaceId: created.namespace.id, slug: "alpha", name: "Alpha" },
    ]);

    const res = await authedRequest(
      `/api/namespaces/${created.namespace.id}/home`,
      { method: "GET" },
      owner.bearer,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kind).toBe("org");
    expect(body.org.id).toBe(created.org.id);
    expect(body.org.slug).toBe(created.namespace.slug);
    expect(body.memberCount).toBe(1);
    expect(body.currentRole).toBe("administrator");
    expect(body.memexes.map((m: { slug: string }) => m.slug)).toEqual(["alpha", "beta"]);
  });

  it("returns the personal variant for the owner of a personal namespace", async () => {
    const owner = await seedUser();
    const personalNs = await db.query.namespaces.findFirst({
      where: eq(namespaces.ownerUserId, owner.userId),
    });
    expect(personalNs).toBeTruthy();

    const res = await authedRequest(
      `/api/namespaces/${personalNs!.id}/home`,
      { method: "GET" },
      owner.bearer,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kind).toBe("personal");
    expect(body.memex).toBeTruthy();
    expect(body.memex.slug).toBe("personal");
  });

  it("returns 404 for a non-member of an org namespace (std-7: no enumeration leak)", async () => {
    const owner = await seedUser();
    const stranger = await seedUser();
    const created = await createOrgForUser({
      slug: `nshome2-${owner.userId.slice(0, 6)}`,
      name: "Private",
      userId: owner.userId,
    });
    createdNamespaceIds.push(created.namespace.id);

    const res = await authedRequest(
      `/api/namespaces/${created.namespace.id}/home`,
      { method: "GET" },
      stranger.bearer,
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Namespace not found");
  });

  it("returns 404 for an unknown namespaceId", async () => {
    const owner = await seedUser();
    const res = await authedRequest(
      `/api/namespaces/00000000-0000-0000-0000-000000000000/home`,
      { method: "GET" },
      owner.bearer,
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /api/namespaces/:namespaceId/memexes", () => {
  it("creates a memex (201) for an active member", async () => {
    const owner = await seedUser();
    const created = await createOrgForUser({
      slug: `nsmx-${owner.userId.slice(0, 6)}`,
      name: "MX Org",
      userId: owner.userId,
    });
    createdNamespaceIds.push(created.namespace.id);

    const res = await authedRequest(
      `/api/namespaces/${created.namespace.id}/memexes`,
      { method: "POST", body: JSON.stringify({ slug: "first" }) },
      owner.bearer,
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.memex.slug).toBe("first");
    // Default name: titlecased slug
    expect(body.memex.name).toBe("First");
    expect(body.memex.namespaceId).toBe(created.namespace.id);
  });

  it("returns 403 (kind_not_org) for a personal namespace", async () => {
    const owner = await seedUser();
    const personalNs = await db.query.namespaces.findFirst({
      where: eq(namespaces.ownerUserId, owner.userId),
    });
    const res = await authedRequest(
      `/api/namespaces/${personalNs!.id}/memexes`,
      { method: "POST", body: JSON.stringify({ slug: "sibling" }) },
      owner.bearer,
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("kind_not_org");
  });

  it("returns 404 for a non-member of the org (std-7: no enumeration leak)", async () => {
    const owner = await seedUser();
    const stranger = await seedUser();
    const created = await createOrgForUser({
      slug: `nsmx2-${owner.userId.slice(0, 6)}`,
      name: "Block",
      userId: owner.userId,
    });
    createdNamespaceIds.push(created.namespace.id);

    const res = await authedRequest(
      `/api/namespaces/${created.namespace.id}/memexes`,
      { method: "POST", body: JSON.stringify({ slug: "intruder" }) },
      stranger.bearer,
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Namespace not found");
  });

  it("returns 409 (slug_taken) when slug already exists in the namespace", async () => {
    const owner = await seedUser();
    const created = await createOrgForUser({
      slug: `nsmx3-${owner.userId.slice(0, 6)}`,
      name: "Dup",
      userId: owner.userId,
    });
    createdNamespaceIds.push(created.namespace.id);

    await db.insert(memexes).values({
      namespaceId: created.namespace.id,
      slug: "taken",
      name: "Taken",
    });

    const res = await authedRequest(
      `/api/namespaces/${created.namespace.id}/memexes`,
      { method: "POST", body: JSON.stringify({ slug: "taken" }) },
      owner.bearer,
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("slug_taken");
  });

  it("returns 400 (validation_error) for an invalid slug", async () => {
    const owner = await seedUser();
    const created = await createOrgForUser({
      slug: `nsmx4-${owner.userId.slice(0, 6)}`,
      name: "Inv",
      userId: owner.userId,
    });
    createdNamespaceIds.push(created.namespace.id);

    const res = await authedRequest(
      `/api/namespaces/${created.namespace.id}/memexes`,
      { method: "POST", body: JSON.stringify({ slug: "INVALID SLUG" }) },
      owner.bearer,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("validation_error");
  });
});

describe("GET /api/namespaces/:namespaceId/memexes/check", () => {
  it("returns { available: true } for an unused valid slug", async () => {
    const owner = await seedUser();
    const created = await createOrgForUser({
      slug: `nschk-${owner.userId.slice(0, 6)}`,
      name: "Check",
      userId: owner.userId,
    });
    createdNamespaceIds.push(created.namespace.id);

    const res = await authedRequest(
      `/api/namespaces/${created.namespace.id}/memexes/check?slug=freeagent`,
      { method: "GET" },
      owner.bearer,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ available: true });
  });

  it("returns { available: false, reason: 'taken' } for an existing slug", async () => {
    const owner = await seedUser();
    const created = await createOrgForUser({
      slug: `nschk2-${owner.userId.slice(0, 6)}`,
      name: "Check",
      userId: owner.userId,
    });
    createdNamespaceIds.push(created.namespace.id);
    await db.insert(memexes).values({
      namespaceId: created.namespace.id,
      slug: "exists",
      name: "Exists",
    });

    const res = await authedRequest(
      `/api/namespaces/${created.namespace.id}/memexes/check?slug=exists`,
      { method: "GET" },
      owner.bearer,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ available: false, reason: "taken" });
  });

  it("returns { available: false, reason: 'invalid_chars' } for a malformed slug", async () => {
    const owner = await seedUser();
    const created = await createOrgForUser({
      slug: `nschk3-${owner.userId.slice(0, 6)}`,
      name: "Bad",
      userId: owner.userId,
    });
    createdNamespaceIds.push(created.namespace.id);

    const res = await authedRequest(
      `/api/namespaces/${created.namespace.id}/memexes/check?slug=BAD%20SLUG`,
      { method: "GET" },
      owner.bearer,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.available).toBe(false);
    expect(body.reason).toBe("invalid_chars");
  });

  it("returns 404 for non-members of the org namespace (std-7: no enumeration leak)", async () => {
    const owner = await seedUser();
    const stranger = await seedUser();
    const created = await createOrgForUser({
      slug: `nschk4-${owner.userId.slice(0, 6)}`,
      name: "Private",
      userId: owner.userId,
    });
    createdNamespaceIds.push(created.namespace.id);

    const res = await authedRequest(
      `/api/namespaces/${created.namespace.id}/memexes/check?slug=any`,
      { method: "GET" },
      stranger.bearer,
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Namespace not found");
  });
});

// Silence unused-import warning
void orgs;
void orgMemberships;
