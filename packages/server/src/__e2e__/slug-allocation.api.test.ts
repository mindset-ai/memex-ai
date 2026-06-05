// t-1 of doc-15 — slug-allocation spec for std-3.
//
// API portion of the e2e suite (Playwright covers signup-flow UI).
// No mocks — real Postgres, real Hono app instance, real services.
//
// Scenarios covered (from §8 of doc-15):
//   - Reserved slug rejected at org creation (login, api, mcp, install, settings, ...)
//   - Verified-email user creates org with valid slug → 201
//   - Unverified-email user attempts org creation → 403
//   - 6th org creation by same user inside 24h → 429 rate-limit
//   - Slug rename within cooldown window rejected → 429
//   - Previous slug held in reservation for 30 days post-rename
//   - Slug rename succeeds after cooldown elapses
//
// Setup: each test gets a fresh user + verified email so rate-limit windows
// don't bleed across tests.

import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../db/connection.js";
import { app } from "../app.js";
import {
  namespaces,
  namespaceSlugReservations,
  orgConsentResponses,
  orgMemberships,
  orgs,
  users,
  verifiedDomains,
} from "../db/schema.js";
import { eq } from "drizzle-orm";
import { signSessionToken } from "../services/auth-jwt.js";
import { ensureUserNamespace } from "../services/user-namespaces.js";

async function seedUser(opts: { verified: boolean }): Promise<{ userId: string; bearer: string }> {
  const email = `test-${crypto.randomUUID()}@example.com`;
  const [user] = await db
    .insert(users)
    .values({
      email,
      emailVerifiedAt: opts.verified ? new Date() : null,
      namespaceId: undefined as unknown as string, // populated by ensureUserNamespace
    } as typeof users.$inferInsert)
    .returning();
  await ensureUserNamespace(user.id);
  const refreshed = await db.query.users.findFirst({ where: eq(users.id, user.id) });
  // Mint a session token so the route's session middleware accepts the call
  // (when GOOGLE_CLIENT_ID is set; in dev mode the session middleware uses
  // the dev user instead — tests run with GOOGLE_CLIENT_ID set).
  const bearer = signSessionToken(refreshed!.id);
  return { userId: refreshed!.id, bearer };
}

async function cleanupUser(userId: string) {
  // CASCADE on users.id will reach org_memberships, org_consent_responses,
  // namespaces (via ownerUserId), and namespace_slug_reservations
  // (via releasedNamespaceId set null). Just delete the user.
  await db.delete(users).where(eq(users.id, userId));
}

async function authedRequest(path: string, init: RequestInit, bearer: string): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  headers.set("Authorization", `Bearer ${bearer}`);
  // Without an explicit Host the hostGuard middleware (memex-resolver.ts)
  // returns 404 on unknown hosts. Pin to memex.ai for tests.
  headers.set("Host", "memex.ai");
  if (!headers.has("Content-Type") && init.body) {
    headers.set("Content-Type", "application/json");
  }
  return await app.request(path, { ...init, headers });
}

describe("slug-allocation [std-3] [t-1]", () => {
  // Pin GOOGLE_CLIENT_ID so session middleware takes the JWT path (not the
  // dev fallback that returns the same dev user every call).
  beforeEach(() => {
    if (!process.env.GOOGLE_CLIENT_ID) {
      process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
    }
  });

  describe("POST /api/orgs", () => {
    it("rejects reserved slugs (login, api, mcp, install, settings, ...)", async () => {
      const { userId, bearer } = await seedUser({ verified: true });
      try {
        for (const reserved of ["login", "api", "mcp", "install", "settings", "memex"]) {
          const res = await authedRequest(
            "/api/orgs",
            { method: "POST", body: JSON.stringify({ slug: reserved }) },
            bearer,
          );
          expect(res.status).toBe(400);
          const body = await res.json();
          expect(body.code).toBe("validation_error");
          expect(body.error).toMatch(/reserved/i);
        }
      } finally {
        await cleanupUser(userId);
      }
    });

    it("creates an org for a verified-email user with a valid slug", async () => {
      const { userId, bearer } = await seedUser({ verified: true });
      try {
        const slug = `acme-${Date.now().toString(36)}`;
        const res = await authedRequest(
          "/api/orgs",
          { method: "POST", body: JSON.stringify({ slug, name: "Acme Co" }) },
          bearer,
        );
        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body.org).toBeTruthy();
        expect(body.org.createdByUserId).toBe(userId);
        expect(body.namespace.slug).toBe(slug);
        // Per dec-1 of doc-19, Org creation inserts 0 Memexes — the response
        // shape no longer includes a `memex` field.
        expect(body.memex).toBeUndefined();

        // Caller becomes the first administrator.
        const memberships = await db
          .select()
          .from(orgMemberships)
          .where(eq(orgMemberships.userId, userId));
        const teamMembership = memberships.find((m) => m.orgId === body.org.id);
        expect(teamMembership?.role).toBe("administrator");
      } finally {
        await cleanupUser(userId);
      }
    });

    it("rejects org creation for unverified-email users (403)", async () => {
      const { userId, bearer } = await seedUser({ verified: false });
      try {
        const res = await authedRequest(
          "/api/orgs",
          { method: "POST", body: JSON.stringify({ slug: `noverify-${Date.now().toString(36)}` }) },
          bearer,
        );
        expect(res.status).toBe(403);
        const body = await res.json();
        expect(body.code).toBe("email_not_verified");
      } finally {
        await cleanupUser(userId);
      }
    });

    it("rate-limits the 6th org creation within 24h (429)", async () => {
      const { userId, bearer } = await seedUser({ verified: true });
      const created: string[] = [];
      try {
        // 5 should succeed.
        for (let i = 1; i <= 5; i += 1) {
          const slug = `ratelimit-${userId.slice(0, 6)}-${i}`;
          const res = await authedRequest(
            "/api/orgs",
            { method: "POST", body: JSON.stringify({ slug }) },
            bearer,
          );
          expect(res.status).toBe(201);
          const body = await res.json();
          created.push(body.org.id);
        }
        // 6th should 429.
        const res = await authedRequest(
          "/api/orgs",
          { method: "POST", body: JSON.stringify({ slug: `ratelimit-${userId.slice(0, 6)}-6` }) },
          bearer,
        );
        expect(res.status).toBe(429);
        const body = await res.json();
        expect(body.code).toBe("rate_limit_exceeded");
      } finally {
        await cleanupUser(userId);
      }
    });

    it("rejects duplicate slugs (409)", async () => {
      const { userId: u1, bearer: b1 } = await seedUser({ verified: true });
      const { userId: u2, bearer: b2 } = await seedUser({ verified: true });
      try {
        const slug = `dup-${Date.now().toString(36)}`;
        const a = await authedRequest("/api/orgs", { method: "POST", body: JSON.stringify({ slug }) }, b1);
        expect(a.status).toBe(201);

        const b = await authedRequest("/api/orgs", { method: "POST", body: JSON.stringify({ slug }) }, b2);
        expect(b.status).toBe(409);
        const body = await b.json();
        expect(body.code).toBe("slug_taken");
      } finally {
        await cleanupUser(u1);
        await cleanupUser(u2);
      }
    });
  });

  describe("PATCH /api/namespaces/:id/slug", () => {
    it("rejects rename within 30-day cooldown window (429)", async () => {
      const { userId, bearer } = await seedUser({ verified: true });
      try {
        const slug = `cool-${Date.now().toString(36)}`;
        const create = await authedRequest(
          "/api/orgs",
          { method: "POST", body: JSON.stringify({ slug }) },
          bearer,
        );
        const created = await create.json();
        const namespaceId = created.namespace.id;

        // Force a recent slugChangedAt so the cooldown gate trips.
        await db
          .update(namespaces)
          .set({ slugChangedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000) })
          .where(eq(namespaces.id, namespaceId));

        const newSlug = `${slug}-renamed`;
        const res = await authedRequest(
          `/api/namespaces/${namespaceId}/slug`,
          { method: "PATCH", body: JSON.stringify({ slug: newSlug }) },
          bearer,
        );
        expect(res.status).toBe(429);
        const body = await res.json();
        expect(body.code).toBe("cooldown_active");
      } finally {
        await cleanupUser(userId);
      }
    });

    it("renames after cooldown elapses and reserves the previous slug for 30 days", async () => {
      const { userId, bearer } = await seedUser({ verified: true });
      try {
        const oldSlug = `before-${Date.now().toString(36)}`;
        const create = await authedRequest(
          "/api/orgs",
          { method: "POST", body: JSON.stringify({ slug: oldSlug }) },
          bearer,
        );
        const created = await create.json();
        const namespaceId = created.namespace.id;

        // Backdate slugChangedAt past the cooldown so the rename succeeds.
        await db
          .update(namespaces)
          .set({ slugChangedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) })
          .where(eq(namespaces.id, namespaceId));

        const newSlug = `${oldSlug}-after`;
        const res = await authedRequest(
          `/api/namespaces/${namespaceId}/slug`,
          { method: "PATCH", body: JSON.stringify({ slug: newSlug }) },
          bearer,
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.namespace.slug).toBe(newSlug);

        // Previous slug must be in the reservation table for 30 days.
        const reserved = await db.query.namespaceSlugReservations.findFirst({
          where: eq(namespaceSlugReservations.slug, oldSlug),
        });
        expect(reserved).toBeTruthy();
        const msUntil = reserved!.reservedUntil.getTime() - Date.now();
        // Allow some slack — should be ~30 days.
        expect(msUntil).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
        expect(msUntil).toBeLessThan(31 * 24 * 60 * 60 * 1000);

        // Squatter attempt: another user trying to grab the just-released slug
        // should get 409 because the reservation is active.
        const { userId: squatter, bearer: squatterBearer } = await seedUser({ verified: true });
        try {
          const grab = await authedRequest(
            "/api/orgs",
            { method: "POST", body: JSON.stringify({ slug: oldSlug }) },
            squatterBearer,
          );
          expect(grab.status).toBe(409);
          const grabBody = await grab.json();
          expect(grabBody.code).toBe("slug_taken");
        } finally {
          await cleanupUser(squatter);
        }
      } finally {
        await cleanupUser(userId);
      }
    });
  });

  describe("GET /api/namespaces/check", () => {
    it("returns available=false for reserved slugs", async () => {
      const { userId, bearer } = await seedUser({ verified: true });
      try {
        const res = await authedRequest("/api/namespaces/check?slug=login", { method: "GET" }, bearer);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.available).toBe(false);
        expect(body.reason).toBe("reserved");
      } finally {
        await cleanupUser(userId);
      }
    });

    it("returns available=true for a free slug", async () => {
      const { userId, bearer } = await seedUser({ verified: true });
      try {
        const slug = `free-${Date.now().toString(36)}`;
        const res = await authedRequest(`/api/namespaces/check?slug=${slug}`, { method: "GET" }, bearer);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.available).toBe(true);
      } finally {
        await cleanupUser(userId);
      }
    });
  });
});
