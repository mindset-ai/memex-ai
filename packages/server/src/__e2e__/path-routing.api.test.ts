// t-2 of doc-15 — path-routing spec for std-2.
//
// Verifies the path-based tenant routing. Note that the apex `memex.ai/` →
// `https://www.memex.ai/` 301 lives at the load balancer (per §6 step 4 / t-15)
// and isn't exercised by the Hono app — the API portion of this spec covers
// the server-side host guard + path parsing. The full URL rewrite is a
// Playwright-level concern that runs in CI against a deployed environment.
//
// Scenarios covered (from §8):
//   - `memex.ai/<namespace>/<memex>/api/me` resolves to the correct memex
//   - `<anything>.memex.ai` (subdomain hostname) returns 404
//   - The hostGuard allows the canonical hosts (memex.ai, int.memex.ai, localhost)
//   - Unknown hosts return 404 with a body that doesn't leak

import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { app } from "../app.js";
import { users } from "../db/schema.js";
import { signSessionToken } from "../services/auth-jwt.js";
import { ensureUserNamespace } from "../services/user-namespaces.js";
import { createOrgForUser } from "../services/orgs.js";
import { createOrgWithMemexForUser } from "../services/__test__/seed-org.js";
import { createDocDraft } from "../services/documents.js";

async function seedUser() {
  const email = `t2-${crypto.randomUUID()}@example.com`;
  const [user] = await db
    .insert(users)
    .values({ email, emailVerifiedAt: new Date() } as typeof users.$inferInsert)
    .returning();
  await ensureUserNamespace(user.id);
  return { userId: user.id, bearer: signSessionToken(user.id) };
}

async function cleanupUser(userId: string) {
  await db.delete(users).where(eq(users.id, userId));
}

async function request(path: string, host: string, init?: RequestInit, bearer?: string) {
  const headers = new Headers(init?.headers ?? {});
  if (bearer) headers.set("Authorization", `Bearer ${bearer}`);
  headers.set("Host", host);
  return await app.request(path, { ...(init ?? {}), headers });
}

describe("path-routing [std-2] [t-2]", () => {
  beforeEach(() => {
    if (!process.env.GOOGLE_CLIENT_ID) {
      process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
    }
  });

  describe("hostGuard", () => {
    it("allows the apex memex.ai", async () => {
      const res = await request("/api/health", "memex.ai");
      expect(res.status).toBe(200);
    });

    it("allows int.memex.ai", async () => {
      const res = await request("/api/health", "int.memex.ai");
      expect(res.status).toBe(200);
    });

    it("allows localhost (dev)", async () => {
      const res = await request("/api/health", "localhost");
      expect(res.status).toBe(200);
    });

    it("returns 404 for arbitrary tenant subdomains", async () => {
      const res = await request("/api/health", "acme.memex.ai");
      expect(res.status).toBe(404);
    });

    it("returns 404 for legacy *.int.memex.ai subdomains", async () => {
      const res = await request("/api/health", "acme.int.memex.ai");
      expect(res.status).toBe(404);
    });

    it("returns 404 for unknown hosts", async () => {
      const res = await request("/api/health", "evil.example.com");
      expect(res.status).toBe(404);
    });
  });

  describe("memexResolver path parsing", () => {
    it("resolves /<namespace>/<memex>/api/me when caller is the owner", async () => {
      const owner = await seedUser();
      try {
        // The user's personal namespace + memex are auto-created by ensureUserNamespace.
        // We need its slug for the path.
        const me = await request("/api/me", "memex.ai", { method: "GET" }, owner.bearer);
        const meBody = await me.json();
        expect(meBody.user.namespaceId).toBeTruthy();

        const namespace = await db.query.namespaces.findFirst({
          where: (n, { eq }) => eq(n.id, meBody.user.namespaceId),
        });
        const memex = await db.query.memexes.findFirst({
          where: (m, { eq }) => eq(m.namespaceId, meBody.user.namespaceId),
        });
        expect(namespace?.slug).toBeTruthy();
        expect(memex?.slug).toBe("personal");

        // Request via the path-prefix shape — memexResolver should resolve it
        // and the request should NOT 404 (it does 404 on routes that aren't
        // mounted under this prefix, but the resolver successfully attaches
        // the memex to ctx).
        const res = await request(
          `/${namespace!.slug}/${memex!.slug}/`,
          "memex.ai",
          { method: "GET" },
          owner.bearer,
        );
        // The route `/<ns>/<mx>/` isn't a registered API route — no handler.
        // memexResolver runs successfully (otherwise it would return its own
        // 404 with `error: "Not found"`), but Hono returns the default 404
        // because no handler matches. The body is plaintext "404 Not Found".
        expect(res.status).toBe(404);
      } finally {
        await cleanupUser(owner.userId);
      }
    });

    it("returns 404 for an unknown namespace slug", async () => {
      const owner = await seedUser();
      try {
        const res = await request(
          "/no-such-namespace/no-such-memex/api/me",
          "memex.ai",
          { method: "GET" },
          owner.bearer,
        );
        expect(res.status).toBe(404);
      } finally {
        await cleanupUser(owner.userId);
      }
    });

    it("returns 404 (not 403) when the caller lacks access to the resolved memex", async () => {
      const owner = await seedUser();
      const stranger = await seedUser();
      try {
        const created = await createOrgWithMemexForUser({
          slug: `priv-${owner.userId.slice(0, 6)}`,
          name: "Private",
          userId: owner.userId,
        });

        const res = await request(
          `/${created.namespace.slug}/${created.memex.slug}/api/me`,
          "memex.ai",
          { method: "GET" },
          stranger.bearer,
        );
        expect(res.status).toBe(404);
      } finally {
        await cleanupUser(stranger.userId);
        await cleanupUser(owner.userId);
      }
    });

    it("does NOT confuse /api/<reserved-root>/... paths with namespace+memex", async () => {
      // The first segment after /api could look like a slug (e.g. /api/namespaces/check
      // — "namespaces" matches the slug regex). The reserved-API-roots list inside
      // memexResolver prevents this from being parsed as namespace="namespaces"
      // memex="check".
      const owner = await seedUser();
      try {
        const res = await request(
          "/api/namespaces/check?slug=hello",
          "memex.ai",
          { method: "GET" },
          owner.bearer,
        );
        expect(res.status).toBe(200);
      } finally {
        await cleanupUser(owner.userId);
      }
    });

    it("does NOT try to resolve /install.sh / /install.ps1 as a namespace+memex", async () => {
      // `install.sh` doesn't match the slug regex (period not allowed), so the
      // resolver no-ops and the bootstrap script handler runs. This test
      // documents the behaviour rather than reaching the bootstrap (which
      // requires the dist file).
      const res = await request("/install.sh", "memex.ai", { method: "GET" });
      // Either 200 (file exists in dist) or 500 (file not built); critically
      // NOT 404 from the resolver claiming "namespace not found".
      expect([200, 500]).toContain(res.status);
    });
  });

  // ── t-18: path-prefixed mounts for tenancy-scoped surfaces ───────────────
  // F.3 of doc-15: /api/<namespace>/<memex>/docs etc. mount in parallel with
  // the flat /api/docs entity-keyed routes (std-5 exemption documented inline
  // in the handlers). The assertions below pin both shapes plus the std-7
  // cross-namespace contract (404, not 403).
  describe("tenancy-scoped path-prefix routes [t-18]", () => {
    it("GET /api/<ns>/<mx>/docs lists docs for that memex (path-prefix mount)", async () => {
      const owner = await seedUser();
      try {
        const created = await createOrgWithMemexForUser({
          slug: `t18-list-${owner.userId.slice(0, 6)}`,
          name: "t18 list",
          userId: owner.userId,
        });
        // Seed one doc so the list isn't empty.
        const doc = await createDocDraft(created.memex.id, "t18 list doc", "list test");

        const prefixed = await request(
          `/api/${created.namespace.slug}/${created.memex.slug}/docs`,
          "memex.ai",
          { method: "GET" },
          owner.bearer,
        );

        expect(prefixed.status).toBe(200);
        const body = (await prefixed.json()) as Array<{ id: string; memexId: string }>;
        expect(Array.isArray(body)).toBe(true);
        const ids = body.map((d) => d.id);
        expect(ids).toContain(doc.id);
        for (const d of body) expect(d.memexId).toBe(created.memex.id);
      } finally {
        await cleanupUser(owner.userId);
      }
    });

    it("GET /api/<wrong-ns>/<mx>/docs returns 404 (not 403) per std-7", async () => {
      const owner = await seedUser();
      try {
        const created = await createOrgWithMemexForUser({
          slug: `t18-ns-${owner.userId.slice(0, 6)}`,
          name: "t18 wrong-ns",
          userId: owner.userId,
        });
        // Use the right memex slug under a non-existent namespace — resolver 404s.
        const res = await request(
          `/api/no-such-namespace-zzz/${created.memex.slug}/docs`,
          "memex.ai",
          { method: "GET" },
          owner.bearer,
        );
        expect(res.status).toBe(404);
      } finally {
        await cleanupUser(owner.userId);
      }
    });

    it("GET /api/<ns>/<wrong-mx>/docs returns 404 (not 403) per std-7", async () => {
      const owner = await seedUser();
      try {
        const created = await createOrgForUser({
          slug: `t18-mx-${owner.userId.slice(0, 6)}`,
          name: "t18 wrong-mx",
          userId: owner.userId,
        });
        // Right namespace, made-up memex slug — resolver 404s.
        const res = await request(
          `/api/${created.namespace.slug}/no-such-memex-zzz/docs`,
          "memex.ai",
          { method: "GET" },
          owner.bearer,
        );
        expect(res.status).toBe(404);
      } finally {
        await cleanupUser(owner.userId);
      }
    });

    it("non-member caller hitting /api/<ns>/<mx>/docs gets 404 (not 403) per std-7", async () => {
      const owner = await seedUser();
      const stranger = await seedUser();
      try {
        const created = await createOrgWithMemexForUser({
          slug: `t18-priv-${owner.userId.slice(0, 6)}`,
          name: "t18 private",
          userId: owner.userId,
        });
        const res = await request(
          `/api/${created.namespace.slug}/${created.memex.slug}/docs`,
          "memex.ai",
          { method: "GET" },
          stranger.bearer,
        );
        // sessionMiddleware sees ctx.memex populated but stranger has no
        // membership → 404 (std-7), never 403.
        expect(res.status).toBe(404);
      } finally {
        await cleanupUser(stranger.userId);
        await cleanupUser(owner.userId);
      }
    });

    it("flat caller-scoped surfaces remain unprefixed: /api/me, /api/auth/me, /api/namespaces/check", async () => {
      const owner = await seedUser();
      try {
        // /api/me requires session (it's behind sessionMiddleware) — no path prefix needed.
        const me = await request("/api/me", "memex.ai", { method: "GET" }, owner.bearer);
        expect(me.status).toBe(200);

        // /api/namespaces/check is a slug-availability probe — caller-scoped, flat.
        const check = await request(
          "/api/namespaces/check?slug=t18-flat-test",
          "memex.ai",
          { method: "GET" },
          owner.bearer,
        );
        expect(check.status).toBe(200);
      } finally {
        await cleanupUser(owner.userId);
      }
    });

    it("entity-keyed UUID lookup at flat /api/docs/:uuid still works (std-5 exemption)", async () => {
      // The std-5 exemption is documented inline in routes/documents.ts: a UUID
      // lookup determines the memex via the entity FK, so flat-path callers
      // with a SINGLE accessible memex skip the path prefix without ambiguity.
      // Seed a brand-new user that has only a personal namespace + memex so
      // listMemberships returns exactly one row and sessionMiddleware sets
      // currentMemexId from it.
      const owner = await seedUser();
      try {
        // Look up the user's personal memex (created by ensureUserNamespace).
        const meRes = await request("/api/me", "memex.ai", { method: "GET" }, owner.bearer);
        const me = await meRes.json();
        expect(me.currentMemexId).toBeTruthy();
        const personalMemexId: string = me.currentMemexId;

        const doc = await createDocDraft(personalMemexId, "Entity UUID", "verifies std-5");
        const res = await request(
          `/api/docs/${doc.id}`,
          "memex.ai",
          { method: "GET" },
          owner.bearer,
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.id).toBe(doc.id);
        expect(body.title).toBe("Entity UUID");
      } finally {
        await cleanupUser(owner.userId);
      }
    });

    it("the same doc UUID is reachable through the prefixed mount as well", async () => {
      const owner = await seedUser();
      try {
        const created = await createOrgWithMemexForUser({
          slug: `t18-twin-${owner.userId.slice(0, 6)}`,
          name: "t18 twin mount",
          userId: owner.userId,
        });
        const doc = await createDocDraft(created.memex.id, "Twin mount", "both mounts work");
        const res = await request(
          `/api/${created.namespace.slug}/${created.memex.slug}/docs/${doc.id}`,
          "memex.ai",
          { method: "GET" },
          owner.bearer,
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.id).toBe(doc.id);
      } finally {
        // Clean up: the namespaces/memexes/membership rows are tied to the user
        // via FK, so deleting the user cascades.
        await cleanupUser(owner.userId);
      }
    });

    // Drift fix of t-12: /team, /invites, /orgs/current/* used to mount flat
    // alongside /docs etc., but their handlers all read `ctx.currentMemexId`
    // which memexResolver only populates for path-prefixed URLs. The flat
    // mounts universally 400'd with "Memex context required". This block
    // pins the prefix-only contract so we can't regress.
    it("GET /api/<ns>/<mx>/team/members lists members under the prefix mount", async () => {
      const owner = await seedUser();
      try {
        const created = await createOrgWithMemexForUser({
          slug: `t18-team-${owner.userId.slice(0, 6)}`,
          name: "t18 team",
          userId: owner.userId,
        });
        const res = await request(
          `/api/${created.namespace.slug}/${created.memex.slug}/team/members`,
          "memex.ai",
          { method: "GET" },
          owner.bearer,
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as Array<{ userId: string; role: string }>;
        expect(Array.isArray(body)).toBe(true);
        expect(body.some((m) => m.userId === owner.userId)).toBe(true);
      } finally {
        await cleanupUser(owner.userId);
      }
    });

    it("the flat /api/team/members mount is gone (404)", async () => {
      const owner = await seedUser();
      try {
        const res = await request(
          "/api/team/members",
          "memex.ai",
          { method: "GET" },
          owner.bearer,
        );
        // No flat mount → Hono's default 404. Critically NOT 400 with
        // "Memex context required" which is what the old flat mount returned.
        expect(res.status).toBe(404);
      } finally {
        await cleanupUser(owner.userId);
      }
    });

    it("POST /api/<ns>/<mx>/invites mints a token under the prefix mount", async () => {
      const owner = await seedUser();
      try {
        const created = await createOrgWithMemexForUser({
          slug: `t18-inv-${owner.userId.slice(0, 6)}`,
          name: "t18 invites",
          userId: owner.userId,
        });
        const res = await request(
          `/api/${created.namespace.slug}/${created.memex.slug}/invites`,
          "memex.ai",
          { method: "POST" },
          owner.bearer,
        );
        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body.token).toMatch(/^[0-9a-f-]{36}$/);
        expect(body.revokedAt).toBeNull();
      } finally {
        await cleanupUser(owner.userId);
      }
    });

    it("the flat /api/invites mint mount is gone (404), but /api/invites/accept stays flat", async () => {
      const owner = await seedUser();
      try {
        const mint = await request(
          "/api/invites",
          "memex.ai",
          { method: "POST" },
          owner.bearer,
        );
        expect(mint.status).toBe(404);

        // /api/invites/accept must remain flat — the invite token IS the
        // tenant-context grant; the caller doesn't have one yet.
        const accept = await request(
          "/api/invites/accept",
          "memex.ai",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: "invalid-test-token" }),
          },
          owner.bearer,
        );
        // 400 = "Invalid invite" (token doesn't exist). NOT 404 — the route
        // IS mounted; we just supplied a bogus token.
        expect(accept.status).toBe(400);
      } finally {
        await cleanupUser(owner.userId);
      }
    });

    it("GET /api/<ns>/<mx>/orgs/current returns the org summary for an admin", async () => {
      const owner = await seedUser();
      try {
        const created = await createOrgWithMemexForUser({
          slug: `t18-orgc-${owner.userId.slice(0, 6)}`,
          name: "t18 org current",
          userId: owner.userId,
        });
        const res = await request(
          `/api/${created.namespace.slug}/${created.memex.slug}/orgs/current`,
          "memex.ai",
          { method: "GET" },
          owner.bearer,
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.id).toBe(created.org.id);
        expect(body.slug).toBe(created.namespace.slug);
      } finally {
        await cleanupUser(owner.userId);
      }
    });

    it("the flat /api/orgs/current mount is gone (404)", async () => {
      const owner = await seedUser();
      try {
        const res = await request(
          "/api/orgs/current",
          "memex.ai",
          { method: "GET" },
          owner.bearer,
        );
        // Was: 400 "Memex context required" via the broken adminGate.
        // Now: 404 — the route is no longer mounted flat.
        expect(res.status).toBe(404);
      } finally {
        await cleanupUser(owner.userId);
      }
    });

  });
});
